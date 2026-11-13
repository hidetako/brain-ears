'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('app', {
  getVersion: () => ipcRenderer.invoke('app:version'),
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update:status', (_event, text) => callback(text));
  },
});
