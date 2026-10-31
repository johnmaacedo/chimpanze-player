'use strict';
// Sessão de reprodução: janela hospedeira (mpv embutido) + janela de controles sobreposta.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { BrowserWindow, screen, powerSaveBlocker, globalShortcut, app } = require('electron');
const { MpvIpc } = require('./mpv-ipc');
const { IS_WIN, mpvBinary, userDir, ensureDir, vsRuntime, asciiWorkDir } = require('./paths');
const VP = require('./video-profile');
const { MODELS: RTX_MODELS, processDims } = require('./rtx');
const W = require('./win32');

const OBSERVED = [
  'pause', 'time-pos', 'duration', 'volume', 'mute', 'track-list', 'eof-reached', 'idle-active',
  'paused-for-cache', 'seeking', 'demuxer-cache-state', 'video-params', 'speed', 'sid', 'aid',
  'estimated-vf-fps', 'display-fps', 'container-fps', 'hwdec-current', 'video-codec', 'frame-drop-count',
  'vo-delayed-frame-count', 'osd-dimensions', 'media-title', 'file-format', 'video-bitrate', 'audio-codec-name',
  'sub-delay', 'audio-delay', 'chapter-list', 'width', 'height', 'vo-configured', 'focused', 'video-dec-params',
  'window-minimized',
];
// Propriedades que mudam a cada quadro: vão para a interface agrupadas (no máx. ~10x por segundo).
const THROTTLED = new Set(['time-pos', 'demuxer-cache-state', 'estimated-vf-fps', 'frame-drop-count', 'vo-delayed-frame-count', 'display-fps']);
const THROTTLE_MS = 100;

class PlayerSession {
  /**
   * @param {object} ctx { settings, saveSettings, progress, saveProgress, library, onClosed, notifyMain, iconPath }
   * @param {object} req { itemId, episodeId?, file?, title?, start? }
   */
  constructor(ctx, req) {
    this.ctx = ctx;
    this.req = req;
    this.win = null;
    this.overlay = null;
    this.mode = 'window';
    this.mpv = null;
    this.ipc = null;
    this.state = {};
    this.closed = false;
    this.current = null; // { path, title, subtitle, itemId, episodeId }
    this.video = null;
    this.tune = {}; // ajustes automáticos de desempenho (só nesta sessão)
    this.appliedVf = null;
    this.appliedHwdec = null;
    this.statusFile = null;
    this.saveTimer = null;
    this.psbId = null;
    this.endHandled = false;
    this.videoHwnd = null; // janela do mpv ligada à dos controles (Windows)
    this._propQueue = new Map();
    this._propTimer = null;
    this.logFile = path.join(ensureDir(userDir('logs')), 'mpv.log');
  }

  // ---------- montagem ----------
  // Arquitetura: o mpv desenha o vídeo na própria janela nativa (sem bordas, fora da barra de tarefas)
  // e esta janela transparente do Electron fica exatamente por cima com os controles.
  // (Embutir o mpv dentro de uma janela do Chromium não funciona no Windows: o compositor do
  // Chromium cobre a imagem do vídeo.) No Windows as duas são ligadas pelo próprio sistema
  // (win32.js), então se comportam como uma janela só: um botão na barra de tarefas, um item no
  // Alt+Tab, sempre juntas na frente/atrás das outras janelas e movidas sem atraso.
  async open() {
    const s = this.ctx.settings();
    const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const wa = disp.workArea;
    const w = Math.round(wa.width * 0.8), h = Math.round(wa.height * 0.8);
    this.restoreBounds = { x: wa.x + Math.round((wa.width - w) / 2), y: wa.y + Math.round((wa.height - h) / 2), width: w, height: h };
    this.mode = s.player.fullscreen ? 'full' : 'window';
    const initial = this._targetBounds(disp);

    this.win = new BrowserWindow({
      ...initial,
      frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, thickFrame: false,
      resizable: false, maximizable: false, fullscreenable: false, minimizable: true,
      show: false, skipTaskbar: false, title: 'Chimpanzé Player', icon: this.ctx.iconPath,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'overlay-preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
      },
    });
    this.overlay = this.win;
    this.win.setMenu(null);
    this.win.on('focus', () => this._raise());
    this.win.on('move', () => this._scheduleSync());
    this.win.on('resize', () => this._scheduleSync());
    this.win.on('minimize', () => {
      if (this.videoHwnd) W.setVisible(this.videoHwnd, false);
      else if (this.ipc) this.ipc.safe('set_property', 'window-minimized', true);
    });
    this.win.on('restore', () => {
      this._filterAt = Date.now(); // dá um tempo antes de o auto-ajuste voltar a medir
      if (this.videoHwnd) {
        W.restoreTo(this.videoHwnd, this._physBounds());
        this._lastGeom = this._geometry();
        return;
      }
      if (this.ipc) this.ipc.safe('set_property', 'window-minimized', false);
      this._lastGeom = null;
      this._syncMpv();
      setTimeout(() => this._raise(), 120);
    });
    this.win.on('close', (e) => { if (!this.closed) { e.preventDefault(); this.close(); } });
    // Se o Windows destruir os controles junto com a janela do vídeo (mpv caiu), encerra direito.
    this.win.on('closed', () => { if (!this.closed) this._crashed(); });
    this._onDisplayChange = () => { if (!this.closed && this.mode !== 'window') this._setMode(this.mode); };
    screen.on('display-metrics-changed', this._onDisplayChange);
    // A interface carrega enquanto o mpv inicia (o vídeo abre mais rápido).
    const overlayLoaded = this.win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'))
      .catch((e) => console.error('[player] overlay', e.message));

    this.psbId = powerSaveBlocker.start('prevent-display-sleep');
    this._registerMediaKeys();

