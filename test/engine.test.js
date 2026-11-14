'use strict';

// 実ブラウザ (Chromium) 上でエンジンを動かし、左右チャンネルの周波数と音量を測定する。
// 実行: npm test   (Playwright と Chromium が必要)

const path = require('node:path');
const assert = require('node:assert');
const { chromium } = require('playwright');

const page_url = 'file://' + path.join(__dirname, '..', 'src', 'index.html');

// 各チャンネルの周波数(ゼロ交差から算出)と RMS を返す
async function measure(page) {
  return page.evaluate(async () => {
    const { ctx, nodes } = window.engine;
    if (!window.__tap) {
      const splitter = ctx.createChannelSplitter(2);
      nodes.merger.connect(splitter);
      const mk = (ch) => {
        const a = ctx.createAnalyser();
        a.fftSize = 32768;
        splitter.connect(a, ch);
        return a;
      };
      window.__tap = { ctx, L: mk(0), R: mk(1) };
      await new Promise((r) => setTimeout(r, 900));
    }
    const read = (analyser) => {
      const buf = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(buf);
      const part = buf.subarray(buf.length - 4096); // 直近 約0.09秒
      let first = -1;
      let last = -1;
      let count = 0;
      let sum = 0;
      for (let i = 1; i < part.length; i++) {
        sum += part[i] * part[i];
        if (part[i - 1] < 0 && part[i] >= 0) {
          const pos = i - part[i] / (part[i] - part[i - 1]);
          if (first < 0) first = pos;
          last = pos;
          count++;
        }
      }
      const freq = count > 1 ? ((count - 1) * ctx.sampleRate) / (last - first) : 0;
      return { freq, rms: Math.sqrt(sum / part.length) };
    };
    return { L: read(window.__tap.L), R: read(window.__tap.R) };
  });
}

