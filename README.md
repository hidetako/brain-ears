# Binaural Player

左右の耳に少しだけ周波数の違う純音を流す、Windows 用のバイノーラルビート プレーヤーです。
ヘッドホンまたはイヤホンで使用してください。

## 機能

| 項目 | 範囲 | 内容 |
|---|---|---|
| 音量(左右別) | 0〜100 % | 左右それぞれ独立に設定。「耳に固定」「チャンネルに固定」を選択 |
| 左右の周波数差 | 0.5〜20 Hz(0.1 刻み) | 左耳 = 基準音、右耳 = 基準音 + 差 |
| 基準音 | 40〜1000 Hz | 既定 200 Hz |
| 左右入れ替え | 0.1〜5 秒(0.1 刻み) | 指定間隔ごとに左右の音を入れ替える(オン/オフ可) |

- 音量の効かせ方は 2 通りから選べます。
  - **耳に固定**: 左右を入れ替えても各耳の音量は変わりません。左を小さくしていれば、入れ替え中も左耳は小さいままです(左右の聞こえ方の差の補正向け)。
  - **チャンネルに固定**: 音量は音源(左ch・右ch)に付き、入れ替えると音量も音と一緒に反対の耳へ移ります(左右に別の音源を入れる場合向け)。
- 入れ替えは音を混ぜ替えるのではなく、各耳の音の周波数を最大 30 ミリ秒かけて滑らかに移します。波形がつながったままなので、入れ替えの瞬間にノイズが出ません。
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

`package.json` の `version` を上げて main に push するだけです。

```bash
npm version patch --no-git-tag-version
```

```bash
git commit -am "Release 1.0.1"
```

```bash
git push origin main
```

main への push をきっかけに GitHub Actions が動き、その version の Release がまだ無ければ
Windows 上でインストーラーをビルドして Release(タグ `v1.0.1` など)として公開します。
既存ユーザーは次回起動時に自動で更新されます。version を変えていない push では何も公開されません。

自動更新は公開(Public)リポジトリの Release を前提にしています。Private のままでは更新を取得できません。

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
