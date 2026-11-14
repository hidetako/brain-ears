'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('app', {
  getVersion: () => ipcRenderer.invoke('app:version'),
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update:status', (_event, text) => callback(text));
  },
  // 選択されたファイルの場所 (次回起動時に同じファイルを読み直すために覚えておく)
  getPathForFile: (file) => webUtils.getPathForFile(file),
  // 覚えておいた場所の音声ファイルを読む。無ければ null
  readAudioFile: (filePath) => ipcRenderer.invoke('audio:read', filePath),
});
