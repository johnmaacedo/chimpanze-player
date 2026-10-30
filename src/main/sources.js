'use strict';
// Navegador integrado para "Fontes": sites de confiança, bloqueio de anúncios/pop-ups e captura de magnet links.
const fs = require('fs');
const path = require('path');
const { WebContentsView, session } = require('electron');
const { EventEmitter } = require('events');
const { userDir, ensureDir, resourcesDir } = require('./paths');

const PARTITION = 'persist:fontes';
const SECOND_LEVEL = new Set(['com.br', 'net.br', 'org.br', 'co.uk', 'org.uk', 'com.au', 'co.jp', 'com.ar', 'com.mx', 'co.in', 'com.tr', 'co.kr', 'com.pt']);

function siteKey(host) {
  host = String(host || '').toLowerCase().replace(/^www\./, '');
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join('.');
  if (SECOND_LEVEL.has(last2)) return parts.slice(-3).join('.');
  return last2;
}

function parseMagnet(uri) {
  try {
    const q = uri.slice(uri.indexOf('?') + 1);
    const params = new URLSearchParams(q);
    const xt = params.getAll('xt').find((x) => /urn:btih:/i.test(x)) || params.get('xt') || '';
    const hash = (xt.match(/urn:btih:([a-z0-9]+)/i) || [])[1] || '';
    const name = params.get('dn') || '';
    const size = Number(params.get('xl')) || null;
    return { uri, hash: hash.toLowerCase(), name, size, trackers: params.getAll('tr').length };
  } catch (_) {
    return { uri, hash: '', name: '', size: null, trackers: 0 };
  }
}

class SourcesBrowser extends EventEmitter {
  constructor({ getSettings, saveSettings }) {
    super();
    this.getSettings = getSettings;
    this.saveSettings = saveSettings;
    this.win = null;
    this.view = null;
    this.bounds = null;
    this.visible = false;
    this.blocker = null;
    this.blockerReady = null;
    this.magnets = new Map(); // hash/uri -> info
    this.allowOnce = new Set();
    this.blockedCount = 0;
    this.sess = null;
  }

