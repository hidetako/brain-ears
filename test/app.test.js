'use strict';

// 実際の Electron アプリを起動して確認する:
// 音声ファイルの登録 → アプリ再起動 → 前回のファイルが復元されて鳴ること。
// 実行: npm run test:app
// Linux では画面と UTF-8 ロケールが必要: LC_ALL=C.UTF-8 xvfb-run -a npm run test:app

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { _electron: electron } = require('playwright');

const root = path.join(__dirname, '..');

function writeWav(file, freq) {
  const rate = 48000;
  const frames = rate * 3;
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.5 * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([head, data]));
}

// 左右それぞれの耳に届いている音の周波数を測る
function measure(page) {
  return page.evaluate(async () => {
    const { ctx, nodes } = window.engine;
    const splitter = ctx.createChannelSplitter(2);
    nodes.merger.connect(splitter);
    const analysers = [0, 1].map((ch) => {
      const a = ctx.createAnalyser();
      a.fftSize = 8192;
      splitter.connect(a, ch);
      return a;
    });
    await new Promise((r) => setTimeout(r, 700));
    return analysers.map((a) => {
      const buf = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(buf);
      let first = -1;
      let last = -1;
      let count = 0;
      for (let i = 1; i < buf.length; i++) {
        if (buf[i - 1] < 0 && buf[i] >= 0) {
          const pos = i - buf[i] / (buf[i] - buf[i - 1]);
          if (first < 0) first = pos;
          last = pos;
          count++;
        }
      }
      return count > 1 ? ((count - 1) * ctx.sampleRate) / (last - first) : 0;
    });
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binaural-app-'));
  const left = path.join(dir, '左の音声.wav');
  const right = path.join(dir, 'right-500.wav');
  writeWav(left, 300);
  writeWav(right, 500);
  const launch = () =>
    electron.launch({
      executablePath: require(path.join(root, 'node_modules', 'electron')),
      args: [root, '--no-sandbox', `--user-data-dir=${path.join(dir, 'profile')}`],
    });

  // 1 回目: ファイルを登録する
  let app = await launch();
  let page = await app.firstWindow();
  await page.waitForFunction(() => document.getElementById('version').textContent !== '');
  const version = require(path.join(root, 'package.json')).version;
  assert.strictEqual(await page.textContent('#version'), `v${version}`);
  await page.check('input[name="source"][value="file"]');
  await page.setInputFiles('#fileInputL', left);
  await page.setInputFiles('#fileInputR', right);
  assert.strictEqual(await page.textContent('#fileNameL'), '左の音声.wav');
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  await app.close();

  // 2 回目: 再起動後に同じファイルが復元され、再生できる
  app = await launch();
  page = await app.firstWindow();
  await page.waitForFunction(() => document.getElementById('fileNameR').textContent === 'right-500.wav');
  assert.strictEqual(await page.textContent('#fileNameL'), '左の音声.wav');
  assert.ok(await page.isChecked('input[name="source"][value="file"]'), '音源の選択も復元される');
  await page.click('#toggle');
  await page.waitForFunction(() => document.getElementById('toggle').textContent === '停止');
  const [l, r] = await measure(page);
  assert.ok(Math.abs(l - 300) < 1, `左耳の周波数: ${l}`);
  assert.ok(Math.abs(r - 500) < 1, `右耳の周波数: ${r}`);
  await app.close();

  // 3 回目: ファイルが消えていたら登録が外れ、その旨が表示される
  fs.rmSync(right);
  app = await launch();
  page = await app.firstWindow();
  await page.waitForFunction(() => document.getElementById('fileHint').textContent.includes('見つかりません'));
  assert.strictEqual(await page.textContent('#fileNameR'), '未登録');
  assert.strictEqual(await page.textContent('#fileNameL'), '左の音声.wav');
  await app.close();

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('OK: アプリのテストに合格');
})().catch((e) => {
  console.error('NG:', e.message);
  process.exit(1);
});
