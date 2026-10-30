'use strict';
// Chimpanzé Player — processo principal.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, screen, Menu, nativeTheme } = require('electron');

// Dados em pasta com nome ASCII (evita problemas com componentes nativos).
app.setName('Chimpanzé Player');
app.setPath('userData', path.join(app.getPath('appData'), 'ChimpanzePlayer'));
if (process.platform === 'win32') app.setAppUserModelId('com.joaovictor.chimpanzeplayer');

// User-agent de Chrome comum para todo o app (quadros de sites externos incluídos).
{
  const major = String(process.versions.chrome || '140').split('.')[0];
  app.userAgentFallback = process.platform === 'win32'
    ? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
    : `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const { JsonStore } = require('./store');
const { userDir, ensureDir, IS_WIN } = require('./paths');
const { DEFAULT_SETTINGS, deepMerge } = require('./settings');
const { MetadataService } = require('./metadata');
const { Library } = require('./library');
const images = require('./images');
const { PlayerSession } = require('./player');
const { QbitClient, autoConfigure, findQbitExe, VIDEO_RE } = require('./qbit');
const { SourcesBrowser, parseMagnet } = require('./sources');
const { prowlarrSearch, prowlarrTest } = require('./prowlarr');
const VP = require('./video-profile');
const { RtxEngine } = require('./rtx');

images.registerSchemePrivileges();
nativeTheme.themeSource = 'dark';

let mainWin = null;
let player = null;
let hasNvidia = false;
let gpuName = '';
const iconPath = path.join(__dirname, '..', 'renderer', 'assets', 'icon.png');
// O .ico fica fora do pacote asar (o Windows precisa ler direto do disco).
const icoPath = path.join(require('./paths').resourcesDir(), 'icon.ico');

ensureDir(userDir());
const settingsStore = new JsonStore(userDir('settings.json'), DEFAULT_SETTINGS);
const libraryStore = new JsonStore(userDir('library.json'), { folders: [], items: {}, overrides: {}, lastScan: 0 });
const progressStore = new JsonStore(userDir('progress.json'), {});

const settings = () => settingsStore.get();
const saveSettings = () => settingsStore.save();
const metadata = new MetadataService(settings);
const library = new Library(libraryStore, metadata, settings);
const qbit = new QbitClient(settings);
const sources = new SourcesBrowser({ getSettings: settings, saveSettings });
const rtx = new RtxEngine();

function send(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
}

// ---------- eventos dos serviços ----------
library.on('updated', () => send('library:updated', library.snapshot()));
library.on('progress', (p) => send('library:scan', p));
qbit.on('url-changed', (url) => {
  settings().torrent.url = url;
  saveSettings();
  send('settings:changed', settings());
});
// Download concluído: atualiza a biblioteca, identifica o título e pede confirmação ao usuário.
qbit.on('completed', async (t) => {
  send('notice', { text: `Download concluído: ${t.name}`, level: 'ok' });
  send('torrent:completed', t);
  try {
    const target = String(t.contentPath || t.savePath || '');
    const roots = library.folders().map((f) => f.toLowerCase());
    if (!roots.some((r) => target.toLowerCase().startsWith(r))) {
      const dir = t.savePath || path.dirname(target);
      if (dir) { library.addFolder(dir); watchFolders(); }
    }
    await library.scan();
    let items = library.itemsUnderPath(target);
    if (!items.length) { await new Promise((r) => setTimeout(r, 3000)); await library.scan(); items = library.itemsUnderPath(target); }
    for (const it of items.slice(0, 3)) {
      const done = await library.waitIdentified(it.id, 90000);
      if (done && !done.confirmed) send('library:confirm', { itemId: done.id, torrentName: t.name, reason: 'download' });
    }
  } catch (err) {
    console.error('[download concluído]', err);
  }
});
sources.on('state', (s) => send('sources:state', s));
rtx.on('progress', (p) => send('rtx:progress', p));
rtx.on('build', (b) => send('rtx:build', b));
sources.on('magnet', (m) => send('sources:magnet', m));
sources.on('notice', (n) => send('notice', n));
sources.on('torrent-file', async ({ file, name }) => {
  send('sources:torrent-file', { file, name });
});

// ---------- janela principal ----------
function createMainWindow() {
  const disp = screen.getPrimaryDisplay().workAreaSize;
  mainWin = new BrowserWindow({
    width: Math.min(1600, Math.round(disp.width * 0.88)),
    height: Math.min(1000, Math.round(disp.height * 0.88)),
    minWidth: 960, minHeight: 600,
    frame: false,
    backgroundColor: '#0b0806',
    show: false,
    title: 'Chimpanzé Player',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'app-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false,
    },
  });
  mainWin.setMenu(null);
  mainWin.once('ready-to-show', () => { mainWin.show(); });
  mainWin.on('maximize', () => send('window:state', { maximized: true }));
  mainWin.on('unmaximize', () => send('window:state', { maximized: false }));
  mainWin.on('closed', () => { mainWin = null; });
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWin.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWin.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  sources.attach(mainWin);
}

// ---------- reprodução ----------
async function startPlayback(req) {
  if (player) { try { player.close(); } catch (_) { /* ok */ } player = null; }
  sources.hide();
  const session = new PlayerSession({
    settings, saveSettings,
    progress: () => progressStore.get(),
    saveProgress: () => { progressStore.save(1000); send('progress:updated', progressStore.get()); },
    library,
    hasNvidia: () => hasNvidia,
    rtx,
    iconPath,
    icoPath,
    onClosed: (s) => {
      if (player === s) player = null;
      progressStore.flush();
      send('progress:updated', progressStore.get());
      send('player:closed', {});
      if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); }
    },
  }, req);
  player = session;
  if (mainWin && !mainWin.isDestroyed()) mainWin.hide();
  try {
    await session.open();
  } catch (err) {
    console.error(err);
    session.close();
    send('notice', { text: 'Não foi possível iniciar a reprodução: ' + err.message, level: 'error' });
  }
}

// ---------- IPC ----------
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try { return { ok: true, data: await fn(...args, event) }; } catch (err) {
      if (!err || err.code !== 'OFFLINE') console.error(`[ipc ${channel}]`, err);
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

handle('app:state', () => ({
  settings: settings(),
  library: library.snapshot(),
  progress: progressStore.get(),
  version: app.getVersion(),
  platform: process.platform,
  gpu: { nvidia: hasNvidia, name: gpuName },
  rifeAvailable: VP.rifeAvailable(),
  rtx: rtx.status(),
  presets: Object.keys(VP.PRESETS),
  defaultVideo: VP.DEFAULT_VIDEO,
}));

handle('settings:set', (patch) => {
  patch = { ...(patch || {}) };
  if (patch.removeVideoProfile) { delete settings().videoProfiles[patch.removeVideoProfile]; delete patch.removeVideoProfile; }
  deepMerge(settings(), patch);
  if (patch && patch.video) settings().video = VP.sanitizeVideo(settings().video);
  saveSettings();
  return settings();
});

handle('window:control', (action) => {
  if (!mainWin) return null;
  if (action === 'minimize') mainWin.minimize();
  if (action === 'maximize') { if (mainWin.isMaximized()) mainWin.unmaximize(); else mainWin.maximize(); }
  if (action === 'close') mainWin.close();
  if (action === 'fullscreen') mainWin.setFullScreen(!mainWin.isFullScreen());
  return { maximized: mainWin.isMaximized() };
});

handle('library:pickFolder', async () => {
  const r = await dialog.showOpenDialog(mainWin, { title: 'Escolha a pasta com seus filmes, séries e animes', properties: ['openDirectory', 'multiSelections'] });
  if (r.canceled || !r.filePaths.length) return null;
  for (const p of r.filePaths) library.addFolder(p);
  settings().firstRun = false;
  saveSettings();
  library.scan();
  return library.folders();
});
handle('library:removeFolder', (dir) => { library.removeFolder(dir); library.scan(); return library.folders(); });
handle('library:scan', () => { library.scan(); return true; });
handle('library:search', (query, kind) => metadata.searchCandidates(query, kind === 'movie' ? 'movie' : 'tv'));
handle('library:applyMatch', (id, choice) => library.applyMatch(id, choice));
handle('library:setKind', (id, kind) => { library.setKind(id, kind); return true; });
handle('library:refreshMeta', (id) => { library.refreshMeta(id); return true; });
handle('library:retryAll', () => { library.refreshAllFailed(); return true; });
handle('library:setTitle', (id, title) => {
  const it = library.data.items[id];
  if (!it) return false;
  const ov = library.data.overrides[it.key] || {};
  if (title) { ov.title = title; it.customTitle = title; } else { delete ov.title; delete it.customTitle; }
  library.data.overrides[it.key] = ov;
  libraryStore.save();
  send('library:updated', library.snapshot());
  return true;
});
handle('library:markWatched', (paths, watched) => {
  const prog = progressStore.get();
  for (const p of [].concat(paths)) {
    if (watched) prog[p] = { ...(prog[p] || {}), pos: (prog[p] && prog[p].dur) || 1, dur: (prog[p] && prog[p].dur) || 1, watched: true, t: Date.now() };
    else delete prog[p];
  }
  progressStore.save(200);
  send('progress:updated', prog);
  return true;
});
handle('library:clearCache', () => { images.clearCache(); return true; });
handle('library:setArt', (id, kind, file) => { library.setArt(id, kind, file, userDir('covers')); return true; });
handle('library:clearArt', (id, kind) => { library.clearArt(id, kind); return true; });
handle('library:confirm', (id, kind) => { library.confirm(id, kind); return true; });
handle('library:setManual', (id, data) => { library.setManual(id, data || {}); return true; });
handle('library:pendingConfirm', () => Object.values(library.data.items).filter((i) => !i.confirmed && i.metaStatus === 'notfound').map((i) => i.id));
handle('library:cacheSize', () => images.cacheSize());

handle('player:play', (req) => { startPlayback(req); return true; });

// Motor RTX (TensorRT para RTX)
handle('rtx:status', () => ({ ...rtx.status(), nvidia: hasNvidia, gpu: gpuName }));
handle('rtx:install', async (manualZip) => {
  rtx.install({ manualZip: manualZip || undefined }).catch((e) => console.error('[rtx] instalação', e.message));
  return true;
});
handle('rtx:build', async (model) => { rtx.ensureEngine(model).catch(() => {}); return true; });
handle('rtx:uninstall', () => rtx.uninstall());
handle('rtx:openLog', () => {
  const f = require('path').join(rtx.dirs().base, 'last-tool.log');
  if (fs.existsSync(f)) shell.openPath(f);
  return fs.existsSync(f);
});
ipcMain.handle('player:cmd', async (_e, cmd) => {
  if (!player || !cmd || typeof cmd.type !== 'string') return null;
  try { return await player.command(cmd); } catch (err) { console.error('[player:cmd]', err); return null; }
});

handle('shell:open', (target) => {
  if (/^https?:\/\//i.test(target)) return shell.openExternal(target);
  if (fs.existsSync(target)) return shell.openPath(target);
  return false;
});
handle('shell:showItem', (p) => { if (fs.existsSync(p)) shell.showItemInFolder(p); return true; });
handle('dialog:pickFile', async (filters) => {
  const r = await dialog.showOpenDialog(mainWin, { properties: ['openFile'], filters: filters || [] });
  return r.canceled ? null : r.filePaths[0];
});
handle('dialog:pickDir', async () => {
  const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// Torrent
function defaultSaveDir(kind) {
  const t = settings().torrent;
  const base = t.downloadDir || library.folders()[0] || path.join(app.getPath('downloads'), 'Chimpanze Player');
  const sub = { movie: 'Filmes', series: 'Séries', anime: 'Animes' }[kind];
  return sub ? path.join(base, sub) : base;
}
handle('torrent:status', () => qbit.status());
handle('torrent:ensure', () => qbit.ensureRunning());
handle('torrent:list', () => qbit.list(settings().torrent.onlyOurs));
handle('torrent:files', (hash) => qbit.files(hash));
handle('torrent:add', async (magnet, opts = {}) => {
  const st = await qbit.ensureRunning();
  if (!st.ok) throw new Error(st.error || 'qBittorrent indisponível');
  const savePath = opts.savePath || defaultSaveDir(opts.kind);
  ensureDir(savePath);
  if (opts.file) await qbit.addTorrentFile(opts.file, { savePath, sequential: opts.sequential !== false });
  else await qbit.addMagnet(magnet, { savePath, sequential: opts.sequential !== false });
  const inLibrary = library.folders().some((f) => savePath.toLowerCase().startsWith(f.toLowerCase()));
  if (!inLibrary && opts.addToLibrary !== false) { library.addFolder(savePath); watchFolders(); }
  return { savePath };
});
handle('torrent:pause', (h) => qbit.pause(h));
handle('torrent:resume', (h) => qbit.resume(h));
handle('torrent:remove', (h, del) => qbit.remove(h, del));
handle('torrent:toggleSeq', (h) => qbit.toggleSequential(h));
handle('torrent:autoConfig', (force) => runQbitAutoConfig(!!force));
async function runQbitAutoConfig(force) {
  const r = await autoConfigure({ force });
  if (r.ok) {
    const t = settings().torrent;
    t.url = `http://127.0.0.1:${r.port}`;
    t.username = r.username || '';
    t.password = r.password || '';
    qbit.sid = null;
    saveSettings();
    const exe = findQbitExe(settings());
    if (exe) {
      const st = await qbit.ensureRunning();
      r.connected = !!st.ok;
      r.version = st.version;
      if (!st.ok) r.error = st.error;
    } else {
      r.connected = false;
      r.error = 'Configuração gravada, mas não encontrei o qbittorrent.exe. Abra o qBittorrent manualmente.';
    }
  }
  delete r.password;
  return r;
}
handle('torrent:defaultDir', (kind) => defaultSaveDir(kind));
handle('torrent:play', async (hash, index) => {
  const list = await qbit.list(false);
  const t = list.find((x) => x.hash === hash);
  if (!t) throw new Error('Torrent não encontrado.');
  const files = await qbit.files(hash);
  let f = index != null ? files.find((x) => x.index === index) : null;
  if (!f) f = files.filter((x) => x.isVideo).sort((a, b) => b.size - a.size)[0];
  if (!f) throw new Error('Nenhum arquivo de vídeo neste torrent.');
  const full = path.join(t.savePath, f.name);
  const candidates = [full, full + '.!qB'];
  const existing = candidates.find((c) => fs.existsSync(c));
  if (!existing) throw new Error('O arquivo ainda não começou a ser gravado. Aguarde alguns segundos.');
  if (f.progress < 0.02 && !t.sequential) throw new Error('Pouco conteúdo baixado ainda. Ative "baixar em sequência" para assistir enquanto baixa.');
  const found = library.findByPath(existing);
  if (found) startPlayback({ itemId: found.item.id, episodeId: found.episode ? found.episode.id : undefined, file: existing });
  else startPlayback({ file: existing, title: path.basename(f.name).replace(/\.[^.]+$/, '') });
  return true;
});

