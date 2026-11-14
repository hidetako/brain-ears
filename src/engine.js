'use strict';

/**
 * バイノーラル音声エンジン (Web Audio API)
 *
 * 音源 (source) は 2 種類:
 *   'tone' … 純音。左ch = 基準音、右ch = 基準音 + 周波数差。
 *   'file' … 音声ファイル。左ch 用と右ch 用を別々に登録する (モノラルに混ぜて各耳へ)。
 *
 * 各耳には 0〜1 の係数 s がある (0 = 左ch の音, 1 = 右ch の音)。
 *   通常時:   左耳 s=0 / 右耳 s=1      入れ替え時: 左耳 s=1 / 右耳 s=0
 * 左右の入れ替えは s を滑らかに動かすことで行う。
 *
 *   各耳の音 = (1 - s) × volA × [左ch の音] + s × volB × [右ch の音]
 *
 *   純音では耳ごとに発振器を 1 つ持ち、周波数 = 基準音 + 周波数差 × s とする。
 *   波形がつながったまま周波数だけが移るので、入れ替え時に振幅が落ち込まない。
 *   音声ファイルでは 2 つのファイルを s でクロスフェードする。
 *
 * 音量の効かせ方 (volumeMode):
 *   'ear'     … 耳に固定。volA = volB = その耳の音量。入れ替えても音量は変わらない。
 *   'channel' … チャンネルに固定。volA = 左ch の音量, volB = 右ch の音量。
 *               入れ替えると音量も音と一緒に移る。
 */