  _session() {
    if (this.sess) return this.sess;
    const sess = session.fromPartition(PARTITION);
    this.sess = sess;
    // Pedidos de permissão (câmera, microfone, localização…) continuam negados, mas as *consultas*
    // ficam no comportamento padrão do Chromium: respostas incoerentes (ex.: notificações) fazem a
    // Cloudflare achar que o navegador é um robô e a verificação "Confirme que é humano" nunca termina.
    sess.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'fullscreen' || perm === 'clipboard-sanitized-write'));
    // Identifica-se como Chrome comum (sem "Electron"/nome do app no user-agent).
    const chromeVer = process.versions.chrome || '140.0.0.0';
    const major = chromeVer.split('.')[0];
    const ua = process.platform === 'win32'
      ? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
      : `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
    sess.setUserAgent(ua, 'pt-BR,pt,en-US,en');
    this.ua = ua;
    // Bloqueia downloads perigosos; .torrent vai para o qBittorrent.
    sess.on('will-download', (event, item) => {
      const name = item.getFilename() || '';
      const mime = item.getMimeType() || '';
      if (/\.torrent$/i.test(name) || /bittorrent/i.test(mime)) {
        const dir = ensureDir(userDir('cache', 'torrents'));
        const target = path.join(dir, `${Date.now()}-${name.replace(/[^\w.\- ]+/g, '_') || 'arquivo.torrent'}`);
        item.setSavePath(target);
        item.once('done', (_e, state) => {
          if (state === 'completed') this.emit('torrent-file', { file: target, name });
          else this.emit('notice', { text: 'Falha ao baixar o arquivo .torrent.', level: 'warn' });
        });
      } else {
        event.preventDefault();
        this.blockedCount++;
        this.emit('notice', { text: `Download bloqueado por segurança: ${name || 'arquivo'}`, level: 'warn' });
        this._emitState();
      }
    });
    return sess;
  }

  async _initBlocker() {
    if (this.blockerReady) return this.blockerReady;
    this.blockerReady = (async () => {
      try {
        const { ElectronBlocker } = require('@ghostery/adblocker-electron');
        const cacheFile = path.join(ensureDir(userDir('cache')), 'adblock-engine.bin');
        const bundled = path.join(resourcesDir(), 'adblock', 'engine.bin');
        let blocker = null;
        // 1) Tenta lista atualizada da internet (com cache em disco).
        try {
          blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
            path: cacheFile,
            read: fs.promises.readFile,
            write: fs.promises.writeFile,
          });
        } catch (_) {
          // 2) Sem internet: usa a versão embutida no aplicativo.
          if (fs.existsSync(bundled)) blocker = ElectronBlocker.deserialize(new Uint8Array(fs.readFileSync(bundled)));
        }
        if (!blocker) return null;
        blocker.on && blocker.on('request-blocked', () => { this.blockedCount++; this._emitStateThrottled(); });
        blocker.on && blocker.on('request-redirected', () => { this.blockedCount++; this._emitStateThrottled(); });
        this.blocker = blocker;
        if (this.getSettings().sources.adblock !== false) blocker.enableBlockingInSession(this._session());
        return blocker;
      } catch (err) {
        console.error('[fontes] adblock indisponível', err);
        return null;
      }
    })();
    return this.blockerReady;
  }

  setAdblock(on) {
    const s = this.getSettings();
    s.sources.adblock = !!on;
    this.saveSettings();
    if (!this.blocker) return;
    try {
      if (on) this.blocker.enableBlockingInSession(this._session());
      else this.blocker.disableBlockingInSession(this._session());
    } catch (_) { /* já no estado pedido */ }
  }

  attach(win) { this.win = win; }

  async _ensureView() {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    await this._initBlocker();
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        preload: path.join(__dirname, '..', 'preload', 'page-preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        // O script de apoio também roda dentro de quadros (necessário para a caixinha da Cloudflare).
        nodeIntegrationInSubFrames: true,
        plugins: true,
        javascript: true, webSecurity: true, safeDialogs: true, disableDialogs: false,
        autoplayPolicy: 'user-gesture-required',
      },
    });
    view.setBackgroundColor('#0d0907');
    const wc = view.webContents;
    if (this.ua) wc.setUserAgent(this.ua);
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (/^magnet:/i.test(url)) { this._captureMagnet(url, 'clique'); return { action: 'deny' }; }
      try {
        const cur = new URL(wc.getURL());
        const target = new URL(url);
        // Links do mesmo site em nova aba abrem na mesma visualização; o resto é pop-up e é bloqueado.
        if (siteKey(target.hostname) === siteKey(cur.hostname) && disposition !== 'new-window') {
          setImmediate(() => wc.loadURL(url));
        } else {
          this.blockedCount++;
          this.emit('notice', { text: `Pop-up bloqueado: ${target.hostname}`, level: 'info', allowUrl: url });
          this._emitState();
        }
      } catch (_) { /* url inválida */ }
      return { action: 'deny' };
    });
    const guard = (event, url, isMainFrame = true) => {
      if (/^magnet:/i.test(url)) {
        event.preventDefault();
        this._captureMagnet(url, 'clique');
        return;
      }
      if (!/^https?:/i.test(url)) {
        if (/^(about|data|blob):/i.test(url)) return;
        event.preventDefault();
        return;
      }
      if (!isMainFrame) return;
      try {
        const cur = wc.getURL();
        if (!cur || cur === 'about:blank') return;
        const from = siteKey(new URL(cur).hostname);
        const to = siteKey(new URL(url).hostname);
        if (from === to) return;
        if (this.allowOnce.has(url)) { this.allowOnce.delete(url); return; }
        if (this._isTrusted(to)) return;
        event.preventDefault();
        this.blockedCount++;
        this.emit('notice', { text: `Redirecionamento para outro site bloqueado: ${new URL(url).hostname}`, level: 'info', allowUrl: url });
        this._emitState();
      } catch (_) { /* ok */ }
    };
    wc.on('will-navigate', (e) => guard(e, e.url, e.isMainFrame !== false));
    wc.on('will-redirect', (e) => {
      if (/^magnet:/i.test(e.url)) { e.preventDefault(); this._captureMagnet(e.url, 'redirecionamento'); }
    });
    wc.on('will-frame-navigate', (e) => { if (!e.isMainFrame && /^magnet:/i.test(e.url)) { e.preventDefault(); this._captureMagnet(e.url, 'quadro'); } });
    wc.on('did-start-navigation', (e) => { if (e.isMainFrame && !e.isSameDocument) { this.magnets.clear(); this._emitState(); } });
    for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-stop-loading', 'did-start-loading']) wc.on(ev, () => this._emitState());
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (isMain && code !== -3) this.emit('notice', { text: `Não foi possível abrir a página (${desc}).`, level: 'warn' });
    });
    wc.on('ipc-message', (_e, channel, payload) => {
      if (channel === 'fontes:magnets' && Array.isArray(payload)) {
        let changed = false;
        for (const m of payload.slice(0, 500)) {
          if (typeof m.uri !== 'string' || !/^magnet:/i.test(m.uri)) continue;
          const info = { ...parseMagnet(m.uri), label: String(m.label || '').slice(0, 300), context: String(m.context || '').slice(0, 300) };
          const key = info.hash || info.uri;
          if (!this.magnets.has(key)) { this.magnets.set(key, info); changed = true; }
        }
        if (changed) this._emitState();
      } else if (channel === 'fontes:magnet-click' && payload && typeof payload.uri === 'string') {
        this._captureMagnet(payload.uri, 'clique', payload.label);
      }
    });
    wc.on('context-menu', (_e, params) => {
      if (params.linkURL && /^magnet:/i.test(params.linkURL)) this._captureMagnet(params.linkURL, 'clique', params.linkText);
    });
    this.view = view;
    return view;
  }

  _isTrusted(key) {
    const sites = this.getSettings().sources.sites || [];
    return sites.some((s) => { try { return siteKey(new URL(s.url).hostname) === key; } catch (_) { return false; } });
  }

  _captureMagnet(uri, origin, label) {
    const info = { ...parseMagnet(uri), label: label || '' };
    const key = info.hash || info.uri;
    if (!this.magnets.has(key)) this.magnets.set(key, info);
    this._emitState();
    this.emit('magnet', { ...info, origin });
  }

  _emitStateThrottled() {
    if (this._throttle) return;
    this._throttle = setTimeout(() => { this._throttle = null; this._emitState(); }, 600);
  }

  _emitState() {
    const wc = this.view && !this.view.webContents.isDestroyed() ? this.view.webContents : null;
    this.emit('state', {
      url: wc ? wc.getURL() : '',
      title: wc ? wc.getTitle() : '',
      loading: wc ? wc.isLoading() : false,
      canBack: wc ? wc.navigationHistory.canGoBack() : false,
      canForward: wc ? wc.navigationHistory.canGoForward() : false,
      magnets: [...this.magnets.values()],
      blocked: this.blockedCount,
      adblock: this.getSettings().sources.adblock !== false,
      visible: this.visible,
    });
  }

  async open(url) {
    const view = await this._ensureView();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    this.magnets.clear();
    this.show();
    view.webContents.loadURL(url).catch(() => { /* tratado em did-fail-load */ });
  }

  show() {
    if (!this.view || !this.win || this.win.isDestroyed()) return;
    if (!this.win.contentView.children.includes(this.view)) this.win.contentView.addChildView(this.view);
    this.visible = true;
    if (this.bounds) this.view.setBounds(this.bounds);
    this.view.setVisible(true);
    this._emitState();
  }

  hide() {
    this.visible = false;
    if (this.view) this.view.setVisible(false);
  }

  setBounds(b) {
    if (!b) return;
    this.bounds = { x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) };
    if (this.view && this.visible) this.view.setBounds(this.bounds);
  }

  nav(action, arg) {
    if (!this.view) return;
    const wc = this.view.webContents;
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    if (action === 'reload') wc.reload();
    if (action === 'stop') wc.stop();
    if (action === 'go' && arg) this.open(String(arg));
    if (action === 'allow' && arg) { this.allowOnce.add(arg); wc.loadURL(arg); }
  }

  async clearData() {
    const sess = this._session();
    await sess.clearStorageData();
    await sess.clearCache();
  }

  destroy() {
    try { if (this.view) this.view.webContents.close(); } catch (_) { /* ok */ }
    this.view = null;
  }
}

module.exports = { SourcesBrowser, parseMagnet, siteKey };