// Fontes (navegador)
handle('sources:open', (url) => sources.open(url));
handle('sources:nav', (action, arg) => { sources.nav(action, arg); return true; });
handle('sources:bounds', (b) => { sources.setBounds(b); return true; });
handle('sources:show', () => { sources.show(); return true; });
handle('sources:hide', () => { sources.hide(); return true; });
handle('sources:setAdblock', (on) => { sources.setAdblock(on); return true; });
handle('sources:clearData', () => sources.clearData());
handle('sources:parseMagnet', (uri) => parseMagnet(uri));

// Prowlarr
handle('prowlarr:search', (q) => prowlarrSearch(settings().prowlarr, q));
handle('prowlarr:test', () => prowlarrTest(settings().prowlarr));

// ---------- ciclo de vida ----------
// Links magnet vindos do navegador do sistema (quando o Chimpanzé é o app padrão para "magnet:").
let pendingMagnet = (process.argv || []).find((a) => /^magnet:\?/i.test(a)) || null;
function deliverMagnet(uri) {
  if (!uri) return;
  if (!mainWin || mainWin.isDestroyed() || mainWin.webContents.isLoading()) { pendingMagnet = uri; return; }
  const { parseMagnet: pm } = require('./sources');
  send('sources:external-magnet', pm(uri));
  if (!player) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.show(); mainWin.focus(); }
}

