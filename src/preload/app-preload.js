'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r || !r.ok) throw new Error((r && r.error) || 'Erro desconhecido');
  return r.data;
}

function on(channel, fn) {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}

contextBridge.exposeInMainWorld('chimp', {
  state: () => call('app:state'),
  setSettings: (patch) => call('settings:set', patch),
  win: (action) => call('window:control', action),
  library: {
    pickFolder: () => call('library:pickFolder'),
    removeFolder: (d) => call('library:removeFolder', d),
    scan: () => call('library:scan'),
    search: (q, kind) => call('library:search', q, kind),
    applyMatch: (id, choice) => call('library:applyMatch', id, choice),
    setKind: (id, kind) => call('library:setKind', id, kind),
    setTitle: (id, title) => call('library:setTitle', id, title),
    refreshMeta: (id) => call('library:refreshMeta', id),
    retryAll: () => call('library:retryAll'),
    markWatched: (paths, watched) => call('library:markWatched', paths, watched),
    clearCache: () => call('library:clearCache'),
    setArt: (id, kind, file) => call('library:setArt', id, kind, file),
    clearArt: (id, kind) => call('library:clearArt', id, kind),
    confirm: (id, kind) => call('library:confirm', id, kind),
    setManual: (id, data) => call('library:setManual', id, data),
    cacheSize: () => call('library:cacheSize'),
  },
  play: (req) => call('player:play', req),
  ready: () => call('app:ready'),
  magnet: {
    isDefault: () => call('magnet:isDefault'),
    setDefault: (on) => call('magnet:setDefault', on),
  },
  shell: {
    open: (t) => call('shell:open', t),
    showItem: (p) => call('shell:showItem', p),
    pickFile: (filters) => call('dialog:pickFile', filters),
    pickDir: () => call('dialog:pickDir'),
    pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return ''; } },
  },
  torrent: {
    status: () => call('torrent:status'),
    ensure: () => call('torrent:ensure'),
    list: () => call('torrent:list'),
    files: (h) => call('torrent:files', h),
    add: (magnet, opts) => call('torrent:add', magnet, opts),
    pause: (h) => call('torrent:pause', h),
    resume: (h) => call('torrent:resume', h),
    remove: (h, del) => call('torrent:remove', h, del),
    toggleSeq: (h) => call('torrent:toggleSeq', h),
    autoConfig: (force) => call('torrent:autoConfig', force),
    defaultDir: (kind) => call('torrent:defaultDir', kind),
    play: (h, idx) => call('torrent:play', h, idx),
  },
  sources: {
    open: (url) => call('sources:open', url),
    nav: (a, arg) => call('sources:nav', a, arg),
    bounds: (b) => call('sources:bounds', b),
    show: () => call('sources:show'),
    hide: () => call('sources:hide'),
    setAdblock: (on) => call('sources:setAdblock', on),
    clearData: () => call('sources:clearData'),
    parseMagnet: (u) => call('sources:parseMagnet', u),
  },
  rtx: {
    status: () => call('rtx:status'),
    install: (zip) => call('rtx:install', zip),
    build: (model) => call('rtx:build', model),
    uninstall: () => call('rtx:uninstall'),
    openLog: () => call('rtx:openLog'),
  },
  prowlarr: {
    search: (q) => call('prowlarr:search', q),
    test: () => call('prowlarr:test'),
  },
  on,
});
