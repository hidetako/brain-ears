'use strict';

/**
 * バイノーラルビート音声エンジン (Web Audio API)
 *
 * 耳ごとに発振器を 1 つ持ち、左右の入れ替えは「音の混ぜ替え」ではなく
 * 「各耳の発振器の周波数を滑らかに移す」ことで行う。波形がつながったまま
 * 周波数だけが変わるので、入れ替えの瞬間に振幅の落ち込み (ノイズ) が出ない。
 *
 * 各耳には 0〜1 の係数 s がある (0 = 左ch の音, 1 = 右ch の音)。
 *   通常時:   左耳 s=0 / 右耳 s=1      入れ替え時: 左耳 s=1 / 右耳 s=0
 *
 *   周波数 = 基準音 + 周波数差 × s
 *   音量   = (1 - s) × volA + s × volB
 *
 * 音量の効かせ方 (volumeMode):
 *   'ear'     … 耳に固定。volA = volB = その耳の音量。入れ替えても音量は変わらない。
 *   'channel' … チャンネルに固定。volA = 左ch の音量, volB = 右ch の音量。
 *               入れ替えると音量も音と一緒に滑らかに移る。
 */
(function (root) {
  const LIMITS = {
    base: { min: 40, max: 1000 },
    diff: { min: 0.5, max: 20 },
    swap: { min: 0.1, max: 5 },
    volume: { min: 0, max: 100 },
  };

  const SWAP_GLIDE_MAX = 0.03; // 入れ替えにかける最大秒数
  const SWAP_GLIDE_RATIO = 0.3; // 入れ替え間隔に対する上限の割合
  const PARAM_FADE = 0.03; // 音量・周波数変更のなめらかさ
  const START_FADE = 0.05;
  const LOOKAHEAD = 0.2; // 何秒先まで入れ替えを予約するか
  const TICK_MS = 25;
  const HEADROOM = 0.5; // 最大音量時の出力ゲイン

  // 0→1 / 1→0 を角のない S 字 (レイズドコサイン) でつなぐ曲線
  const CURVE_POINTS = 64;
  const CURVE_UP = new Float32Array(CURVE_POINTS);
  const CURVE_DOWN = new Float32Array(CURVE_POINTS);
  for (let i = 0; i < CURVE_POINTS; i++) {
    const v = (1 - Math.cos((Math.PI * i) / (CURVE_POINTS - 1))) / 2;
    CURVE_UP[i] = v;
    CURVE_DOWN[i] = 1 - v;
  }

  function clamp(value, { min, max }) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  // 0-100% を聴感に近いカーブでゲインへ変換
  function volumeToGain(percent) {
    const v = clamp(percent, LIMITS.volume) / 100;
    return v * v * HEADROOM;
  }

  class BinauralEngine {
    constructor() {
      this.ctx = null;
      this.nodes = null;
      this.timer = null;
      this.playing = false;
      this.swapped = false;
      this.nextSwapTime = 0;
      this.onSwap = null;
      this.params = {
        base: 200,
        diff: 10,
        volL: 50,
        volR: 50,
        volumeMode: 'ear',
        swapEnabled: false,
        swapInterval: 1,
      };
    }

    setParams(patch) {
      const p = this.params;
      if (patch.base !== undefined) p.base = clamp(patch.base, LIMITS.base);
      if (patch.diff !== undefined) p.diff = clamp(patch.diff, LIMITS.diff);
      if (patch.volL !== undefined) p.volL = clamp(patch.volL, LIMITS.volume);
      if (patch.volR !== undefined) p.volR = clamp(patch.volR, LIMITS.volume);
      if (patch.volumeMode !== undefined) {
        p.volumeMode = patch.volumeMode === 'channel' ? 'channel' : 'ear';
      }
      if (patch.swapInterval !== undefined) {
        p.swapInterval = clamp(patch.swapInterval, LIMITS.swap);
      }
      if (patch.swapEnabled !== undefined) p.swapEnabled = Boolean(patch.swapEnabled);

      if (!this.playing) return;
      const t = this.ctx.currentTime;
      const { L, R } = this.nodes;
      const v = this._volumeGains();
      for (const [ear, vol] of [[L, v.L], [R, v.R]]) {
        ear.osc.frequency.setTargetAtTime(p.base, t, PARAM_FADE);
        ear.diff.gain.setTargetAtTime(p.diff, t, PARAM_FADE);
        ear.volA.gain.setTargetAtTime(vol.a, t, PARAM_FADE);
        ear.volB.gain.setTargetAtTime(vol.b, t, PARAM_FADE);
      }

      if (patch.swapEnabled !== undefined || patch.swapInterval !== undefined) {
        this._rescheduleSwaps();
      }
    }

    // 各耳の「左ch の音を鳴らすときの音量 a」「右ch の音を鳴らすときの音量 b」
    _volumeGains() {
      const l = volumeToGain(this.params.volL);
      const r = volumeToGain(this.params.volR);
      return this.params.volumeMode === 'channel'
        ? { L: { a: l, b: r }, R: { a: l, b: r } }
        : { L: { a: l, b: l }, R: { a: r, b: r } };
    }

    _glide() {
      return Math.min(SWAP_GLIDE_MAX, this.params.swapInterval * SWAP_GLIDE_RATIO);
    }

    async start() {
      if (this.playing) return;
      const Ctx = root.AudioContext || root.webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      const ctx = this.ctx;
      const p = this.params;

      const mk = (value) => {
        const g = ctx.createGain();
        g.gain.value = value;
        return g;
      };

      const one = ctx.createConstantSource(); // 係数 s の元になる定数 1
      one.offset.value = 1;
      const merger = ctx.createChannelMerger(2);
      const master = mk(0);
      const vols = this._volumeGains();

      const makeEar = (initialS, vol, channel) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = p.base;

        const s = mk(initialS); // この gain を自動化して入れ替える
        one.connect(s);

        // 周波数 = 基準音 + 周波数差 × s
        const diff = mk(p.diff);
        s.connect(diff).connect(osc.frequency);

        // 音量 = (1 - s) × volA + s × volB
        const mixA = mk(1);
        const mixB = mk(0);
        const negate = mk(-1);
        s.connect(negate).connect(mixA.gain);
        s.connect(mixB.gain);
        const volA = mk(vol.a);
        const volB = mk(vol.b);
        osc.connect(mixA).connect(volA).connect(merger, 0, channel);
        osc.connect(mixB).connect(volB).connect(merger, 0, channel);

        return { osc, s, diff, volA, volB };
      };

      const L = makeEar(0, vols.L, 0);
      const R = makeEar(1, vols.R, 1);
      merger.connect(master).connect(ctx.destination);

      this.nodes = { L, R, one, master, merger };
      this.swapped = false;

      await ctx.resume();
      const t = ctx.currentTime;
      one.start(t);
      L.osc.start(t);
      R.osc.start(t);
      master.gain.setValueAtTime(0, t);
      master.gain.linearRampToValueAtTime(1, t + START_FADE);

      this.playing = true;
      this._rescheduleSwaps();
      this.timer = setInterval(() => this._tick(), TICK_MS);
    }

    async stop() {
      if (!this.playing) return;
      this.playing = false;
      clearInterval(this.timer);
      this.timer = null;
      const ctx = this.ctx;
      const { master, one, L, R } = this.nodes;
      const t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(master.gain.value, t);
      master.gain.linearRampToValueAtTime(0, t + START_FADE);
      for (const node of [one, L.osc, R.osc]) node.stop(t + START_FADE + 0.01);
      this.nodes = null;
      this.ctx = null;
      this.swapped = false;
      if (this.onSwap) this.onSwap(false);
      setTimeout(() => ctx.close(), (START_FADE + 0.05) * 1000);
    }

    // 予約済みの入れ替えを取り消し、現在の設定で予約し直す
    _rescheduleSwaps() {
      const t = this.ctx.currentTime;
      if (!this.params.swapEnabled) this._setSwapped(false); // 切ったら通常の左右へ戻す

      // 途中の値を保ったまま、あるべき状態へ滑らかに寄せる
      const { L, R } = this.nodes;
      const targetL = this.swapped ? 1 : 0;
      for (const [ear, target] of [[L, targetL], [R, 1 - targetL]]) {
        const param = ear.s.gain;
        if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
        else param.cancelScheduledValues(t);
        param.linearRampToValueAtTime(target, t + SWAP_GLIDE_MAX);
      }

      // 次の入れ替えは上の寄せが終わってから
      this.nextSwapTime = this.params.swapEnabled
        ? t + Math.max(this.params.swapInterval, SWAP_GLIDE_MAX + 0.01)
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
      const { L, R } = this.nodes;
      const glide = this._glide();
      L.s.gain.setValueCurveAtTime(swapped ? CURVE_UP : CURVE_DOWN, time, glide);
      R.s.gain.setValueCurveAtTime(swapped ? CURVE_DOWN : CURVE_UP, time, glide);
    }

    _setSwapped(swapped, time) {
      this.swapped = swapped;
      if (!this.onSwap) return;
      const delay = time ? Math.max(0, (time - this.ctx.currentTime) * 1000) : 0;
      const ctx = this.ctx;
      setTimeout(() => {
        if (this.playing && this.ctx === ctx) this.onSwap(swapped);
      }, delay);
    }
  }

  root.BinauralEngine = BinauralEngine;
  root.BINAURAL_LIMITS = LIMITS;
})(typeof window !== 'undefined' ? window : globalThis);