app.on('second-instance', (_e, argv) => {
  const mag = (argv || []).find((a) => /^magnet:\?/i.test(a));
  if (mag) { deliverMagnet(mag); return; }
  if (player && player.win && !player.win.isDestroyed()) { player.win.focus(); return; }
  if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.show(); mainWin.focus(); }
});

handle('magnet:isDefault', () => app.isDefaultProtocolClient('magnet'));
handle('magnet:setDefault', (on) => {
  if (on) app.setAsDefaultProtocolClient('magnet');
  else app.removeAsDefaultProtocolClient('magnet');
  return app.isDefaultProtocolClient('magnet');
});
handle('app:ready', () => { const m = pendingMagnet; pendingMagnet = null; if (m) setTimeout(() => deliverMagnet(m), 300); return true; });

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  images.registerProtocol();
  try {
    const info = await app.getGPUInfo('basic');
    const devs = (info && info.gpuDevice) || [];
    const nv = devs.find((d) => d.vendorId === 0x10de);
    hasNvidia = !!nv;
    const active = devs.find((d) => d.active) || devs[0];
    gpuName = nv ? (nv.deviceString || 'NVIDIA') : (active && active.deviceString) || '';
  } catch (_) { /* ok */ }
  createMainWindow();
  // Varredura inicial em segundo plano.
  if (library.folders().length) setTimeout(() => library.scan(), 1200);
  // qBittorrent: inicia junto se configurado.
  if (settings().torrent.autoStart && settings().torrent.username) setTimeout(() => qbit.ensureRunning().catch(() => {}), 3000);
  qbit.startPolling(8000);
  watchFolders();
  setTimeout(autoSetupRtx, 4000);
  // qBittorrent instalado mas nunca configurado: liga a WebUI sozinho (só com ele fechado).
  setTimeout(async () => {
    try {
      const t = settings().torrent;
      if (t.username || !findQbitExe(settings())) return;
      const st = await qbit.status().catch(() => ({ ok: false }));
      if (st && st.ok) return;
      const r = await runQbitAutoConfig(false);
      if (r && r.ok && r.connected) send('notice', { text: 'qBittorrent configurado e conectado automaticamente.', level: 'ok' });
    } catch (e) { console.error('[qbit] configuração automática', e && e.message); }
  }, 6000);
});