    // Tenta iniciar com a configuração ideal; se falhar, recua para opções mais conservadoras.
    let started = false;
    let lastErr = null;
    for (let level = 0; level <= 2 && !started && !this.closed; level++) {
      try {
        await this._startMpv(level);
        started = true;
        this.level = level;
        await overlayLoaded;
        if (level > 0) this._toast(level === 1 ? 'A placa NVIDIA não pôde ser selecionada diretamente; usando a GPU padrão do Windows.' : 'Modo de compatibilidade de vídeo ativado.', 'warn');
      } catch (err) {
        lastErr = err;
        console.error('[player] tentativa', level, err.message);
        this._killMpv();
      }
    }
    await overlayLoaded;
    if (this.closed || !this.win || this.win.isDestroyed()) return;
    this.win.show();
    this.win.focus();
    this._sendWindowState();
    if (!started) {
      this._toast('Falha ao iniciar o mecanismo de vídeo: ' + (lastErr ? lastErr.message : ''), 'error');
      return;
    }
    await this._raise();
    this._adaptTimer = setInterval(() => this._adaptTick(), 2000);
    this.video = VP.sanitizeVideo(this._videoFor(this.req.itemId));
    await this._loadRequest(this.req);
  }

  _targetBounds(disp) {
    if (this.mode === 'full') return { ...disp.bounds };
    if (this.mode === 'max') return { ...disp.workArea };
    return { ...this.restoreBounds };
  }

  _setMode(mode) {
    if (!this.win || this.win.isDestroyed()) return;
    if (this.mode === 'window' && mode !== 'window') this.restoreBounds = this.win.getBounds();
    if (mode === 'full' && this.mode !== 'full') this.prevMode = this.mode;
    this.mode = mode;
    const disp = screen.getDisplayMatching(this.win.getBounds());
    if (mode === 'window') {
      // Garante que a janela restaurada fique visível no monitor atual.
      const wa = disp.workArea;
      const r = this.restoreBounds;
      if (r.x + r.width < wa.x + 40 || r.x > wa.x + wa.width - 40 || r.y < wa.y - 10 || r.y > wa.y + wa.height - 40) {
        this.restoreBounds = { width: Math.min(r.width, wa.width), height: Math.min(r.height, wa.height), x: wa.x + Math.round((wa.width - Math.min(r.width, wa.width)) / 2), y: wa.y + Math.round((wa.height - Math.min(r.height, wa.height)) / 2) };
      }
    }
    this.win.setBounds(this._targetBounds(disp));
    this._syncMpv();
    this._sendWindowState();
    setTimeout(() => this._raise(), 60);
  }

  _sendWindowState() {
    this._send('player:window', { fullscreen: this.mode === 'full', maximized: this.mode === 'max' });
  }

  // Retângulo em pixels físicos (o mpv trabalha em pixels reais; o Electron em DIPs).
  _physBounds() {
    const b = this.win.getBounds();
    if (IS_WIN) {
      try { return screen.dipToScreenRect(this.win, b); } catch (_) { return b; }
    }
    return b;
  }

  _geometry() {
    const r = this._physBounds();
    return `${Math.max(1, Math.round(r.width))}x${Math.max(1, Math.round(r.height))}+${Math.round(r.x)}+${Math.round(r.y)}`;
  }

  _syncMpv() {
    if (this.closed || !this.ipc || !this.ipc.connected || !this.win || this.win.isDestroyed()) return;
    const g = this._geometry();
    if (g === this._lastGeom) return;
    this._lastGeom = g;
    if (this.videoHwnd && W.moveWindow(this.videoHwnd, this._physBounds())) return;
    this.ipc.safe('set_property', 'geometry', g);
  }

  _scheduleSync() {
    // Ligadas pelo Windows: move o vídeo no mesmo instante que os controles.
    if (this.videoHwnd) { this._syncMpv(); return; }
    if (this._syncTimer) return;
    this._syncTimer = setTimeout(() => { this._syncTimer = null; this._syncMpv(); }, 16);
  }

  // Coloca a janela do vídeo logo abaixo dos controles (sem deixá-las "sempre no topo").
  // Com as janelas ligadas pelo Windows isso já acontece sozinho.
  async _raise() {
    if (this.videoHwnd) return;
    if (this.closed || this._raising || !this.ipc || !this.ipc.connected || !this.win || this.win.isDestroyed()) return;
    this._raising = true;
    try {
      await this.ipc.safe('set_property', 'ontop', true);
      await this.ipc.safe('set_property', 'ontop', false);
      if (!this.win.isDestroyed()) this.win.moveTop();
    } finally {
      this._raising = false;
    }
  }

  _registerMediaKeys() {
    const map = {
      MediaPlayPause: () => this.command({ type: 'toggle-pause' }),
      MediaNextTrack: () => this.command({ type: 'next' }),
      MediaPreviousTrack: () => this.command({ type: 'prev' }),
      MediaStop: () => this.close(),
    };
    for (const [k, fn] of Object.entries(map)) {
      try { globalShortcut.register(k, fn); } catch (_) { /* tecla não disponível */ }
    }
  }

  _gpuInfoArgs(level) {
    const s = this.ctx.settings().player;
    const args = [];
    if (level >= 2) return args;
    if (IS_WIN) {
      const api = s.gpuApi === 'vulkan' ? 'vulkan' : 'd3d11';
      args.push(`--gpu-api=${api}`);
      if (api === 'd3d11') {
        args.push('--gpu-context=d3d11', '--d3d11-flip=yes', '--d3d11va-zero-copy=yes');
        if (level === 0 && s.forceNvidia && this.ctx.hasNvidia()) args.push('--d3d11-adapter=NVIDIA');
      } else {
        args.push('--gpu-context=winvk');
      }
    }
    return args;
  }

  // Liga a janela do mpv à dos controles (só Windows). Se falhar, segue o modo antigo (sincronia via IPC).
  async _linkWindows() {
    if (!IS_WIN || !W.available() || !this.win || this.win.isDestroyed()) return;
    let id = 0;
    for (let i = 0; i < 50 && !this.closed && this.ipc && this.ipc.connected; i++) {
      id = Number(await this.ipc.get('window-id').catch(() => 0)) || 0;
      if (id) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!id || this.closed || this.win.isDestroyed()) return;
    try {
      if (W.link(W.hwndOf(this.win), id)) {
        this.videoHwnd = id;
        this._lastGeom = null;
      }
    } catch (e) {
      console.error('[player] ligar janelas', e.message);
    }
  }

  _unlinkWindows() {
    if (!this.videoHwnd) return;
    this.videoHwnd = null;
    try { if (this.win && !this.win.isDestroyed()) W.unlink(W.hwndOf(this.win)); } catch (_) { /* ok */ }
  }

  _killMpv() {
    this._unlinkWindows();
    try { if (this.ipc) this.ipc.close(); } catch (_) { /* ok */ }
    this.ipc = null;
    const proc = this.mpv;
    this.mpv = null;
    if (proc && proc.exitCode === null) { try { proc.removeAllListeners('exit'); proc.kill(); } catch (_) { /* ok */ } }
  }

  async _startMpv(level = 0) {
    const s = this.ctx.settings();
    const pipeName = `chimpanze-mpv-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    this.socketPath = IS_WIN ? `\\\\.\\pipe\\${pipeName}` : path.join(require('os').tmpdir(), pipeName + '.sock');
    this.statusFile = path.join(ensureDir(path.join(asciiWorkDir(), 'vs')), `status-${process.pid}.txt`);
    try { fs.rmSync(this.statusFile, { force: true }); } catch (_) { /* ok */ }
    const p = s.player;
    const args = [
      `--input-ipc-server=${this.socketPath}`,
      `--geometry=${this._geometry()}`, '--force-window-position=yes', '--keepaspect-window=no',
      '--window-dragging=no', '--ontop=no', '--title=Chimpanzé Player',
      ...(IS_WIN ? ['--show-in-taskbar=no', '--auto-window-resize=no', '--window-corners=donotround', '--hidpi-window-scale=no', '--snap-window=no'] : []),
      '--no-config', '--idle=yes', '--keep-open=yes', '--force-window=yes',
      '--input-default-bindings=no', '--input-vo-keyboard=no', '--input-cursor=no', '--input-media-keys=no',
      '--osc=no', '--osd-level=0', '--osd-bar=no', '--border=no', '--load-scripts=no',
      level >= 2 ? '--vo=gpu' : '--vo=gpu-next', ...this._gpuInfoArgs(level),
      `--hwdec=${IS_WIN && level < 2 ? 'd3d11va' : 'auto-safe'}`,
      '--hwdec-codecs=all',
      `--scale=${p.scaler || 'ewa_lanczossharp'}`, '--cscale=ewa_lanczossharp', '--dscale=mitchell',
      '--correct-downscaling=yes', '--linear-downscaling=yes', '--sigmoid-upscaling=yes',
      '--hdr-compute-peak=auto', '--dither-depth=auto',
      '--hr-seek=yes', '--hr-seek-framedrop=no', '--save-position-on-quit=no',
      '--demuxer-max-bytes=512MiB', '--demuxer-max-back-bytes=128MiB', '--cache=yes',
      `--volume=${Math.max(0, Math.min(150, Number(p.volume) || 100))}`, '--volume-max=150',
      '--sub-auto=fuzzy', '--sub-file-paths=subs;Subs;legendas;Legendas;subtitles',
      '--sub-font-size=46', '--sub-border-size=2.5', '--sub-shadow-offset=1', '--sub-margin-y=48',
      '--audio-file-auto=fuzzy', '--alang=' + (p.audioLang || ''), '--slang=' + (p.subLang || 'pt-BR,pt,por,pob,ptb'),
      '--subs-with-matching-audio=no', '--screenshot-format=png',
      `--screenshot-directory=${ensureDir(path.join(app.getPath('pictures'), 'Chimpanze Player'))}`,
      '--cursor-autohide=no',
      `--log-file=${this.logFile}`, '--msg-level=all=info',
      ...(process.env.CHIMP_MPV_EXTRA ? process.env.CHIMP_MPV_EXTRA.split(' ').filter(Boolean) : []),
    ];
    if (!p.audioLang) args.splice(args.findIndex((a) => a.startsWith('--alang=')), 1);
    if (p.subLang === 'no') {
      args.splice(args.findIndex((a) => a.startsWith('--slang=')), 1);
      args.push('--sid=no');
    }

    const env = { ...process.env };
    const rt = vsRuntime();
    if (fs.existsSync(rt.vsscript)) {
      env.VSSCRIPT_PATH = rt.vsscript;
      env.PATH = `${rt.python}${path.delimiter}${env.PATH || ''}`;
      env.PYTHONNOUSERSITE = '1';
      delete env.PYTHONHOME; delete env.PYTHONPATH;
    }

    const proc = spawn(mpvBinary(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env });
    this.mpv = proc;
    let stderr = '';
    let exited = false;
    let ready = false;
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    proc.on('error', (e) => { exited = true; stderr += e.message; });
    proc.on('exit', (code) => {
      exited = true;
      if (this.mpv === proc) this._unlinkWindows();
      if (this.mpv === proc) this.mpv = null;
      if (ready && !this.closed) {
        this._toast(`O mecanismo de vídeo foi encerrado (código ${code}). ${stderr.split('\n').slice(-3).join(' ')}`, 'error');
        setTimeout(() => this.close(), 2500);
      }
    });

    this.ipc = new MpvIpc(this.socketPath);
    try {
      await this.ipc.connect(15000, () => !exited);
    } catch (e) {
      throw new Error((stderr.trim().split('\n').slice(-2).join(' ') || e.message).slice(0, 300));
    }
    ready = true;
    this.ipc.on('property', (name, value) => this._onProp(name, value));
    this.ipc.on('event', (ev, msg) => this._onEvent(ev, msg));
    this.ipc.on('close', () => { if (!this.closed && this.mpv === proc) this._crashed(); });
    for (const prop of OBSERVED) this.ipc.observe(prop);
    this._lastGeom = null;
    await this._linkWindows();
    this._syncMpv();
  }

  _videoFor(itemId) {
    const s = this.ctx.settings();
    if (itemId && s.videoProfiles && s.videoProfiles[itemId]) return { ...s.video, ...s.videoProfiles[itemId] };
    return s.video;
  }

  // ---------- carregamento ----------
  _resolve(req) {
    const lib = this.ctx.library;
    const item = req.itemId ? lib.data.items[req.itemId] : null;
    if (!item) {
      if (!req.file) throw new Error('Nada para reproduzir.');
      return { path: req.file, title: req.title || path.basename(req.file), subtitle: '', itemId: null, episodeId: null, episodes: [] };
    }
    const meta = item.meta || {};
    const showTitle = item.customTitle || meta.title || item.title;
    if (item.type === 'movie') {
      const f = req.file ? item.files.find((x) => x.path === req.file) || item.files[0] : item.files[0];
      return { path: f.path, title: showTitle, subtitle: meta.year || item.year ? String(meta.year || item.year) : '', itemId: item.id, episodeId: null, episodes: [], logo: meta.logo || null };
    }
    let ep = req.episodeId ? item.episodes.find((e) => e.id === req.episodeId) : null;
    if (!ep && req.file) ep = item.episodes.find((e) => e.path === req.file);
    if (!ep) ep = item.episodes[0];
    const em = (item.episodeMeta || {})[`${ep.season}x${ep.episode}`] || {};
    const label = ep.season === 0 ? `Especial ${ep.episode}` : `T${ep.season}:E${ep.episode}${ep.episodeEnd ? '-' + ep.episodeEnd : ''}`;
    return {
      path: ep.path, title: showTitle, subtitle: em.title ? `${label} · ${em.title}` : label,
      itemId: item.id, episodeId: ep.id, logo: meta.logo || null,
      episodes: item.episodes.map((e) => {
        const m = (item.episodeMeta || {})[`${e.season}x${e.episode}`] || {};
        return { id: e.id, season: e.season, episode: e.episode, episodeEnd: e.episodeEnd, title: m.title || '', still: m.still || null, path: e.path };
      }),
    };
  }

  async _loadRequest(req) {
    let cur;
    try { cur = this._resolve(req); } catch (e) { this._toast(e.message, 'error'); return; }
    if (!fs.existsSync(cur.path)) { this._toast('Arquivo não encontrado: ' + cur.path, 'error'); return; }
    this._saveProgressNow();
    this.current = cur;
    this.endHandled = false;
    this.state = {};
    // Ponto de retomada
    let start = req.start;
    if (start == null) {
      const pr = this.ctx.progress()[cur.path];
      if (pr && !pr.watched && pr.pos > 20 && (!pr.dur || pr.pos < pr.dur - 30)) start = Math.max(0, pr.pos - 3);
    }
    // "start" como opção global (compatível com qualquer versão do mpv); é zerado após carregar.
    await this.ipc.safe('set_property', 'start', start && start > 0 ? start.toFixed(2) : 'none');
    this._send('player:info', this._infoPayload(start));
    await this.ipc.safe('loadfile', cur.path, 'replace');
    if (this.win && !this.win.isDestroyed()) this.win.setTitle(`${cur.title}${cur.subtitle ? ' — ' + cur.subtitle : ''}`);
  }

  _infoPayload(resumeFrom) {
    const s = this.ctx.settings();
    const disp = this.win && !this.win.isDestroyed() ? screen.getDisplayMatching(this.win.getBounds()) : screen.getPrimaryDisplay();
    return {
      current: this.current,
      video: this.video,
      presets: Object.keys(VP.PRESETS),
      hasShowProfile: !!(this.current && this.current.itemId && s.videoProfiles[this.current.itemId]),
      rifeAvailable: VP.rifeAvailable(),
      rtx: this.ctx.rtx ? { installed: this.ctx.rtx.installed(), engines: this.ctx.rtx.status().engines, device: this.ctx.rtx.status().device } : null,
      tune: this.tune,
      isWindows: IS_WIN,
      displayHz: disp.displayFrequency || 60,
      displaySize: { w: Math.round(disp.size.width * disp.scaleFactor), h: Math.round(disp.size.height * disp.scaleFactor) },
      resumeFrom: resumeFrom || 0,
      autoNext: s.player.autoNext,
      skipSeconds: s.player.skipSeconds || 10,
      hasNext: !!this._neighbor(1),
      hasPrev: !!this._neighbor(-1),
    };
  }

  _neighbor(dir) {
    const c = this.current;
    if (!c || !c.episodes || !c.episodes.length) return null;
    const idx = c.episodes.findIndex((e) => e.id === c.episodeId);
    if (idx < 0) return null;
    return c.episodes[idx + dir] || null;
  }

  // ---------- eventos do mpv ----------
  _onProp(name, value) {
    this.state[name] = value;
    this._sendProp(name, value);
    // Só remonta o filtro quando a resolução de ORIGEM muda (a de saída muda por causa do próprio filtro
    // e causava um ciclo de destruir/recriar a IA a cada poucos segundos).
    if (name === 'video-dec-params' && value) {
      const k = `${value.w}x${value.h}`;
      if (k !== this._decKey) { this._decKey = k; this._applyFilters(false); }
    }
    if (name === 'eof-reached' && value === true) this._onEnd();
    // Se o usuário clicar na janela do vídeo, devolve o foco aos controles.
    if (name === 'focused' && value === true && this.win && !this.win.isDestroyed() && !this.win.isFocused()) this.win.focus();
    // Algo de fora minimizou só o vídeo (Win+M, outro programa): os controles somem junto e ficariam
    // sem botão na barra de tarefas. Minimiza o conjunto pelos controles, que têm o botão.
    if (name === 'window-minimized' && value === true && this.videoHwnd && this.win && !this.win.isDestroyed() && !this.win.isMinimized()) {
      this.win.minimize();
    }
    if (name === 'volume' && typeof value === 'number') {
      const s = this.ctx.settings();
      if (Math.round(s.player.volume) !== Math.round(value)) { s.player.volume = Math.round(value); this.ctx.saveSettings(); }
    }
  }

  _onEvent(ev) {
    if (ev === 'file-loaded') {
      this.endHandled = false;
      this.ipc.safe('set_property', 'start', 'none');
      this.appliedVf = null; // nova mídia: reaplica filtros
      this._applied = {};
      this._steps = 0;
      this._decKey = null;
      this.applyVideo(this.video, { silent: true });
      clearInterval(this.saveTimer);
      this.saveTimer = setInterval(() => this._saveProgressNow(), 5000);
      this._send('player:loaded', {});
      clearTimeout(this._voCheck);
      this._voCheck = setTimeout(() => this._checkVideoOutput(), 4500);
    }
    if (ev === 'end-file') this._saveProgressNow();
  }

  // Se a saída de vídeo não inicializou (driver/GPU), reinicia o mpv em modo mais compatível.
  async _checkVideoOutput() {
    if (this.closed || !this.ipc) return;
    const tracks = this.state['track-list'] || [];
    const hasVideo = tracks.some((t) => t.type === 'video' && !t.albumart);
    if (!hasVideo || this.state['vo-configured'] !== false) return;
    if ((this.level || 0) >= 2) { this._toast('Não foi possível iniciar a saída de vídeo. Verifique o driver da placa de vídeo.', 'error'); return; }
    const pos = Number(this.state['time-pos']) || 0;
    const next = (this.level || 0) + 1;
    this._toast('Ajustando o modo de vídeo para este computador…', 'warn');
    this._killMpv();
    try {
      await this._startMpv(next);
      this.level = next;
      await this._raise();
      this._applied = {};
      this.appliedVf = null;
      this.appliedHwdec = null;
      await this._loadRequest({ itemId: this.current.itemId, episodeId: this.current.episodeId, file: this.current.path, start: pos });
    } catch (e) {
      this._toast('Falha ao reiniciar o vídeo: ' + e.message, 'error');
    }
  }

  _onEnd() {
    if (this.endHandled) return;
    this.endHandled = true;
    this._saveProgressNow(true);
    const next = this._neighbor(1);
    this._send('player:ended', { next: next ? { id: next.id, season: next.season, episode: next.episode, title: next.title, still: next.still } : null, autoNext: this.ctx.settings().player.autoNext });
  }

  _saveProgressNow(forceWatched = false) {
    const c = this.current;
    if (!c) return;
    const pos = Number(this.state['time-pos']);
    const dur = Number(this.state.duration);
    if (!Number.isFinite(pos) || !Number.isFinite(dur) || dur <= 0) return;
    const remaining = dur - pos;
    const watched = forceWatched || pos / dur > 0.93 || (dur > 600 && remaining < 90);
    const prog = this.ctx.progress();
    const prev = prog[c.path] || {};
    if (Math.abs((prev.pos || 0) - pos) < 1 && prev.watched === watched) return;
    prog[c.path] = { pos: watched ? dur : pos, dur, t: Date.now(), watched, itemId: c.itemId, episodeId: c.episodeId };
    this.ctx.saveProgress();
  }

  // ---------- vídeo / imagem ----------
  // Configuração efetiva = escolhas do usuário + ajustes automáticos de desempenho.
  _effective() { return VP.sanitizeVideo({ ...this.video, ...this.tune }); }

  async applyVideo(v, { silent = false } = {}) {
    if (!this.ipc || !this.ipc.connected) return;
    this.video = VP.sanitizeVideo(v);
    const eff = this._effective();
    const ipc = this.ipc;
    if (!this._applied) this._applied = {};
    // Só envia ao mpv o que realmente mudou (evita reinicializações desnecessárias).
    const setIf = (k, val) => {
      const key = JSON.stringify(val);
      if (this._applied[k] === key) return Promise.resolve();
      this._applied[k] = key;
      return ipc.safe('set_property', k, val);
    };
    for (const k of ['brightness', 'contrast', 'saturation', 'gamma', 'hue']) setIf(k, eff[k]);
    setIf('deband', eff.deband);
    await setIf('glsl-shaders', VP.shaderList(eff));
    await setIf('glsl-shader-opts', VP.shaderOpts(eff));
    const mp = VP.motionProps(eff);
    for (const [k, val] of Object.entries(mp)) setIf(k, val);
    await this._applyFilters(true, silent);
    this._send('player:video', this.video);
    this._send('player:tune', { tune: this.tune, effective: eff });
  }

  // Decide o motor de IA (RTX/Vulkan) e a resolução de trabalho.
  _rifeCtx(eff, w, h, silent) {
    const rtx = this.ctx.rtx;
    const rtxInstalled = !!(rtx && rtx.installed());
    const wantRtx = eff.aiEngine === 'rtx' || (eff.aiEngine === 'auto' && rtxInstalled);
    if (!w || !h) return { wait: true };
    if (wantRtx && rtxInstalled) {
      const modelKey = eff.rifeModel;
      if (rtx.engineReady(modelKey)) {
        const d = rtx.dirs();
        const info = rtx.engineInfo(modelKey) || {};
        return {
          engine: 'rtx',
          dims: processDims(w, h, eff.aiRes, 'rtx'),
          rtx: { dir: d.base, dll: d.dll, engines: d.engines, cuda: d.cuda, model: RTX_MODELS[modelKey], fp16: info.fp16 !== false },
        };
      }
      if (!this._buildAsked) this._buildAsked = new Set();
      if (!this._buildAsked.has(modelKey)) {
        this._buildAsked.add(modelKey);
        this._toast('Otimizando a IA RTX para a sua placa (só na primeira vez, leva alguns minutos). Enquanto isso, o vídeo toca no original.', 'info');
        rtx.ensureEngine(modelKey)
          .then(() => { if (!this.closed) { this._toast('IA RTX pronta! Aplicando…', 'ok'); this._applyFilters(true, false); } })
          .catch((e) => { if (!this.closed) this._toast('Não foi possível otimizar a IA RTX: ' + e.message + ' Reproduzindo no original.', 'warn'); });
      }
    }
    // Vulkan só quando o usuário escolher. Sem RTX pronto, toca no original (o Vulkan trava em 1080p).
    if (eff.aiEngine !== 'vulkan') {
      if (!silent && !rtxInstalled && !this._rtxWarned) {
        this._rtxWarned = true;
        this._toast(rtx && rtx.busy ? 'O motor de 60 FPS ainda está sendo preparado. Até lá, o vídeo toca no original.' : 'Motor de 60 FPS (RTX) indisponível. Reproduzindo no original.', 'info');
      }
      return { off: true };
    }
    return { engine: 'vulkan', dims: processDims(w, h, eff.aiRes, 'vulkan') };
  }

  async _applyFilters(force, silent = true) {
    if (!this.ipc || !this.ipc.connected || !this.video) return;
    const eff = this._effective();
    const dec = this.state['video-dec-params'];
    const srcW = dec && (dec.dw || dec.w);
    const srcH = dec && (dec.dh || dec.h);
    const osd = this.state['osd-dimensions'];
    let displayH = 0;
    if (this.win && !this.win.isDestroyed()) {
      const d = screen.getDisplayMatching(this.win.getBounds());
      displayH = Math.round(d.size.height * d.scaleFactor);
    }
    let rife = null;
    let effForVf = eff;
    if (eff.motion === 'rife') {
      rife = this._rifeCtx(eff, srcW, srcH, silent);
      if (rife.wait || rife.off) { rife = null; effForVf = { ...eff, motion: 'off' }; }
    }
    // A altura que chega ao upscale da NVIDIA é a de saída da IA (pode ter sido reduzida).
    const videoH = rife && rife.dims && rife.dims.scaled ? rife.dims.h : srcH;
    // Arredonda para evitar recriar o filtro a cada pixel de redimensionamento.
    const dispBucket = displayH ? Math.round(displayH / 60) * 60 : 0;
    const { vf, hwdec, notes } = VP.buildFilters(effForVf, { videoH, displayH: dispBucket, rife }, this.statusFile);
    if (!force && vf === this.appliedVf) return;
    if (hwdec !== this.appliedHwdec) {
      this.appliedHwdec = hwdec;
      await this.ipc.safe('set_property', 'hwdec', hwdec);
    }
    if (vf !== this.appliedVf) {
      this.appliedVf = vf;
      this._filterAt = Date.now();
      this._lastDrop = null;
      try {
        await this.ipc.command('set_property', 'vf', vf);
      } catch (e) {
        this.appliedVf = '';
        await this.ipc.safe('set_property', 'vf', '');
        if (!silent) this._toast('Não foi possível aplicar o filtro de vídeo: ' + e.message, 'warn');
      }
      if (rife) this._watchRifeStatus();
    }
    if (!silent) for (const n of notes) this._toast(n, 'warn');
  }

  // ---------- auto-ajuste de desempenho da IA ----------
  _adaptTick() {
    if (this.closed || !this.video) return;
    const st = this.state;
    const eff = this._effective();
    // Só quadros realmente perdidos. "Atrasados" (vo-delayed-frame-count) ficam em ~10/s com a IA a
    // 60 FPS num monitor de alta taxa mesmo com a placa folgada (é efeito da sincronia com o monitor),
    // e contá-los fazia o auto-ajuste desligar a IA em todo vídeo depois de ~40 s.
    const drops = Number(st['frame-drop-count'] || 0);
    // Minimizado/oculto o mpv não exibe quadros: isso não é lentidão da placa.
    const hidden = !this.win || this.win.isDestroyed() || this.win.isMinimized() || !this.win.isVisible() || st['window-minimized'];
    const idle = hidden || eff.motion !== 'rife' || !eff.aiAdaptive || st.pause || st['paused-for-cache'] || st.seeking || st['eof-reached'];
    if (idle || this._lastDrop == null || Date.now() - (this._filterAt || 0) < 15000 || (this._steps || 0) >= 3) {
      this._lastDrop = drops;
      this._bad = 0;
      return;
    }
    const delta = drops - this._lastDrop;
    this._lastDrop = drops;
    const vfFps = Number(st['estimated-vf-fps']) || 0;
    const target = eff.targetFps || Number(st['display-fps']) || 60;
    const slow = delta >= 4 || (vfFps > 0 && vfFps < target * 0.85);
    this._bad = slow ? (this._bad || 0) + 1 : Math.max(0, (this._bad || 0) - 1);
    if (this._bad >= 3) {
      this._bad = 0;
      this._steps = (this._steps || 0) + 1;
      this._stepDown();
    }
  }

  _stepDown() {
    const eff = this._effective();
    const t = this.tune;
    const dec = this.state['video-dec-params'] || {};
    const h = dec.dh || dec.h || 0;
    const procH = processDims(dec.dw || dec.w, h, eff.aiRes, 'vulkan');
    let msg = null;
    if (eff.upscaler.startsWith('anime4k') && eff.anime4kQuality === 'hq') { t.anime4kQuality = 'fast'; msg = 'Anime4K passou para o modo leve.'; }
    // No motor RTX, trocar de modelo exigiria otimizar outro (minutos): mexe em FPS/resolução antes.
    const rtxOn = !!(this.ctx.rtx && this.ctx.rtx.installed() && eff.aiEngine !== 'vulkan');
    if (msg) { /* já decidido */ }
    else if (!rtxOn && eff.rifeModel === 'quality') { t.rifeModel = 'balanced'; msg = 'IA trocada para o modelo equilibrado.'; }
    else if (procH && procH.h > 1080 && eff.aiRes !== '720' && eff.aiRes !== '1080') { t.aiRes = '1080'; msg = 'A IA passou a trabalhar em 1080p.'; }
    else if (!rtxOn && eff.rifeModel === 'balanced') { t.rifeModel = 'fast'; msg = 'IA trocada para o modelo rápido.'; }
    else if (procH && procH.h > 720 && eff.aiRes !== '720') { t.aiRes = '720'; msg = 'A IA passou a trabalhar em 720p (a imagem final continua sendo ampliada).'; }
    else if (eff.upscaler.startsWith('anime4k')) { t.upscaler = 'none'; msg = 'Anime4K desligado para liberar a placa.'; }
    else { t.motion = 'off'; msg = 'A placa não acompanhou 60 FPS neste vídeo; voltei para o original.'; }
    this._filterAt = Date.now();
    this._toast('Auto-ajuste: ' + msg, 'warn');
    this.applyVideo(this.video, { silent: true });
  }

  _watchRifeStatus() {
    clearTimeout(this._rifeTimer);
    let tries = 0;
    const check = () => {
      tries++;
      let txt = '';
      try { txt = fs.readFileSync(this.statusFile, 'utf8'); } catch (_) { /* ainda não existe */ }
      if (txt) {
        const [kind, msg] = txt.split('|');
        if (kind === 'erro') this._toast('Interpolação por IA indisponível: ' + msg + ' — reproduzindo sem interpolação.', 'warn');
        else if (kind === 'ok') this._toast('Interpolação por IA ativa: ' + msg, 'ok');
        else if (kind === 'passthrough') this._toast(msg, 'info');
        try { fs.rmSync(this.statusFile, { force: true }); } catch (_) { /* ok */ }
        return;
      }
      if (tries < 40) this._rifeTimer = setTimeout(check, 500);
    };
    try { fs.rmSync(this.statusFile, { force: true }); } catch (_) { /* ok */ }
    this._rifeTimer = setTimeout(check, 600);
  }

  // ---------- comandos vindos da interface ----------
  async command(cmd) {
    if (this.closed) return null;
    const ipc = this.ipc;
    const st = this.state;
    switch (cmd.type) {
      case 'toggle-pause':
        if (st['eof-reached']) { await ipc.safe('seek', 0, 'absolute'); return ipc.safe('set_property', 'pause', false); }
        return ipc.safe('cycle', 'pause');
      case 'set-pause': return ipc.safe('set_property', 'pause', !!cmd.value);
      case 'seek-rel': return ipc.safe('seek', Number(cmd.sec) || 0, 'relative+exact');
      case 'seek-abs': return ipc.safe('seek', Math.max(0, Number(cmd.sec) || 0), 'absolute+exact');
      case 'seek-frame': return ipc.safe(cmd.dir < 0 ? 'frame-back-step' : 'frame-step');
      case 'set-volume': return ipc.safe('set_property', 'volume', Math.max(0, Math.min(150, Number(cmd.value))));
      case 'add-volume': return ipc.safe('add', 'volume', Number(cmd.value) || 0);
      case 'toggle-mute': return ipc.safe('cycle', 'mute');
      case 'set-track': return ipc.safe('set_property', cmd.kind, cmd.id === 'no' ? 'no' : Number(cmd.id));
      case 'cycle-sub': return ipc.safe('cycle', 'sid');
      case 'cycle-audio': return ipc.safe('cycle', 'aid');
      case 'set-speed': return ipc.safe('set_property', 'speed', Math.max(0.25, Math.min(4, Number(cmd.value) || 1)));
      case 'sub-delay': return ipc.safe('add', 'sub-delay', Number(cmd.value) || 0);
      case 'audio-delay': return ipc.safe('add', 'audio-delay', Number(cmd.value) || 0);
      case 'screenshot': await ipc.safe('screenshot', 'video'); return this._toast('Captura salva em Imagens › Chimpanze Player', 'ok');
      case 'next': { const n = this._neighbor(1); if (n) return this._loadRequest({ itemId: this.current.itemId, episodeId: n.id }); return null; }
      case 'prev': { const n = this._neighbor(-1); if (n) return this._loadRequest({ itemId: this.current.itemId, episodeId: n.id }); return null; }
      case 'play-episode': return this._loadRequest({ itemId: this.current.itemId, episodeId: cmd.id, start: cmd.start });
      case 'restart': return ipc.safe('seek', 0, 'absolute');
      case 'fullscreen': {
        const want = cmd.value == null ? this.mode !== 'full' : !!cmd.value;
        if (want && this.mode !== 'full') this._setMode('full');
        else if (!want && this.mode === 'full') this._setMode(this.prevMode === 'max' ? 'max' : 'window');
        return null;
      }
      case 'minimize': return this.win.minimize();
      case 'maximize': return this._setMode(this.mode === 'window' ? 'max' : 'window');
      case 'drag': {
        if (this.mode !== 'window') return null;
        const b = this.win.getBounds();
        const nb = { x: Math.round(b.x + cmd.dx), y: Math.round(b.y + cmd.dy), width: b.width, height: b.height };
        this.win.setBounds(nb);
        this.restoreBounds = nb;
        return null;
      }
      case 'resize': {
        if (this.mode !== 'window') return null;
        const b = this.win.getBounds();
        const nb = { x: b.x, y: b.y, width: Math.max(480, Math.round(b.width + cmd.dw)), height: Math.max(270, Math.round(b.height + cmd.dh)) };
        this.win.setBounds(nb);
        this.restoreBounds = nb;
        return null;
      }
      case 'set-video': {
        for (const k of Object.keys(cmd.patch || {})) delete this.tune[k];
        if ('motion' in (cmd.patch || {}) || 'aiEngine' in (cmd.patch || {})) this.tune = {};
        return this.applyVideo({ ...this.video, ...cmd.patch });
      }
      case 'preset': {
        const p = VP.PRESETS[cmd.name];
        if (!p) return null;
        // Presets não mexem em fluidez se o usuário já escolheu algo (exceto "fluido").
        this.tune = {};
        const keepMotion = cmd.name === 'fluido' ? {} : { motion: this.video.motion, targetFps: this.video.targetFps, rifeModel: this.video.rifeModel };
        return this.applyVideo({ ...p, ...keepMotion });
      }
      case 'save-video-show': {
        const s = this.ctx.settings();
        if (!this.current || !this.current.itemId) return null;
        s.videoProfiles[this.current.itemId] = { ...this.video };
        this.ctx.saveSettings();
        this._send('player:info', this._infoPayload(0));
        return this._toast('Ajustes salvos para este título.', 'ok');
      }
      case 'clear-video-show': {
        const s = this.ctx.settings();
        if (this.current && this.current.itemId) delete s.videoProfiles[this.current.itemId];
        this.ctx.saveSettings();
        await this.applyVideo(s.video);
        this._send('player:info', this._infoPayload(0));
        return this._toast('Este título voltou a usar o padrão.', 'ok');
      }
      case 'save-video-default': {
        const s = this.ctx.settings();
        s.video = { ...this.video };
        this.ctx.saveSettings();
        return this._toast('Ajustes salvos como padrão para todos os vídeos.', 'ok');
      }
      case 'reset-video': {
        this.tune = {};
        const keep = { motion: this.video ? this.video.motion : 'rife' };
        return this.applyVideo({ ...VP.DEFAULT_VIDEO, ...keep });
      }
      case 'auto-next': {
        const s = this.ctx.settings();
        s.player.autoNext = !!cmd.value;
        this.ctx.saveSettings();
        return null;
      }
      case 'close': return this.close();
      case 'get-info': return this._infoPayload(0);
      default: return null;
    }
  }

  _send(channel, payload) {
    try {
      const w = this.win;
      if (!w || w.isDestroyed()) return;
      const wc = w.webContents;
      if (!wc || wc.isDestroyed()) return;
      wc.send(channel, payload);
    } catch (_) { /* janela fechando */ }
  }

  // O mpv fechou sozinho: a janela dos controles some junto, então o aviso vai para a biblioteca.
  _crashed() {
    if (this.closed) return;
    if (this.ctx.notice) this.ctx.notice('O vídeo foi interrompido porque o mecanismo de vídeo fechou inesperadamente. Tente abrir de novo.', 'error');
    this.close();
  }

  _sendProp(name, value) {
    if (!THROTTLED.has(name)) { this._send('player:prop', { name, value }); return; }
    this._propQueue.set(name, value);
    if (this._propTimer) return;
    this._propTimer = setTimeout(() => {
      this._propTimer = null;
      for (const [n, v] of this._propQueue) this._send('player:prop', { name: n, value: v });
      this._propQueue.clear();
    }, THROTTLE_MS);
  }

  _toast(text, level = 'info') { this._send('player:toast', { text, level }); }

  close() {
    if (this.closed) return;
    this._saveProgressNow();
    this.closed = true;
    clearInterval(this.saveTimer);
    clearInterval(this._adaptTimer);
    clearTimeout(this._rifeTimer);
    clearTimeout(this._voCheck);
    clearTimeout(this._propTimer);
    // Solta os controles antes de o mpv fechar (o Windows destruiria a janela junto).
    this._unlinkWindows();
    try { for (const k of ['MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop']) globalShortcut.unregister(k); } catch (_) { /* ok */ }
    if (this.psbId != null) { try { powerSaveBlocker.stop(this.psbId); } catch (_) { /* ok */ } }
    const proc = this.mpv;
    if (this.ipc) {
      this.ipc.command('quit').catch(() => {});
      setTimeout(() => this.ipc && this.ipc.close(), 300);
    }
    setTimeout(() => { if (proc && proc.exitCode === null) { try { proc.kill(); } catch (_) { /* ok */ } } }, 1500);
    clearTimeout(this._syncTimer);
    try { screen.removeListener('display-metrics-changed', this._onDisplayChange); } catch (_) { /* ok */ }
    try { if (this.win && !this.win.isDestroyed()) { this.win.removeAllListeners(); this.win.destroy(); } } catch (_) { /* ok */ }
    this.ctx.onClosed(this);
  }
}

module.exports = { PlayerSession };
