# Binaural Player

左右の耳に少しだけ周波数の違う純音を流す、Windows 用のバイノーラルビート プレーヤーです。
ヘッドホンまたはイヤホンで使用してください。

## 機能

| 項目 | 範囲 | 内容 |
|---|---|---|
| 音量(左右別) | 0〜100 % | 左耳・右耳それぞれ独立に設定 |
| 左右の周波数差 | 0.5〜20 Hz(0.1 刻み) | 左耳 = 基準音、右耳 = 基準音 + 差 |
| 基準音 | 40〜1000 Hz | 既定 200 Hz |
| 左右入れ替え | 0.1〜5 秒(0.1 刻み) | 指定間隔ごとに左右の音を入れ替える(オン/オフ可) |

- 入れ替わるのは音(周波数)で、音量設定は耳に固定されます。左を小さくしていれば、入れ替え中も左耳は小さいままです。
- 入れ替えの瞬間は 8 ミリ秒のクロスフェードでクリックノイズを抑えています。
- 設定は自動保存され、次回起動時に復元されます。

## インストール

[Releases](https://github.com/hidetako/brain-ears/releases/latest) から
`Binaural-Player-Setup-x.y.z.exe` をダウンロードして実行します。

コード署名をしていないため、初回実行時に Windows SmartScreen の警告が出ます。
「詳細情報」→「実行」で進めてください。

## 自動更新

起動のたびに GitHub Releases を確認し、新しい版があれば裏でダウンロードします。
完了すると「今すぐ再起動」か「あとで(終了時に更新)」を選べます。状況は画面右下に表示されます。

## 新しい版の出し方

`package.json` の `version` を上げてコミットし、同じ番号のタグを push します。

```bash
npm version patch
```

```bash
git push origin main --follow-tags
```

タグ(`v1.0.1` など)の push をきっかけに GitHub Actions が Windows 上でインストーラーをビルドし、
Release として公開します。既存ユーザーは次回起動時に自動で更新されます。

自動更新は公開リポジトリの Release を前提にしています。

## 開発

```bash
npm install
```

```bash
npm start
```

```bash
npm test
```

`npm test` は Chromium 上で実際に音声エンジンを動かし、左右チャンネルの周波数・音量・入れ替えを測定します
(Playwright が必要)。

## 構成

- `src/engine.js` — Web Audio API による音声エンジン
- `src/renderer.js` / `index.html` / `style.css` — 画面
- `src/main.js` — Electron 本体と自動更新(electron-updater)
- `.github/workflows/release.yml` — インストーラーのビルドと公開