// Prepara sozinho o motor de 60 FPS (TensorRT) na primeira execução — sem cliques.
async function autoSetupRtx() {
  try {
    if (process.platform !== 'win32' || !hasNvidia) return;
    const st = rtx.status();
    if (!st.supported || st.busy) return;
    const model = (settings().video && settings().video.rifeModel) || 'balanced';
    if (!st.installed) {
      send('notice', { text: 'Preparando o motor de 60 FPS para a sua RTX (só na primeira vez). Você já pode usar o app enquanto isso.', level: 'info' });
      await rtx.install();
      send('notice', { text: 'Motor de 60 FPS pronto! Os vídeos já abrem com a fluidez ligada.', level: 'ok' });
    }
    if (!rtx.engineReady(model)) await rtx.ensureEngine(model);
  } catch (e) {
    console.error('[rtx] preparação automática', e && e.message);
    // Tenta de novo em 10 minutos (rede instável etc.).
    setTimeout(autoSetupRtx, 10 * 60 * 1000);
  }
}

// Observa mudanças nas pastas (novos episódios) e reescaneia com atraso.
let watchers = [];
function watchFolders() {
  for (const w of watchers) { try { w.close(); } catch (_) { /* ok */ } }
  watchers = [];
  let timer = null;
  const trigger = (_ev, file) => {
    if (file && !/\.(mkv|mp4|avi|m4v|mov|wmv|webm|ts|m2ts)$/i.test(String(file))) return;
    clearTimeout(timer);
    timer = setTimeout(() => library.scan(), 6000);
  };
  for (const f of library.folders()) {
    try { watchers.push(fs.watch(f, { recursive: true }, trigger)); } catch (_) { /* recursivo não suportado */ }
  }
}
library.on('progress', (p) => { if (p.phase === 'done') { if (watchers.length !== library.folders().length) watchFolders(); } });

app.on('window-all-closed', () => {
  if (player) return;
  app.quit();
});

app.on('before-quit', () => {
  try { if (player) player.close(); } catch (_) { /* ok */ }
  settingsStore.flush();
  libraryStore.flush();
  progressStore.flush();
  qbit.stopPolling();
});

process.on('uncaughtException', (err) => {
  console.error('[erro não tratado]', err);
  try { fs.appendFileSync(path.join(ensureDir(userDir('logs')), 'app.log'), `[${new Date().toISOString()}] ${err && err.stack || err}\n`); } catch (_) { /* ok */ }
});
process.on('unhandledRejection', (err) => {
  console.error('[promessa rejeitada]', err);
  try { fs.appendFileSync(path.join(ensureDir(userDir('logs')), 'app.log'), `[${new Date().toISOString()}] ${err && err.stack || err}\n`); } catch (_) { /* ok */ }
});

module.exports = { VIDEO_RE, IS_WIN };
