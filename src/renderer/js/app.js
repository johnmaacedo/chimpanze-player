'use strict';
/* Núcleo da interface: estado, navegação e dados derivados */
(function (App) {
  const { h } = App;

  App.state = {
    settings: null, library: { folders: [], items: [], scanning: false }, progress: {}, itemsById: {},
    view: 'home', params: {}, browse: {}, scan: {}, detailOpen: false, modalOpen: false, gpu: {}, version: '',
  };

  // ---------- eventos internos ----------
  const listeners = new Map();
  App.on = (ev, fn) => { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); };
  App.off = (ev, fn) => { const s = listeners.get(ev); if (s) s.delete(fn); };
  App.emit = (ev, data) => {
    if (ev === 'modal-opened') App.state.modalOpen = true;
    if (ev === 'modal-closed') App.state.modalOpen = false;
    const s = listeners.get(ev);
    if (s) [...s].forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } });
  };

  // ---------- dados ----------
  App.allItems = () => App.state.library.items;

  function indexItems() {
    App.state.itemsById = {};
    for (const it of App.state.library.items) App.state.itemsById[it.id] = it;
  }

  // Determina onde continuar um título.
  App.resumeInfo = function (item) {
    const prog = App.state.progress;
    if (item.type === 'movie') {
      const f = item.files[0];
      const p = prog[f.path];
      if (p && !p.watched && p.pos > 10 && p.dur) return { path: f.path, progress: p.pos / p.dur, cta: `Continuar (${App.fmtTime(p.pos)})`, t: p.t };
      if (p && p.watched) return { path: f.path, progress: 0, cta: 'Assistir de novo', t: p.t, watched: true };
      return null;
    }
    let last = null;
    for (const ep of item.episodes) {
      const p = prog[ep.path];
      if (p && p.t && (!last || p.t > last.p.t)) last = { ep, p };
    }
    if (!last) return item.episodes.length ? { episode: item.episodes[0], path: item.episodes[0].path, progress: 0, cta: `Assistir ${App.epLabel(item.episodes[0])}` } : null;
    if (!last.p.watched && last.p.pos > 10) {
      return { episode: last.ep, path: last.ep.path, progress: last.p.dur ? last.p.pos / last.p.dur : 0, cta: `Continuar ${App.epLabel(last.ep)}`, t: last.p.t };
    }
    if (!last.p.watched) {
      // Episódio aberto mas mal começado: continua nele.
      return { episode: last.ep, path: last.ep.path, progress: 0, cta: `Assistir ${App.epLabel(last.ep)}`, t: last.p.t, isNext: true };
    }
    const idx = item.episodes.indexOf(last.ep);
    const next = item.episodes.slice(idx + 1).find((e) => !(prog[e.path] && prog[e.path].watched));
    if (next) return { episode: next, path: next.path, progress: 0, cta: `Assistir ${App.epLabel(next)}`, t: last.p.t, isNext: true };
    return { episode: item.episodes[0], path: item.episodes[0].path, progress: 0, cta: 'Assistir de novo', t: last.p.t, watched: true };
  };

  App.continueEntries = function () {
    const out = [];
    for (const item of App.allItems()) {
      const r = App.resumeInfo(item);
      if (!r || !r.t || r.watched) continue;
      if (r.progress <= 0 && !r.isNext) continue;
      out.push({
        item, episode: r.episode, path: r.path, progress: r.progress, t: r.t,
        label: r.episode ? `${r.isNext ? 'Próximo: ' : ''}${App.epLabel(r.episode)}${epTitle(item, r.episode)}` : (r.progress ? `${Math.round(r.progress * 100)}% assistido` : ''),
        badge: null,
      });
    }
    return out.sort((a, b) => b.t - a.t).slice(0, 20);
  };

  function epTitle(item, ep) {
    const m = (item.episodeMeta || {})[`${ep.season}x${ep.episode}`];
    return m && m.title ? ` · ${m.title}` : '';
  }

  App.cardState = function (item) {
    const prog = App.state.progress;
    if (item.type === 'movie') {
      const p = prog[item.files[0].path];
      if (!p) return {};
      if (p.watched) return { watched: true };
      return p.dur ? { progress: p.pos / p.dur } : {};
    }
    const all = item.episodes.length && item.episodes.every((e) => prog[e.path] && prog[e.path].watched);
    return all ? { watched: true } : {};
  };

  // ---------- ações ----------
  App.play = function (req) {
    window.chimp.play(req).catch((e) => App.toast(e.message, 'error'));
  };

  App.playItem = function (item, opts = {}) {
    const r = App.resumeInfo(item);
    if (item.type === 'movie') {
      App.play({ itemId: item.id, file: item.files[0].path, start: opts.fromStart || (r && r.watched) ? 0 : undefined });
      return;
    }
    const ep = r && r.episode ? r.episode : item.episodes[0];
    App.play({ itemId: item.id, episodeId: ep.id, start: opts.fromStart || (r && r.watched) ? 0 : undefined });
  };

  App.pickFolder = async function () {
    try {
      const r = await window.chimp.library.pickFolder();
      if (r) {
        App.state.library.folders = r;
        App.toast('Pasta adicionada. Procurando seus vídeos…', 'ok');
        App.state.settings.firstRun = false;
        render();
      }
    } catch (e) { App.toast(e.message, 'error'); }
  };

  // ---------- navegação ----------
  App.navigate = function (view, params = {}) {
    if (App.state.detailOpen) App.closeDetail();
    App.closeMenu();
    if (App.state.view === 'sources' && view !== 'sources') App.leaveSources();
    if (App.state.view === 'downloads' && view !== 'downloads') App.stopDownloads();
    App.state.view = view;
    App.state.params = params;
    if (view !== 'search') { const si = document.getElementById('search-input'); if (si && document.activeElement !== si) si.value = ''; }
    render(true);
  };

  function render(resetScroll) {
    const root = document.getElementById('view');
    const keep = resetScroll ? 0 : root.scrollTop;
    App.stopHero && App.stopHero();
    root.replaceChildren();
    const v = App.state.view;
    document.querySelectorAll('#tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.nav === v));
    try {
      if (v === 'home') App.views.home(root);
      else if (v === 'series' || v === 'anime' || v === 'movie') App.views.browse(root, v);
      else if (v === 'search') App.views.search(root, App.state.params.q || '');
      else if (v === 'downloads') App.views.downloads(root);
      else if (v === 'sources') App.views.sources(root, App.state.params);
      else if (v === 'settings') App.views.settings(root, App.state.params);
    } catch (err) {
      console.error(err);
      root.append(h('div', { class: 'page' }, h('div', { class: 'empty' }, h('h2', null, 'Algo deu errado nesta tela'), h('p', null, String(err.message || err)))));
    }
    root.scrollTop = keep;
    updateTopbar();
  }
  App.render = render;

  // Re-renderiza telas dependentes da biblioteca sem perder a rolagem.
  const softRender = App.debounce(() => {
    const v = App.state.view;
    if (['home', 'series', 'anime', 'movie', 'search'].includes(v) || (v === 'settings' && (App.state.params.section || App.state.settingsSection) === 'library')) {
      if (!App.state.modalOpen) render(false);
    }
    if (App.state.detailOpen) App.refreshDetail();
  }, 350);

  function updateTopbar() {
    const root = document.getElementById('view');
    document.getElementById('topbar').classList.toggle('solid', root.scrollTop > 40 || !['home'].includes(App.state.view));
  }

  function updateScanPill() {
    const pill = document.getElementById('scan-pill');
    const lib = App.state.library;
    const scanning = lib.scanning;
    const pending = lib.pending || 0;
    pill.hidden = !(scanning || pending);
    const txt = document.getElementById('scan-text');
    if (scanning) txt.textContent = `Procurando vídeos… ${App.state.scan.count || ''}`;
    else if (pending) txt.textContent = `Buscando capas (${pending})`;
  }

  // Preparação automática do motor de 60 FPS (aparece só enquanto roda).
  function wireRtxPill() {
    const pill = document.getElementById('rtx-pill');
    const txt = document.getElementById('rtx-text');
    if (!pill) return;
    pill.onclick = () => App.navigate('settings', { section: 'video' });
    const show = (label) => { pill.hidden = !label; if (label) txt.textContent = label; };
    window.chimp.on('rtx:progress', (p) => {
      if (!p || p.done || p.pct < 0) return show(null);
      const pct = p.pct > 0 ? ` ${Math.round(p.pct)}%` : '';
      show(`60 FPS: preparando${pct}`);
    });
    window.chimp.on('rtx:build', (b) => { if (b && b.phase === 'start') show('60 FPS: otimizando a IA…'); else if (b && b.phase) show(null); });
  }

  // ---------- inicialização ----------
  async function init() {
    try { wireRtxPill(); } catch (_) { /* ok */ }
    const s = await window.chimp.state();
    App.state.settings = s.settings;
    App.state.library = s.library;
    App.state.progress = s.progress || {};
    App.state.gpu = s.gpu || {};
    App.state.version = s.version;
    App.state.rifeAvailable = s.rifeAvailable;
    App.state.defaultVideo = s.defaultVideo;
    indexItems();
    if (s.platform !== 'win32') document.body.classList.add('not-win');

    window.chimp.on('library:updated', (lib) => {
      const wasEmpty = !App.state.library.items.length;
      App.state.library = lib;
      indexItems();
      updateScanPill();
      if (wasEmpty && lib.items.length && App.state.view === 'home') render(true); else softRender();
    });
    window.chimp.on('library:scan', (p) => {
      App.state.scan = p;
      if (p.phase === 'scan') App.state.library.scanning = !p.done;
      if (p.phase === 'done') App.state.library.scanning = false;
      updateScanPill();
      if (App.state.view === 'home' && !App.state.library.items.length) softRender();
    });
    window.chimp.on('progress:updated', (p) => { App.state.progress = p; softRender(); });
    window.chimp.on('sources:external-magnet', (m) => { App.addTorrentDialog(m); });
    // Ao terminar um download: pede para confirmar o título identificado.
    window.chimp.on('library:confirm', (c) => {
      const go = (tries) => {
        if (App.state.itemsById[c.itemId]) App.confirmIdentity(c.itemId, { torrentName: c.torrentName });
        else if (tries > 0) setTimeout(() => go(tries - 1), 700);
      };
      setTimeout(() => go(10), 600);
    });
    window.chimp.on('notice', (n) => App.toast(n.text, n.level || 'info', n.allowUrl ? { actions: [{ label: 'Permitir uma vez', run: () => window.chimp.sources.nav('allow', n.allowUrl) }] } : {}));
    window.chimp.on('sources:torrent-file', ({ file, name }) => App.addTorrentDialog({ file, name: (name || '').replace(/\.torrent$/i, '') }));
    window.chimp.on('torrent:completed', () => { if (App.state.view === 'downloads') { /* a própria tela atualiza */ } });
    window.chimp.on('window:state', (st) => document.body.classList.toggle('maximized', !!st.maximized));
    window.chimp.on('player:closed', () => softRender());

    // Barra superior
    document.querySelectorAll('[data-nav]').forEach((el) => el.addEventListener('click', () => App.navigate(el.dataset.nav)));
    document.querySelectorAll('[data-win]').forEach((el) => el.addEventListener('click', () => window.chimp.win(el.dataset.win)));
    document.getElementById('topbar').addEventListener('dblclick', (e) => { if (e.target.id === 'topbar' || e.target.classList.contains('tabs')) window.chimp.win('maximize'); });
    const si = document.getElementById('search-input');
    si.addEventListener('input', App.debounce(() => {
      const q = si.value.trim();
      if (q) { App.state.view = 'search'; App.state.params = { q }; if (App.state.detailOpen) App.closeDetail(); render(true); }
      else if (App.state.view === 'search') App.navigate('home');
    }, 250));
    document.getElementById('view').addEventListener('scroll', updateTopbar, { passive: true });

    // Teclado
    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
      if (e.key === 'Escape') {
        if (App.topModal()) { App.topModal().close(); return; }
        App.closeMenu();
        if (App.state.detailOpen) { App.closeDetail(); return; }
        if (typing) document.activeElement.blur();
      }
      if (!typing && (e.key === '/' || (e.ctrlKey && e.key.toLowerCase() === 'f'))) { e.preventDefault(); si.focus(); si.select(); }
      if (e.key === 'F11') { e.preventDefault(); window.chimp.win('fullscreen'); }
    });
    // Arrastar arquivos de vídeo para a janela: reproduz direto.
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      const p = window.chimp.shell.pathForFile(f);
      if (/\.torrent$/i.test(p)) App.addTorrentDialog({ file: p, name: f.name.replace(/\.torrent$/i, '') });
      else if (p) App.play({ file: p, title: f.name.replace(/\.[^.]+$/, '') });
    });
    // Colar magnet em qualquer lugar.
    document.addEventListener('paste', async (e) => {
      if (/^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName)) return;
      const t = (e.clipboardData && e.clipboardData.getData('text')) || '';
      if (/^magnet:\?/i.test(t.trim())) App.addTorrentDialog(await window.chimp.sources.parseMagnet(t.trim()));
    });

    updateScanPill();
    render(true);
    window.chimp.ready().catch(() => {});
    // Atualiza contagem de downloads periodicamente.
    const badge = async () => {
      try { const list = await window.chimp.torrent.list(); App.setDownloadBadge(list.filter((t) => !t.done && !t.paused).length); } catch (_) { App.setDownloadBadge(0); }
    };
    setTimeout(badge, 4000);
    setInterval(badge, 15000);
  }

  window.addEventListener('DOMContentLoaded', () => {
    init().catch((err) => {
      console.error(err);
      document.getElementById('view').append(h('div', { class: 'page' }, h('div', { class: 'empty' }, h('h2', null, 'Falha ao iniciar'), h('p', null, String(err.message || err)))));
    });
  });
})(window.App);
