'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('player', {
  cmd: (c) => ipcRenderer.invoke('player:cmd', c),
  on: (channel, fn) => {
    const allowed = ['player:prop', 'player:info', 'player:toast', 'player:ended', 'player:loaded', 'player:video', 'player:window', 'player:tune'];
    if (!allowed.includes(channel)) return () => {};
    const h = (_e, p) => fn(p);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
