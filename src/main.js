'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { app, BrowserWindow, Menu, dialog, ipcMain, screen } = require('electron');
const { autoUpdater } = require('electron-updater');

let win = null;

// 読み込みを許可する音声ファイルの拡張子と種類
const AUDIO_TYPES = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
};
const MAX_AUDIO_BYTES = 1024 * 1024 * 1024;

// 前回登録された音声ファイルを読み直す。読めなければ null
async function readAudioFile(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return null;
  const type = AUDIO_TYPES[path.extname(filePath).toLowerCase()];
  if (!type) return null;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_AUDIO_BYTES) return null;
    const bytes = await fs.readFile(filePath);
    return { name: path.basename(filePath), type, bytes };
  } catch (_) {
    return null;
  }
}

function sendStatus(text) {
  if (win && !win.isDestroyed()) win.webContents.send('update:status', text);
}

function createWindow() {
  // 画面が低い PC でもはみ出さない高さにする (中身は縦スクロールできる)
  const { height: workHeight } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: 500,
    height: Math.min(800, workHeight),
    minWidth: 420,
    minHeight: 480,
    backgroundColor: '#14171c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 最小化中も左右入れ替えのタイミングを保つ
      backgroundThrottling: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => { win = null; });
}

// 起動時に GitHub Releases を確認し、新しい版があれば裏でダウンロードする
function setupAutoUpdate() {
  if (!app.isPackaged) {
    sendStatus('開発モード（更新確認なし）');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => sendStatus('更新を確認中…'));
  autoUpdater.on('update-not-available', () => sendStatus('最新版です'));
  autoUpdater.on('update-available', (info) => {
    sendStatus(`v${info.version} をダウンロード中…`);
  });
  autoUpdater.on('download-progress', (p) => {
    sendStatus(`更新をダウンロード中… ${Math.round(p.percent)}%`);
  });
  autoUpdater.on('error', () => sendStatus('更新を確認できませんでした'));
  autoUpdater.on('update-downloaded', async (info) => {
    sendStatus(`v${info.version} の準備完了（次回起動時に適用）`);
    if (!win || win.isDestroyed()) return;
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'アップデート',
      message: `新しいバージョン v${info.version} をダウンロードしました。`,
      detail: '今すぐ再起動して更新しますか？「あとで」を選ぶと、終了時に自動で更新されます。',
      buttons: ['今すぐ再起動', 'あとで'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.checkForUpdates().catch(() => sendStatus('更新を確認できませんでした'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('audio:read', (_event, filePath) => readAudioFile(filePath));

  app.whenReady().then(() => {
    createWindow();
    win.webContents.once('did-finish-load', setupAutoUpdate);
  });

  app.on('window-all-closed', () => app.quit());
}