const near = (actual, expected, tol, label) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} (期待値 ${expected})`);

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(page_url);

  // 1) 既定値: 左 200 Hz / 右 210 Hz
  await page.click('#toggle');
  let m = await measure(page);
  near(m.L.freq, 200, 0.5, '左の周波数');
  near(m.R.freq, 210, 0.5, '右の周波数');
  near(m.L.rms, m.R.rms, 0.005, '左右同音量');

  // 2) 周波数差を変更 → 右だけ変わる
  await page.fill('#diffNum', '4.5');
  await page.dispatchEvent('#diffNum', 'change');
  await page.waitForTimeout(600);
  m = await measure(page);
  near(m.L.freq, 200, 0.5, '左の周波数(差変更後)');
  near(m.R.freq, 204.5, 0.5, '右の周波数(差変更後)');

  // 3) 範囲外の入力は 0.5〜20 Hz に丸められる
  await page.fill('#diffNum', '99');
  await page.dispatchEvent('#diffNum', 'change');
  assert.strictEqual(await page.inputValue('#diffNum'), '20.0');
  await page.fill('#diffNum', '0');
  await page.dispatchEvent('#diffNum', 'change');
  assert.strictEqual(await page.inputValue('#diffNum'), '0.5');
  await page.fill('#diffNum', '10');
  await page.dispatchEvent('#diffNum', 'change');

  // 4) 左右別音量: 左 100% / 右 50% → RMS 比は 4:1 (二乗カーブ)
  await page.fill('#volLNum', '100');
  await page.dispatchEvent('#volLNum', 'change');
  await page.waitForTimeout(600);
  m = await measure(page);
  near(m.L.rms / m.R.rms, 4, 0.2, '左右の音量比');

  // 5) 右を 0% にすると右は無音
  await page.fill('#volRNum', '0');
  await page.dispatchEvent('#volRNum', 'change');
  await page.waitForTimeout(600);
  m = await measure(page);
  assert.ok(m.R.rms < 0.001, `右が無音: ${m.R.rms}`);
  assert.ok(m.L.rms > 0.1, `左は鳴っている: ${m.L.rms}`);

  // 6) 入れ替え: 1 秒間隔で周波数が左右交互に入れ替わり、音量は耳に固定
  await page.fill('#volLNum', '60');
  await page.dispatchEvent('#volLNum', 'change');
  await page.fill('#volRNum', '30');
  await page.dispatchEvent('#volRNum', 'change');
  await page.fill('#swapIntervalNum', '1');
  await page.dispatchEvent('#swapIntervalNum', 'change');
  await page.check('#swapEnabled');
  const seen = [];
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(i === 0 ? 500 : 1000); // 各区間の中央で測定
    m = await measure(page);
    seen.push(Math.round(m.L.freq));
    near(Math.abs(m.L.freq - m.R.freq), 10, 0.6, `入れ替え中の周波数差 #${i}`);
    near(m.L.rms / m.R.rms, 4, 0.3, `入れ替え中も音量は耳に固定 #${i}`);
  }
  assert.deepStrictEqual(seen, [200, 210, 200, 210], `入れ替え順: ${seen}`);

  // 6b) チャンネルに固定: 音量が音と一緒に左右へ移る (比が 4 と 1/4 を交互に)
  await page.check('input[name="volumeMode"][value="channel"]');
  await page.fill('#swapIntervalNum', '1'); // 入れ替えの基準時刻を取り直す
  await page.dispatchEvent('#swapIntervalNum', 'change');
  const ratios = [];
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(i === 0 ? 500 : 1000);
    m = await measure(page);
    // 200 Hz (左ch, 60%) が鳴っている耳のほうが常に大きい
    const loudIsLeft = m.L.rms > m.R.rms;
    near(loudIsLeft ? m.L.freq : m.R.freq, 200, 0.6, `大きい側は左ch の音 #${i}`);
    near(Math.max(m.L.rms, m.R.rms) / Math.min(m.L.rms, m.R.rms), 4, 0.3, `チャンネル固定の音量比 #${i}`);
    ratios.push(loudIsLeft ? 'L' : 'R');
  }
  assert.ok(
    ratios.join('') === 'LRLR' || ratios.join('') === 'RLRL',
    `チャンネル固定では大きい側が交互に入れ替わる: ${ratios}`
  );
  await page.check('input[name="volumeMode"][value="ear"]');

  // 7) 最短 0.1 秒間隔: 2 秒間に約 20 回入れ替わる
  await page.evaluate(() => {
    window.__swaps = 0;
    const orig = window.engine.onSwap;
    window.engine.onSwap = (s) => { window.__swaps++; orig(s); };
  });
  await page.fill('#swapIntervalNum', '0.1');
  await page.dispatchEvent('#swapIntervalNum', 'change');
  await page.waitForTimeout(2000);
  const swaps = await page.evaluate(() => window.__swaps);
  assert.ok(swaps >= 18 && swaps <= 22, `0.1 秒間隔の入れ替え回数: ${swaps}`);

  // 7b) 入れ替えノイズが無いこと: 耳に固定・0.1 秒間隔で、各耳の波形の山の高さ (振幅) が
  //     入れ替えの瞬間も一定であることを確認する (約 0.68 秒 × 3 回 = 入れ替え約 20 回分)
  await measure(page); // 測定用の分岐を用意
  for (let round = 0; round < 3; round++) {
    await page.waitForTimeout(750);
    const env = await page.evaluate(() =>
      [window.__tap.L, window.__tap.R].map((analyser) => {
        const x = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(x);
        let min = Infinity;
        let max = 0;
        for (let i = 1; i < x.length - 1; i++) {
          const a = Math.abs(x[i]);
          if (a > Math.abs(x[i - 1]) && a >= Math.abs(x[i + 1])) {
            min = Math.min(min, a);
            max = Math.max(max, a);
          }
        }
        return { min, max };
      })
    );
    for (const [i, name] of ['左耳', '右耳'].entries()) {
      assert.ok(env[i].max > 0.01, `${name}が鳴っていない`);
      assert.ok(
        env[i].min / env[i].max > 0.98,
        `${name}の振幅が入れ替え時に揺れている (最小/最大 = ${(env[i].min / env[i].max).toFixed(3)})`
      );
    }
  }

  // 8) 入れ替えを切ると通常の左右に戻る
  await page.uncheck('#swapEnabled');
  await page.waitForTimeout(600);
  m = await measure(page);
  near(m.L.freq, 200, 0.5, '入れ替え解除後の左');
  near(m.R.freq, 210, 0.5, '入れ替え解除後の右');

  // 9) 停止、設定は再読み込み後も保持
  await page.click('#toggle');
  await page.waitForFunction(() => document.getElementById('toggle').textContent === '再生');
  await page.reload();
  assert.strictEqual(await page.inputValue('#volLNum'), '60');
  assert.strictEqual(await page.inputValue('#swapIntervalNum'), '0.1');
  assert.ok(await page.isChecked('input[name="volumeMode"][value="ear"]'));

  assert.deepStrictEqual(errors, [], `ページエラー: ${errors}`);
  await browser.close();
  console.log('OK: すべてのテストに合格');
})().catch((e) => {
  console.error('NG:', e.message);
  process.exit(1);
});