(function (root) {
  const LIMITS = {
    base: { min: 40, max: 400 },
    diff: { min: 0.5, max: 20 },
    swap: { min: 0.1, max: 5 },
    volume: { min: 0, max: 100 },
  };

  // 入れ替えにかける最大秒数と、入れ替え間隔に対する上限の割合
  const GLIDE = {
    tone: { max: 0.03, ratio: 0.3 },
    file: { max: 0.05, ratio: 0.4 },
  };
  const RESCHEDULE_GLIDE = 0.03;
  const PARAM_FADE = 0.03; // 音量・周波数変更のなめらかさ
  const START_FADE = 0.05;
  const LOOKAHEAD = 0.2; // 何秒先まで入れ替えを予約するか
  const TICK_MS = 25;
  // 最大音量時の出力ゲイン (純音は耳への負担を考えて控えめ)
  const HEADROOM = { tone: 0.5, file: 1 };
  const SIDES = ['L', 'R'];

  // 0→1 / 1→0 を角のない S 字 (レイズドコサイン) でつなぐ曲線
  const CURVE_POINTS = 64;
  const CURVE_UP = new Float32Array(CURVE_POINTS);
  const CURVE_DOWN = new Float32Array(CURVE_POINTS);
  for (let i = 0; i < CURVE_POINTS; i++) {
    const v = (1 - Math.cos((Math.PI * i) / (CURVE_POINTS - 1))) / 2;
    CURVE_UP[i] = v;
    CURVE_DOWN[i] = 1 - v;
  }

  const wait = (seconds) => new Promise((r) => setTimeout(r, seconds * 1000));

  function clamp(value, { min, max }) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  class BinauralEngine {
    constructor() {
      this.ctx = null;
      this.nodes = null; // 起動後ずっと使い回す部分 (耳ごとの係数・音量など)
      this.tone = null; // 純音の再生中だけ存在する発振器
      this.files = { L: null, R: null }; // 登録された音声ファイル
      this.timer = null;
      this.playing = false;
      this.swapped = false;
      this.nextSwapTime = 0;
      this.onSwap = null;
      this.onFileError = null;
      this.params = {
        source: 'tone',
        base: 200,
        diff: 10,
        volL: 50,
        volR: 50,
        volBoth: 100, // 左右共通の音量 (左右の比は保ったまま全体を上げ下げする)
        volumeMode: 'ear',
        swapEnabled: false,
        swapInterval: 1,
      };
    }

    // 音源の切り替えは setSource() を使う (再生中は止めてから切り替えるため)
    setParams(patch) {
      const p = this.params;
      if (patch.source !== undefined && !this.playing) {
        p.source = patch.source === 'file' ? 'file' : 'tone';
      }
      if (patch.base !== undefined) p.base = clamp(patch.base, LIMITS.base);
      if (patch.diff !== undefined) p.diff = clamp(patch.diff, LIMITS.diff);
      if (patch.volL !== undefined) p.volL = clamp(patch.volL, LIMITS.volume);
      if (patch.volR !== undefined) p.volR = clamp(patch.volR, LIMITS.volume);
      if (patch.volBoth !== undefined) p.volBoth = clamp(patch.volBoth, LIMITS.volume);
      if (patch.volumeMode !== undefined) {
        p.volumeMode = patch.volumeMode === 'channel' ? 'channel' : 'ear';
      }
      if (patch.swapInterval !== undefined) {
        p.swapInterval = clamp(patch.swapInterval, LIMITS.swap);
      }
      if (patch.swapEnabled !== undefined) p.swapEnabled = Boolean(patch.swapEnabled);

      if (!this.playing) return;
      const t = this.ctx.currentTime;
      const v = this._volumeGains();
      for (const side of SIDES) {
        const ear = this.nodes[side];
        ear.volA.gain.setTargetAtTime(v[side].a, t, PARAM_FADE);
        ear.volB.gain.setTargetAtTime(v[side].b, t, PARAM_FADE);
        if (this.tone) {
          this.tone[side].osc.frequency.setTargetAtTime(p.base, t, PARAM_FADE);
          this.tone[side].diff.gain.setTargetAtTime(p.diff, t, PARAM_FADE);
        }
      }

      if (patch.swapEnabled !== undefined || patch.swapInterval !== undefined) {
        this._rescheduleSwaps();
      }
    }

    async setSource(source) {
      const next = source === 'file' ? 'file' : 'tone';
      if (next === this.params.source) return;
      const wasPlaying = this.playing;
      if (wasPlaying) await this.stop();
      this.params.source = next;
      if (wasPlaying) await this.start();
    }

    // side ('L' | 'R') のチャンネルに音声ファイル (Blob / File) を登録する
    setFile(side, blob, name) {
      this.clearFile(side);
      this._ensureGraph();
      const url = URL.createObjectURL(blob);
      const el = new Audio();
      el.loop = true;
      el.preload = 'auto';
      el.src = url;
      const node = this.ctx.createMediaElementSource(el);
      const mono = this.ctx.createGain(); // ステレオのファイルもモノラルに混ぜる
      mono.channelCount = 1;
      mono.channelCountMode = 'explicit';
      mono.channelInterpretation = 'speakers';
      node.connect(mono);
      const file = { name, url, el, node, mono };
      el.addEventListener('error', () => {
        if (this.files[side] !== file) return;
        this.clearFile(side);
        if (this.onFileError) this.onFileError(side, name);
      });
      this.files[side] = file;
      if (this.playing && this.params.source === 'file') {
        this._connectFile(side);
        el.play().catch(() => {});
      }
    }

    clearFile(side) {
      const file = this.files[side];
      if (!file) return;
      this.files[side] = null;
      file.el.pause();
      file.mono.disconnect();
      file.node.disconnect();
      file.el.removeAttribute('src');
      file.el.load();
      URL.revokeObjectURL(file.url);
    }

    hasFiles() {
      return Boolean(this.files.L || this.files.R);
    }

    // 登録済みファイルを先頭に戻す
    rewind() {
      for (const side of SIDES) {
        if (this.files[side]) this.files[side].el.currentTime = 0;
      }
    }

    // 各耳の「左ch の音を鳴らすときの音量 a」「右ch の音を鳴らすときの音量 b」
    _volumeGains() {
      const headroom = HEADROOM[this.params.source];
      // 0-100% を聴感に近いカーブでゲインへ変換
      const curve = (percent) => {
        const v = clamp(percent, LIMITS.volume) / 100;
        return v * v;
      };
      const both = curve(this.params.volBoth);
      const gain = (percent) => curve(percent) * both * headroom;
      const l = gain(this.params.volL);
      const r = gain(this.params.volR);
      return this.params.volumeMode === 'channel'
        ? { L: { a: l, b: r }, R: { a: l, b: r } }
        : { L: { a: l, b: l }, R: { a: r, b: r } };
    }

    _glide() {
      const g = GLIDE[this.params.source];
      return Math.min(g.max, this.params.swapInterval * g.ratio);
    }

    // 起動後ずっと使い回すグラフを一度だけ作る
    _ensureGraph() {
      if (this.ctx) return;
      const Ctx = root.AudioContext || root.webkitAudioContext;
      const ctx = new Ctx({ latencyHint: 'interactive' });
      const mk = (value) => {
        const g = ctx.createGain();
        g.gain.value = value;
        return g;
      };

      const one = ctx.createConstantSource(); // 係数 s の元になる定数 1
      one.offset.value = 1;
      one.start();
      const merger = ctx.createChannelMerger(2);
      const master = mk(0);
      merger.connect(master).connect(ctx.destination);

      const makeEar = (initialS, channel) => {
        const s = mk(initialS); // この gain を自動化して入れ替える
        one.connect(s);
        // mixA = 1 - s, mixB = s
        const mixA = mk(1);
        const mixB = mk(0);
        const negate = mk(-1);
        s.connect(negate).connect(mixA.gain);
        s.connect(mixB.gain);
        const volA = mk(0);
        const volB = mk(0);
        mixA.connect(volA).connect(merger, 0, channel);
        mixB.connect(volB).connect(merger, 0, channel);
        return { s, mixA, mixB, volA, volB, restS: initialS };
      };

      this.ctx = ctx;
      this.nodes = { L: makeEar(0, 0), R: makeEar(1, 1), one, master, merger };
    }

    // 左ch のファイルは各耳の mixA へ、右ch のファイルは mixB へ
    _connectFile(side) {
      const file = this.files[side];
      const key = side === 'L' ? 'mixA' : 'mixB';
      file.mono.disconnect();
      file.mono.connect(this.nodes.L[key]);
      file.mono.connect(this.nodes.R[key]);
    }

    _startTone(t) {
      const p = this.params;
      this.tone = {};
      for (const side of SIDES) {
        const ear = this.nodes[side];
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = p.base;
        // 周波数 = 基準音 + 周波数差 × s
        const diff = this.ctx.createGain();
        diff.gain.value = p.diff;
        ear.s.connect(diff).connect(osc.frequency);
        osc.connect(ear.mixA);
        osc.connect(ear.mixB);
        osc.start(t);
        this.tone[side] = { osc, diff };
      }
    }

    _stopTone() {
      if (!this.tone) return;
      for (const side of SIDES) {
        const { osc, diff } = this.tone[side];
        osc.stop();
        osc.disconnect();
        this.nodes[side].s.disconnect(diff);
        diff.disconnect();
      }
      this.tone = null;
    }

    async start() {
      if (this.playing) return;
      this._ensureGraph();
      const ctx = this.ctx;
      await ctx.resume();
      const t = ctx.currentTime;

      const v = this._volumeGains();
      for (const side of SIDES) {
        const ear = this.nodes[side];
        for (const [param, value] of [[ear.volA.gain, v[side].a], [ear.volB.gain, v[side].b]]) {
          param.cancelScheduledValues(t);
          param.setValueAtTime(value, t);
        }
      }

      if (this.params.source === 'file') {
        for (const side of SIDES) {
          if (!this.files[side]) continue;
          this._connectFile(side);
          this.files[side].el.play().catch(() => {});
        }
      } else {
        this._startTone(t);
      }

      const { master } = this.nodes;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(0, t);
      master.gain.linearRampToValueAtTime(1, t + START_FADE);

      this.swapped = false;
      this.playing = true;
      this._rescheduleSwaps();
      this.timer = setInterval(() => this._tick(), TICK_MS);
    }

    // 音声ファイルは一時停止になり、次の再生で続きから鳴る
    async stop() {
      if (!this.playing) return;
      this.playing = false;
      clearInterval(this.timer);
      this.timer = null;
      const ctx = this.ctx;
      const { master } = this.nodes;
      const t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(master.gain.value, t);
      master.gain.linearRampToValueAtTime(0, t + START_FADE);
      await wait(START_FADE + 0.03);

      this._stopTone();
      for (const side of SIDES) {
        const file = this.files[side];
        if (file) {
          file.el.pause();
          file.mono.disconnect();
        }
        // 入れ替えの予約を消して通常の左右へ戻す
        const ear = this.nodes[side];
        ear.s.gain.cancelScheduledValues(0);
        ear.s.gain.setValueAtTime(ear.restS, ctx.currentTime);
      }
      this.swapped = false;
      if (this.onSwap) this.onSwap(false);
      await ctx.suspend();
    }

    // 予約済みの入れ替えを取り消し、現在の設定で予約し直す
    _rescheduleSwaps() {
      const t = this.ctx.currentTime;
      if (!this.params.swapEnabled) this._setSwapped(false); // 切ったら通常の左右へ戻す

      // 途中の値を保ったまま、あるべき状態へ滑らかに寄せる
      for (const side of SIDES) {
        const ear = this.nodes[side];
        const target = this.swapped ? 1 - ear.restS : ear.restS;
        const param = ear.s.gain;
        if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
        else param.cancelScheduledValues(t);
        param.linearRampToValueAtTime(target, t + RESCHEDULE_GLIDE);
      }

      // 次の入れ替えは上の寄せが終わってから
      this.nextSwapTime = this.params.swapEnabled
        ? t + Math.max(this.params.swapInterval, RESCHEDULE_GLIDE + 0.01)
        : Infinity;
    }

    _tick() {
      if (!this.playing || !this.params.swapEnabled) return;
      const horizon = this.ctx.currentTime + LOOKAHEAD;
      while (this.nextSwapTime < horizon) {
        const next = !this.swapped;
        this._scheduleSwap(next, this.nextSwapTime);
        this._setSwapped(next, this.nextSwapTime);
        this.nextSwapTime += this.params.swapInterval;
      }
    }

    _scheduleSwap(swapped, time) {
      const glide = this._glide();
      for (const side of SIDES) {
        const ear = this.nodes[side];
        const target = swapped ? 1 - ear.restS : ear.restS;
        ear.s.gain.setValueCurveAtTime(target === 1 ? CURVE_UP : CURVE_DOWN, time, glide);
      }
    }

    _setSwapped(swapped, time) {
      this.swapped = swapped;
      if (!this.onSwap) return;
      const delay = time ? Math.max(0, (time - this.ctx.currentTime) * 1000) : 0;
      setTimeout(() => {
        if (this.playing) this.onSwap(swapped);
      }, delay);
    }
  }

  root.BinauralEngine = BinauralEngine;
  root.BINAURAL_LIMITS = LIMITS;
})(typeof window !== 'undefined' ? window : globalThis);
