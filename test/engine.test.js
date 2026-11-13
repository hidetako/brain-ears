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

  // 8) 入れ替えを切ると通常の左右に戻る
  await page.uncheck('#swapEnabled');
  await page.waitForTimeout(600);
  m = await measure(page);
  near(m.L.freq, 200, 0.5, '入れ替え解除後の左');
  near(m.R.freq, 210, 0.5, '入れ替え解除後の右');

  // 9) 停止、設定は再読み込み後も保持
  await page.click('#toggle');
  assert.strictEqual(await page.textContent('#toggle'), '再生');
  await page.reload();
  assert.strictEqual(await page.inputValue('#volLNum'), '60');
  assert.strictEqual(await page.inputValue('#swapIntervalNum'), '0.1');

  assert.deepStrictEqual(errors, [], `ページエラー: ${errors}`);
  await browser.close();
  console.log('OK: すべてのテストに合格');
})().catch((e) => {
  console.error('NG:', e.message);
  process.exit(1);
});
