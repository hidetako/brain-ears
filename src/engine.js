'use strict';

/**
 * バイノーラルビート音声エンジン (Web Audio API)
 *
 *   oscA (基準周波数)        ─┬─ gAL ─┐
 *                            └─ gAR ─┼─┐
 *   oscB (基準 + 周波数差)   ─┬─ gBL ─┘ │      volL ─┐
 *                            └─ gBR ───┘      volR ─┴─ merger ─ master ─ 出力
 *
 * 通常時は A→左耳 / B→右耳。入れ替え時は A→右耳 / B→左耳。
 * 音量 (volL / volR) は「耳」に固定で、入れ替わるのは音(周波数)だけ。
 */
(function (root) {
  const LIMITS = {
    base: { min: 40, max: 1000 },
    diff: { min: 0.5, max: 20 },
    swap: { min: 0.1, max: 5 },
    volume: { min: 0, max: 100 },
  };

  const SWAP_FADE = 0.008; // 入れ替え時のクロスフェード秒数 (クリックノイズ防止)
  const PARAM_FADE = 0.03; // 音量・周波数変更のなめらかさ
  const START_FADE = 0.05;
  const LOOKAHEAD = 0.2; // 何秒先まで入れ替えを予約するか
  const TICK_MS = 25;
  const HEADROOM = 0.5; // 最大音量時の出力ゲイン

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
      if (patch.swapInterval !== undefined) {
        p.swapInterval = clamp(patch.swapInterval, LIMITS.swap);
      }
      if (patch.swapEnabled !== undefined) p.swapEnabled = Boolean(patch.swapEnabled);

      if (!this.playing) return;
      const t = this.ctx.currentTime;
      const n = this.nodes;
      n.oscA.frequency.setTargetAtTime(p.base, t, PARAM_FADE);
      n.oscB.frequency.setTargetAtTime(p.base + p.diff, t, PARAM_FADE);
      n.volL.gain.setTargetAtTime(volumeToGain(p.volL), t, PARAM_FADE);
      n.volR.gain.setTargetAtTime(volumeToGain(p.volR), t, PARAM_FADE);

      if (patch.swapEnabled !== undefined || patch.swapInterval !== undefined) {
        this._rescheduleSwaps();
      }
    }

    async start() {
      if (this.playing) return;
      const Ctx = root.AudioContext || root.webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      const ctx = this.ctx;
      const p = this.params;

      const oscA = ctx.createOscillator();
      const oscB = ctx.createOscillator();
      oscA.type = 'sine';
      oscB.type = 'sine';
      oscA.frequency.value = p.base;
      oscB.frequency.value = p.base + p.diff;

      const mk = (value) => {
        const g = ctx.createGain();
        g.gain.value = value;
        return g;
      };
      const gAL = mk(1);
      const gAR = mk(0);
      const gBL = mk(0);
      const gBR = mk(1);
      const volL = mk(volumeToGain(p.volL));
      const volR = mk(volumeToGain(p.volR));
      const master = mk(0);
      const merger = ctx.createChannelMerger(2);

      oscA.connect(gAL).connect(volL);
      oscA.connect(gAR).connect(volR);
      oscB.connect(gBL).connect(volL);
      oscB.connect(gBR).connect(volR);
      volL.connect(merger, 0, 0);
      volR.connect(merger, 0, 1);
      merger.connect(master).connect(ctx.destination);

      this.nodes = { oscA, oscB, gAL, gAR, gBL, gBR, volL, volR, master, merger };
      this.swapped = false;

      await ctx.resume();
      const t = ctx.currentTime;
      oscA.start(t);
      oscB.start(t);
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
      const { master, oscA, oscB } = this.nodes;
      const t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(master.gain.value, t);
      master.gain.linearRampToValueAtTime(0, t + START_FADE);
      oscA.stop(t + START_FADE + 0.01);
      oscB.stop(t + START_FADE + 0.01);
      this.nodes = null;
      this.ctx = null;
      this.swapped = false;
      if (this.onSwap) this.onSwap(false);
      setTimeout(() => ctx.close(), (START_FADE + 0.05) * 1000);
    }

    // 予約済みの入れ替えを取り消し、現在の設定で予約し直す
    _rescheduleSwaps() {
      const t = this.ctx.currentTime;
      const { gAL, gAR, gBL, gBR } = this.nodes;
      for (const g of [gAL, gAR, gBL, gBR]) g.gain.cancelScheduledValues(t);

      if (this.params.swapEnabled) {
        this._applyRouting(this.swapped, t);
        this.nextSwapTime = t + this.params.swapInterval;
      } else {
        // 入れ替えを切ったら通常の左右へ戻す
        this._applyRouting(false, t);
        this._setSwapped(false);
        this.nextSwapTime = Infinity;
      }
    }

    _tick() {
      if (!this.playing || !this.params.swapEnabled) return;
      const horizon = this.ctx.currentTime + LOOKAHEAD;
      while (this.nextSwapTime < horizon) {
        const next = !this.swapped;
        this._applyRouting(next, this.nextSwapTime);
        this._setSwapped(next, this.nextSwapTime);
        this.nextSwapTime += this.params.swapInterval;
      }
    }

    _applyRouting(swapped, time) {
      const { gAL, gAR, gBL, gBR } = this.nodes;
      const direct = swapped ? 0 : 1;
      const cross = swapped ? 1 : 0;
      const end = time + SWAP_FADE;
      for (const [g, target] of [
        [gAL, direct],
        [gBR, direct],
        [gAR, cross],
        [gBL, cross],
      ]) {
        g.gain.setValueAtTime(1 - target, time);
        g.gain.linearRampToValueAtTime(target, end);
      }
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
