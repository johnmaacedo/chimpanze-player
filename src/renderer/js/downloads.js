'use strict';
/* Downloads (qBittorrent) */
(function (App) {
  const { h, icon } = App;
  App.views = App.views || {};

  let pollTimer = null;
  const expanded = new Set();
  const fileCache = new Map();

  App.stopDownloads = () => { clearInterval(pollTimer); pollTimer = null; };

  App.views.downloads = function (root) {
    App.stopDownloads();
    const statusBox = h('div', { class: 'dl-toolbar' });
    const list = h('div', { class: 'dl-list' });
    const page = h('div', { class: 'page' },
      h('div', { class: 'page-head' },
        h('h1', { class: 'page-title' }, 'Downloads'),
        statusBox,
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn btn-sm btn-outline', onclick: () => App.addMagnetDialog() }, icon('magnet'), 'Colar magnet link'),
        h('button', { class: 'btn btn-sm btn-outline', onclick: async () => {
          const f = await window.chimp.shell.pickFile([{ name: 'Torrent', extensions: ['torrent'] }]);
          if (f) App.addTorrentDialog({ file: f, name: f.split(/[\\/]/).pop().replace(/\.torrent$/i, '') });
        } }, icon('plus'), 'Abrir .torrent')),
      list);
    root.append(page);

    let connected = null;
    async function refreshStatus() {
      const st = await window.chimp.torrent.status().catch((e) => ({ ok: false, error: e.message }));
      connected = st.ok;
      statusBox.replaceChildren(
        h('span', { class: `status-pill ${st.ok ? 'ok' : 'err'}` }, st.ok ? `qBittorrent ${st.version || ''} conectado` : 'qBittorrent desconectado'),
      );
      if (!st.ok) renderOffline(st);
      return st;
    }

    function renderOffline(st) {
      const auth = st.code === 'AUTH';
      list.replaceChildren(h('div', { class: 'panel' },
        h('h3', null, auth ? 'Falha de login no qBittorrent' : 'Conecte o qBittorrent'),
        h('p', { class: 'sub' }, auth
          ? 'Usuário ou senha incorretos. Ajuste em Configurações › qBittorrent, ou use a configuração automática (libera o acesso local sem senha).'
          : st.exe
            ? `${st.error || 'O qBittorrent não respondeu.'} Clique em “Configurar automaticamente”: eu ligo a interface Web numa porta livre, fecho e reabro o qBittorrent sozinho.`
            : 'Não encontrei o qBittorrent neste computador. Instale-o (é gratuito e de código aberto) e depois clique em “Tentar novamente”.'),
        h('div', { class: 'hero-actions' },
          st.exe || auth ? h('button', { class: 'btn btn-accent btn-sm', onclick: () => App.qbitAutoConfig().then(tick) }, icon('sparkle'), 'Configurar automaticamente') : null,
          !st.exe && !auth ? h('button', { class: 'btn btn-accent btn-sm', onclick: () => window.chimp.shell.open('https://www.qbittorrent.org/download') }, icon('download'), 'Baixar qBittorrent') : null,
          st.exe ? h('button', { class: 'btn btn-outline btn-sm', onclick: async (e) => { e.currentTarget.disabled = true; await window.chimp.torrent.ensure(); tick(); } }, icon('play'), 'Abrir qBittorrent') : null,
          h('button', { class: 'btn btn-outline btn-sm', onclick: () => tick() }, icon('refresh'), 'Tentar novamente'),
          h('button', { class: 'btn btn-outline btn-sm', onclick: () => App.navigate('settings', { section: 'torrent' }) }, 'Configurações'))));
    }

    const nodes = new Map(); // hash -> { el, update }
    async function tick() {
      if (!document.body.contains(page)) { App.stopDownloads(); return; }
      if (!connected) { const st = await refreshStatus(); if (!st.ok) return; nodes.clear(); list.replaceChildren(); }
      let items;
      try { items = await window.chimp.torrent.list(); } catch (err) { connected = false; await refreshStatus(); return; }
      App.setDownloadBadge(items.filter((t) => !t.done && !t.paused).length);
      if (!items.length) {
        nodes.clear();
        list.replaceChildren(h('div', { class: 'empty' }, icon('download'), h('h2', null, 'Nenhum download'),
          h('p', null, 'Use a aba Fontes para encontrar magnet links nos seus sites de confiança, ou cole um magnet link aqui.'),
          h('button', { class: 'btn btn-accent', onclick: () => App.navigate('sources') }, icon('magnet'), 'Ir para Fontes')));
        return;
      }
      if (!nodes.size) list.replaceChildren();
      const order = [];
      for (const t of items) {
        let n = nodes.get(t.hash);
        if (!n) { n = makeItem(t); nodes.set(t.hash, n); }
        await n.update(t);
        order.push(n.el);
      }
      for (const [hash, n] of nodes) if (!items.some((t) => t.hash === hash)) { n.el.remove(); nodes.delete(hash); }
      order.forEach((el, i) => { if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null); });
    }

    function makeItem(t0) {
      let t = t0;
      const name = h('div', { class: 'dl-name' });
      const state = h('span', { class: 'dl-state' });
      const watchBtn = h('button', { class: 'btn btn-xs btn-accent', onclick: () => watch(t) }, icon('play'), h('span'));
      const pauseBtn = h('button', { class: 'btn btn-xs btn-ghost', onclick: () => act(() => (t.paused ? window.chimp.torrent.resume(t.hash) : window.chimp.torrent.pause(t.hash))) });
      const filesBtn = h('button', { class: 'btn btn-xs btn-ghost', title: 'Arquivos', onclick: () => { if (expanded.has(t.hash)) expanded.delete(t.hash); else expanded.add(t.hash); renderFiles(); } }, icon('more'));
      const bar = h('div', { class: 'dl-bar' }, h('i'));
      const meta = h('div', { class: 'dl-meta' });
      const seq = h('input', { type: 'checkbox' });
      seq.addEventListener('change', () => act(() => window.chimp.torrent.toggleSeq(t.hash)));
      const seqLabel = h('label', { class: 'checkbox', style: { fontSize: '12.5px' }, title: 'Baixa em ordem para permitir assistir enquanto baixa' }, seq, 'Sequencial');
      const filesBox = h('div', { class: 'dl-files', hidden: true });
      const el = h('div', { class: 'dl-item' },
        h('div', { class: 'dl-top' }, name, state,
          h('div', { class: 'dl-actions' }, watchBtn, pauseBtn, filesBtn,
            h('button', { class: 'btn btn-xs btn-ghost', title: 'Abrir pasta', onclick: () => window.chimp.shell.open(t.savePath) }, icon('folder')),
            h('button', { class: 'btn btn-xs btn-danger', title: 'Remover', onclick: () => removeDlg(t) }, icon('trash')))),
        bar, meta, filesBox);
      let lastPause = null;
      async function renderFiles() {
        if (!expanded.has(t.hash)) { filesBox.hidden = true; return; }
        let files = fileCache.get(t.hash);
        try { files = await window.chimp.torrent.files(t.hash); fileCache.set(t.hash, files); } catch (_) { /* usa cache */ }
        filesBox.hidden = false;
        filesBox.replaceChildren(...(files || []).map((f) => h('div', { class: 'dl-file' },
          icon(f.isVideo ? 'film' : 'folder'),
          h('div', { class: 'n', title: f.name }, f.name),
          h('div', { class: 'mini-bar' }, h('i', { style: { width: `${Math.round(f.progress * 100)}%` } })),
          h('div', { class: 'pc' }, `${Math.round(f.progress * 100)}%`),
          f.isVideo ? h('button', { class: 'btn btn-xs btn-ghost', title: 'Assistir este arquivo', onclick: () => watch(t, f.index) }, icon('play')) : null)));
      }
      async function update(nt) {
        t = nt;
        const pct = Math.floor(t.progress * 1000) / 10;
        const cls = t.state === 'error' || t.state === 'missingFiles' ? 'err' : t.done ? 'done' : /DL|downloading/.test(t.state) && !t.paused ? 'down' : '';
        name.textContent = t.name; name.title = t.name;
        state.className = `dl-state ${cls}`; state.textContent = t.stateLabel;
        const canWatch = t.done || t.sequential || t.progress > 0.05;
        watchBtn.disabled = !canWatch;
        watchBtn.title = canWatch ? 'Assistir' : 'Ative o download sequencial para assistir enquanto baixa';
        watchBtn.lastChild.textContent = t.done ? 'Assistir' : 'Assistir agora';
        if (lastPause !== t.paused) { lastPause = t.paused; pauseBtn.replaceChildren(icon(t.paused ? 'play' : 'pause')); pauseBtn.title = t.paused ? 'Retomar' : 'Pausar'; }
        bar.className = `dl-bar${t.done ? ' done' : ''}`;
        bar.firstChild.style.width = `${pct}%`;
        if (document.activeElement !== seq) seq.checked = t.sequential;
        meta.replaceChildren(
          h('span', null, h('b', null, `${String(pct).replace('.', ',')}%`), t.size > 0 ? ` de ${App.fmtBytes(t.size)}` : ' · obtendo informações do torrent…'),
          !t.done ? h('span', null, '↓ ', h('b', null, App.fmtSpeed(t.dlspeed))) : null,
          h('span', null, '↑ ', App.fmtSpeed(t.upspeed)),
          !t.done && !t.paused ? h('span', null, 'Restante: ', h('b', null, App.fmtEta(t.eta))) : null,
          h('span', null, `Fontes: ${t.seeds} · Pares: ${t.peers}`),
          seqLabel);
        if (expanded.has(t.hash)) await renderFiles();
      }
      return { el, update };
    }

    async function watch(t, index) {
      try { await window.chimp.torrent.play(t.hash, index); } catch (err) { App.toast(err.message, 'warn'); }
    }
    async function act(fn) {
      try { await fn(); } catch (err) { App.toast(err.message, 'error'); }
      setTimeout(tick, 300);
    }
    function removeDlg(t) {
      let del = false;
      App.modal({
        title: 'Remover download',
        body: (b) => {
          b.append(h('p', null, `Remover “${t.name}” do qBittorrent?`));
          const c = h('input', { type: 'checkbox' });
          c.addEventListener('change', () => { del = c.checked; });
          b.append(h('label', { class: 'checkbox' }, c, 'Apagar também os arquivos baixados do disco'));
        },
        actions: [{ label: 'Cancelar' }, { label: 'Remover', kind: 'btn-danger', run: () => act(() => window.chimp.torrent.remove(t.hash, del)) }],
      });
    }

    refreshStatus().then((st) => { if (st.ok) tick(); });
    pollTimer = setInterval(() => { if (!App.state.modalOpen) tick(); }, 1500);
  };

  // Diálogo para colar magnet link manualmente.
  App.addMagnetDialog = function () {
    const ta = h('textarea', { class: 'input', placeholder: 'magnet:?xt=urn:btih:…', rows: '4' });
    App.modal({
      title: 'Colar magnet link',
      body: (b) => b.append(h('div', { class: 'field' }, h('label', null, 'Magnet link'), ta)),
      actions: [{ label: 'Cancelar' }, {
        label: 'Continuar', kind: 'btn-accent', run: async () => {
          const v = ta.value.trim();
          if (!/^magnet:\?/i.test(v)) { App.toast('Isso não parece um magnet link.', 'warn'); return false; }
          const info = await window.chimp.sources.parseMagnet(v);
          setTimeout(() => App.addTorrentDialog(info), 50);
          return true;
        },
      }],
    });
  };

  // Diálogo de confirmação de download (destino, categoria, sequencial).
  App.addTorrentDialog = function (info) {
    const guessKind = /\b(s\d{1,2}e\d{1,3}|season|temporada|complete series)\b/i.test(info.name || '') ? 'series'
      : /\[[^\]]+\]|\b(anime|dual audio)\b/i.test(info.name || '') ? 'anime' : 'movie';
    let kind = guessKind;
    let sequential = App.state.settings.torrent.sequential !== false;
    let customDir = null;
    const dirLabel = h('div', { class: 'folder-item' }, icon('folder'), h('div', { class: 'p' }, '…'),
      h('button', { class: 'btn btn-xs btn-ghost', onclick: async () => { const d = await window.chimp.shell.pickDir(); if (d) { customDir = d; updDir(); } } }, 'Alterar'));
    async function updDir() {
      const d = customDir || await window.chimp.torrent.defaultDir(kind);
      dirLabel.querySelector('.p').textContent = d;
      dirLabel.querySelector('.p').title = d;
    }
    App.modal({
      title: 'Baixar torrent',
      body: (b) => {
        b.append(h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Nome'), h('div', { style: { fontWeight: 700, wordBreak: 'break-word' } }, info.name || info.label || 'Sem nome (será obtido do torrent)'),
          info.size ? h('div', { class: 'hint' }, `Tamanho: ${App.fmtBytes(info.size)}`) : null));
        b.append(h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Categoria'),
          App.seg([['movie', 'Filme'], ['series', 'Série'], ['anime', 'Anime']], kind, (v) => { kind = v; if (!customDir) updDir(); })));
        b.append(h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Salvar em'), dirLabel,
          h('div', { class: 'hint' }, 'A pasta entra automaticamente na biblioteca: quando terminar, o título aparece com capa.')));
        const c = h('input', { type: 'checkbox' }); c.checked = sequential; c.addEventListener('change', () => { sequential = c.checked; });
        b.append(h('label', { class: 'checkbox' }, c, h('span', null, h('b', null, 'Assistir enquanto baixa'), h('br'), h('span', { class: 'hint' }, 'Baixa em ordem (download sequencial), permitindo começar a assistir em poucos minutos.'))));
        updDir();
      },
      actions: [{ label: 'Cancelar' }, {
        label: 'Baixar', kind: 'btn-accent', run: async () => {
          const r = await window.chimp.torrent.add(info.uri || null, { kind, savePath: customDir || undefined, sequential, file: info.file });
          App.toast(`Download iniciado em ${r.savePath}`, 'ok', { actions: [{ label: 'Ver downloads', run: () => App.navigate('downloads') }] });
          return true;
        },
      }],
    });
  };

  App.qbitAutoConfig = async function () {
    let closeWait = App.toast('Configurando o qBittorrent… isso leva alguns segundos.', 'info', { duration: 60000 });
    let r = await window.chimp.torrent.autoConfig(false).catch((e) => ({ ok: false, error: e.message }));
    if (r.needsClose) {
      closeWait();
      const ok = await App.confirm('Configurar qBittorrent', 'O qBittorrent está aberto. Para ativar a interface Web ele precisa ser fechado e reaberto automaticamente (os downloads continuam depois). Continuar?', { okLabel: 'Fechar e configurar' });
      if (!ok) return null;
      closeWait = App.toast('Fechando e reabrindo o qBittorrent…', 'info', { duration: 60000 });
      r = await window.chimp.torrent.autoConfig(true).catch((e) => ({ ok: false, error: e.message }));
    }
    closeWait();
    if (r.ok && r.connected) {
      App.toast(`Pronto! qBittorrent ${r.version || ''} conectado na porta ${r.port}${r.changedPort ? ` (a porta ${r.changedPort} estava bloqueada no seu Windows)` : ''}.`, 'ok', { duration: 9000 });
    } else if (r.ok) {
      App.toast(`Configuração gravada (porta ${r.port}), mas o qBittorrent ainda não respondeu: ${r.error || ''}`, 'warn', { duration: 12000 });
    } else {
      App.toast(r.error || 'Não foi possível configurar o qBittorrent.', 'error', { duration: 12000 });
    }
    App.state.settings = (await window.chimp.state()).settings;
    return r;
  };

  App.setDownloadBadge = function (n) {
    const b = document.getElementById('dl-badge');
    if (!b) return;
    b.hidden = !n;
    b.textContent = n ? String(n) : '';
  };
})(window.App);
