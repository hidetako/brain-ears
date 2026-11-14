'use strict';

// 音声ファイル音源のテスト。300 Hz (左ch 用) と 500 Hz (右ch 用・ステレオ) の WAV を作って登録し、
// 各耳に届く音の周波数と音量を Chromium 上で測定する。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { chromium } = require('playwright');

const page_url = 'file://' + path.join(__dirname, '..', 'src', 'index.html');

function writeWav(file, freq, channels) {
  const rate = 48000;
  const frames = rate * 3;
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.5 * 32767);
    for (let c = 0; c < channels; c++) data.writeInt16LE(v, (i * channels + c) * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * channels * 2, 28);
  head.writeUInt16LE(channels * 2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([head, data]));
}

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
      window.__tap = { L: mk(0), R: mk(1) };
      await new Promise((r) => setTimeout(r, 900));
    }
    const read = (analyser) => {
      const buf = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(buf);
      const part = buf.subarray(buf.length - 4096);
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

const setNum = async (page, id, value) => {
  await page.fill(id, String(value));
  await page.dispatchEvent(id, 'change');
};

const waitToggle = (page, text) =>
  page.waitForFunction((t) => document.getElementById('toggle').textContent === t, text);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binaural-test-'));
  const left = path.join(dir, 'left-300.wav');
  const right = path.join(dir, 'right-500.wav');
  const broken = path.join(dir, 'broken.mp3');
  writeWav(left, 300, 1);
  writeWav(right, 500, 2);
  fs.writeFileSync(broken, 'これは音声ではありません');

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(page_url);

  // 1) 音声ファイルに切り替え。未登録のままでは再生を始めない
  await page.check('input[name="source"][value="file"]');
  assert.ok(await page.isVisible('#filePanel'));
  assert.ok(!(await page.isVisible('#freqPanel')), '周波数パネルは隠れる');
  await page.click('#toggle');
  assert.strictEqual(await page.textContent('#toggle'), '再生');
  assert.strictEqual(await page.textContent('#fileHint'), '音声ファイルを登録してください');

  // 2) 左右に別々のファイルを登録
  await page.setInputFiles('#fileInputL', left);
  await page.setInputFiles('#fileInputR', right);
  assert.strictEqual(await page.textContent('#fileNameL'), 'left-300.wav');
  assert.strictEqual(await page.textContent('#fileNameR'), 'right-500.wav');

  // 3) 再生: 左耳に左ch のファイル、右耳に右ch のファイル。100% で元の音量のまま
  await setNum(page, '#volLNum', 100);
  await setNum(page, '#volRNum', 100);
  await page.click('#toggle');
  await waitToggle(page, '停止');
  await page.waitForTimeout(500);
  let m = await measure(page);
  near(m.L.freq, 300, 1, '左耳の周波数');
  near(m.R.freq, 500, 1, '右耳の周波数');
  near(m.L.rms, 0.5 / Math.SQRT2, 0.02, '左耳の音量 (100%)');
  near(m.R.rms, 0.5 / Math.SQRT2, 0.02, '右耳の音量 (ステレオをモノラル化, 100%)');
  assert.strictEqual(await page.textContent('#freqL'), 'left-300.wav');

  // 4) 左右別音量: 左 100% / 右 50% → 4:1
  await setNum(page, '#volRNum', 50);
  await page.waitForTimeout(600);
  m = await measure(page);
  near(m.L.rms / m.R.rms, 4, 0.2, '左右の音量比');

  // 5) 入れ替え (耳に固定): ファイルが左右交互に入れ替わり、音量は耳に固定
  await setNum(page, '#swapIntervalNum', 1);
  await page.check('#swapEnabled');
  let seen = [];
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(i === 0 ? 500 : 1000);
    m = await measure(page);
    seen.push(Math.round(m.L.freq / 100) * 100);
    near(Math.abs(m.L.freq - m.R.freq), 200, 2, `入れ替え中の左右の違い #${i}`);
    near(m.L.rms / m.R.rms, 4, 0.3, `音量は耳に固定 #${i}`);
  }
  assert.deepStrictEqual(seen, [300, 500, 300, 500], `入れ替え順: ${seen}`);

  // 6) 入れ替え (チャンネルに固定): 大きい音 (左ch = 300 Hz) が左右を行き来する
  await page.check('input[name="volumeMode"][value="channel"]');
  await setNum(page, '#swapIntervalNum', 1);
  seen = [];
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(i === 0 ? 500 : 1000);
    m = await measure(page);
    const loud = m.L.rms > m.R.rms ? m.L : m.R;
    near(loud.freq, 300, 1, `大きい側は左ch のファイル #${i}`);
    seen.push(m.L.rms > m.R.rms ? 'L' : 'R');
  }
  assert.ok(['LRLR', 'RLRL'].includes(seen.join('')), `大きい側が交互に入れ替わる: ${seen}`);
  await page.check('input[name="volumeMode"][value="ear"]');
  await page.uncheck('#swapEnabled');

  // 7) 右ch を解除すると右耳は無音
  await page.click('#fileClearR');
  await page.waitForTimeout(600);
  m = await measure(page);
  assert.ok(m.R.rms < 0.001, `右耳が無音: ${m.R.rms}`);
  near(m.L.freq, 300, 1, '左耳は鳴り続ける');
  assert.strictEqual(await page.textContent('#fileNameR'), '未登録');
  await page.setInputFiles('#fileInputR', right);
  await page.waitForTimeout(600);
  m = await measure(page);
  near(m.R.freq, 500, 1, '再生中に登録し直すとすぐ鳴る');

  // 8) 停止は一時停止。再生で続きから鳴り、「先頭に戻す」で 0 秒へ
  const pos = () => page.evaluate(() => window.engine.files.L.el.currentTime);
  await page.click('#toggle');
  await waitToggle(page, '再生');
  const paused = await pos();
  assert.ok(paused > 1, `再生位置が進んでいる: ${paused}`);
  await page.waitForTimeout(400);
  near(await pos(), paused, 0.01, '停止中は再生位置が進まない');
  await page.click('#rewind');
  near(await pos(), 0, 0.01, '先頭に戻る');

  // 9) 再生中に純音へ切り替えると純音が鳴り、ファイルは止まる
  await page.click('#toggle');
  await waitToggle(page, '停止');
  await page.check('input[name="source"][value="tone"]');
  await page.waitForFunction(() => !document.getElementById('toggle').disabled);
  await page.waitForTimeout(600);
  m = await measure(page);
  near(m.L.freq, 200, 0.5, '純音に切り替え後の左耳');
  near(m.R.freq, 210, 0.5, '純音に切り替え後の右耳');
  assert.ok(await page.evaluate(() => window.engine.files.L.el.paused), 'ファイルは止まっている');
  assert.ok(await page.isVisible('#freqPanel'));

  // 10) 音声ファイルへ戻すとファイルが鳴る
  await page.check('input[name="source"][value="file"]');
  await page.waitForFunction(() => !document.getElementById('toggle').disabled);
  await page.waitForTimeout(600);
  m = await measure(page);
  near(m.L.freq, 300, 1, '音声ファイルに戻した後の左耳');

  // 11) 再生できないファイルは登録されず、理由が表示される
  await page.setInputFiles('#fileInputR', broken);
  await page.waitForFunction(() => document.getElementById('fileHint').textContent.includes('再生できない'));
  assert.strictEqual(await page.textContent('#fileNameR'), '未登録');

  await page.click('#toggle');
  await waitToggle(page, '再生');
  assert.deepStrictEqual(errors, [], `ページエラー: ${errors}`);
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('OK: 音声ファイルのテストに合格');
})().catch((e) => {
  console.error('NG:', e.message);
  process.exit(1);
});
