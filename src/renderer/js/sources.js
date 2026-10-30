'use strict';
/* Fontes: sites de confiança no navegador integrado + busca em indexadores (Prowlarr) */
(function (App) {
  const { h, icon } = App;
  App.views = App.views || {};

  let ro = null;
  let unsub = [];
  let activeSite = null;
  let mode = 'web'; // web | results | empty
  let lastState = null;

  function cleanup() {
    if (ro) { ro.disconnect(); ro = null; }
    unsub.forEach((f) => f());
    unsub = [];
    window.chimp.sources.hide();
  }
  App.leaveSources = cleanup;

  App.views.sources = function (root, params = {}) {
    cleanup();
    const sites = App.state.settings.sources.sites || [];

    // ---- barra lateral ----
    const siteList = h('div', { class: 'site-list' });
    function drawSites() {
      const list = App.state.settings.sources.sites || [];
      siteList.replaceChildren(...list.map((s, i) => h('div', {
        class: `site${activeSite === s.url ? ' on' : ''}`, title: s.url,
        onclick: () => openSite(s.url),
      }, h('div', { class: 'fav' }, (s.name || '?').trim().charAt(0)), h('div', { class: 'nm' }, s.name),
      h('button', { class: 'rm', title: 'Remover site', onclick: async (e) => {
        e.stopPropagation();
        if (!(await App.confirm('Remover site', `Remover “${s.name}” dos seus sites?`, { okLabel: 'Remover', danger: true }))) return;
        const next = list.filter((_, k) => k !== i);
        App.state.settings = await window.chimp.setSettings({ sources: { sites: next } });
        drawSites();
      } }, icon('close')))));
      if (!list.length) siteList.append(h('div', { class: 'panel-empty' }, 'Nenhum site ainda. Adicione os sites de torrent em que você confia.'));
    }
    const prowlInput = h('input', { class: 'input', placeholder: 'Ex.: Duna Parte Dois 2160p', value: params.query || '' });
    prowlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(prowlInput.value); });
    const side = h('aside', { class: 'src-side' },
      h('div', null, h('h4', null, 'Buscar em indexadores'),
        h('div', { class: 'input-row' }, prowlInput, h('button', { class: 'btn btn-sm btn-accent btn-round', style: { width: '40px', height: '40px' }, title: 'Buscar', onclick: () => runSearch(prowlInput.value) }, icon('search'))),
        h('div', { class: 'hint', style: { fontSize: '11.5px', color: 'var(--text-3)', marginTop: '6px', lineHeight: 1.45 } }, 'Usa o Prowlarr (opcional). Sem anúncios: nenhuma página é aberta.')),
      h('div', null,
        h('h4', null, 'Meus sites'),
        siteList,
        h('button', { class: 'btn btn-sm btn-outline', style: { width: '100%', marginTop: '10px' }, onclick: addSiteDialog }, icon('plus'), 'Adicionar site')),
    );

    // ---- área central ----
    const back = h('button', { class: 'icon-btn', title: 'Voltar', disabled: true, onclick: () => window.chimp.sources.nav('back') }, icon('back'));
    const fwd = h('button', { class: 'icon-btn', title: 'Avançar', disabled: true, onclick: () => window.chimp.sources.nav('forward') }, icon('forward'));
    const reload = h('button', { class: 'icon-btn', title: 'Recarregar', onclick: () => window.chimp.sources.nav('reload') }, icon('refresh'));
    const address = h('input', { class: 'src-address', placeholder: 'Endereço do site', spellcheck: 'false' });
    address.addEventListener('keydown', (e) => { if (e.key === 'Enter' && address.value.trim()) openSite(address.value.trim()); });
    const shield = h('button', { class: 'shield', title: 'Bloqueador de anúncios e pop-ups', onclick: async () => {
      const on = !(lastState ? lastState.adblock : App.state.settings.sources.adblock);
      await window.chimp.sources.setAdblock(on);
      App.state.settings.sources.adblock = on;
      App.toast(on ? 'Bloqueador ativado. Recarregue a página.' : 'Bloqueador desativado.', on ? 'ok' : 'warn');
      updShield();
    } }, icon('shield'), h('span'));
    function updShield() {
      const on = lastState ? lastState.adblock : App.state.settings.sources.adblock !== false;
      shield.classList.toggle('off', !on);
      shield.lastChild.textContent = on ? `${lastState ? lastState.blocked : 0} bloqueados` : 'Bloqueio desligado';
    }
    updShield();
    const extBtn = h('button', { class: 'icon-btn', title: 'Abrir esta página no navegador padrão', onclick: () => { const u = lastState && lastState.url; if (u && /^https?:/i.test(u)) window.chimp.shell.open(u); } }, icon('link'));
    const toolbar = h('div', { class: 'src-toolbar' }, back, fwd, reload, address, extBtn, shield);
    const viewport = h('div', { class: 'src-viewport' });
    const emptyBox = h('div', { class: 'src-empty' });
    viewport.append(emptyBox);
    const main = h('section', { class: 'src-main' }, toolbar, viewport);

    // ---- painel de magnets ----
    const count = h('span', { class: 'count-badge' }, '0');
    const mlist = h('div', { class: 'magnet-list' });
    const panel = h('aside', { class: 'src-panel' },
      h('div', { class: 'src-panel-head' }, icon('magnet'), h('h4', null, 'Magnets nesta página'), count),
      mlist);

    const pageEl = h('div', { class: 'sources-page' }, side, main, panel);
    root.append(pageEl);
    drawSites();

    function drawMagnets(list, flashKey) {
      count.textContent = String(list.length);
      if (!list.length) {
        mlist.replaceChildren(h('div', { class: 'panel-empty' }, mode === 'web' && lastState && lastState.url
          ? 'Nenhum magnet encontrado nesta página. Abra a página de um título específico — os links aparecem aqui automaticamente, sem precisar clicar em botões cheios de anúncio.'
          : 'Abra um site da lista ao lado. Os magnet links encontrados aparecem aqui, prontos para baixar.'));
        return;
      }
      mlist.replaceChildren(...list.slice().reverse().map((m) => {
        const key = m.hash || m.uri;
        const name = m.name || m.label || 'Torrent sem nome';
        const meta = [];
        if (m.size) meta.push(App.fmtBytes(m.size));
        const seeds = (m.context || '').match(/(?:seed(?:er)?s?|semeadores?)\D{0,6}(\d{1,6})/i);
        if (seeds) meta.push(`${seeds[1]} seeds`);
        const quality = name.match(/\b(2160p|4k|1080p|720p|480p)\b/i);
        if (quality) meta.push(quality[1].toUpperCase());
        return h('div', { class: `magnet${flashKey && flashKey === key ? ' flash' : ''}` },
          h('div', { class: 'mn', title: name }, name),
          h('div', { class: 'mm' }, meta.map((x) => h('span', null, x))),
          h('div', { style: { display: 'flex', gap: '6px' } },
            h('button', { class: 'btn btn-xs btn-accent', onclick: () => App.addTorrentDialog(m) }, icon('download'), 'Baixar'),
            h('button', { class: 'btn btn-xs btn-ghost', title: 'Copiar magnet', onclick: () => { navigator.clipboard.writeText(m.uri); App.toast('Magnet copiado.', 'ok'); } }, icon('link'))));
      }));
    }

    function setMode(m) {
      mode = m;
      if (m === 'web') { emptyBox.hidden = true; window.chimp.sources.show(); syncBounds(); }
      else { emptyBox.hidden = false; window.chimp.sources.hide(); }
    }

    function syncBounds() {
      const r = viewport.getBoundingClientRect();
      window.chimp.sources.bounds({ x: r.left, y: r.top, width: r.width, height: r.height });
    }
    ro = new ResizeObserver(syncBounds);
    ro.observe(viewport);
    window.addEventListener('resize', syncBounds);
    unsub.push(() => window.removeEventListener('resize', syncBounds));

    unsub.push(window.chimp.on('sources:state', (st) => {
      lastState = st;
      back.disabled = !st.canBack;
      fwd.disabled = !st.canForward;
      if (document.activeElement !== address) address.value = st.url || '';
      reload.replaceChildren(icon(st.loading ? 'close' : 'refresh'));
      reload.onclick = () => window.chimp.sources.nav(st.loading ? 'stop' : 'reload');
      updShield();
      if (mode === 'web') drawMagnets(st.magnets || []);
    }));
    unsub.push(window.chimp.on('sources:magnet', (m) => {
      if (mode !== 'web') return;
      drawMagnets((lastState && lastState.magnets) || [m], m.hash || m.uri);
      App.addTorrentDialog(m);
    }));
    // Ao abrir modais o navegador (camada nativa) precisa sumir para não cobrir o diálogo.
    const onOpen = () => { if (mode === 'web') window.chimp.sources.hide(); };
    const onClose = () => { if (mode === 'web' && document.body.contains(pageEl) && !App.state.detailOpen) { window.chimp.sources.show(); syncBounds(); } };
    App.on('modal-opened', onOpen); App.on('modal-closed', onClose);
    App.on('detail-opened', onOpen); App.on('detail-closed', onClose);
    unsub.push(() => { App.off('modal-opened', onOpen); App.off('modal-closed', onClose); App.off('detail-opened', onOpen); App.off('detail-closed', onClose); });

    function openSite(url) {
      activeSite = url;
      drawSites();
      setMode('web');
      window.chimp.sources.open(url).catch((e) => App.toast(e.message, 'error'));
    }

    function showEmpty() {
      setMode('empty');
      emptyBox.replaceChildren(h('div', { class: 'empty', style: { minHeight: '100%' } },
        h('img', { src: 'assets/logo.svg', alt: '', style: { width: '84px', height: '84px', borderRadius: '22px', marginBottom: '6px' } }),
        h('h2', null, 'Suas fontes, sem anúncios'),
        h('p', null, 'Adicione os sites de torrent em que você confia. Eles abrem aqui dentro com bloqueio de anúncios, pop-ups e redirecionamentos. Os magnet links da página são detectados automaticamente no painel à direita.'),
        h('div', { class: 'hero-actions', style: { justifyContent: 'center' } },
          h('button', { class: 'btn btn-accent', onclick: addSiteDialog }, icon('plus'), 'Adicionar site'),
          h('button', { class: 'btn btn-outline', onclick: () => App.addMagnetDialog() }, icon('magnet'), 'Colar magnet link'))));
      drawMagnets([]);
    }

    async function runSearch(q) {
      q = String(q || '').trim();
      if (!q) return;
      setMode('results');
      activeSite = null; drawSites();
      emptyBox.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'spinner lg' }), h('p', null, `Buscando “${q}” nos indexadores…`)));
      try {
        const res = await window.chimp.prowlarr.search(q);
        if (!res.length) {
          emptyBox.replaceChildren(h('div', { class: 'empty' }, icon('search'), h('h2', null, 'Nenhum resultado'), h('p', null, 'Tente outro termo, como o nome original ou em inglês.')));
          return;
        }
        const tbody = h('tbody');
        for (const r of res.slice(0, 200)) {
          tbody.append(h('tr', null,
            h('td', { class: 't' }, r.title),
            h('td', { class: 'num' }, App.fmtBytes(r.size)),
            h('td', { class: `num ${r.seeders > 20 ? 'seed-hi' : ''}` }, r.seeders == null ? '—' : String(r.seeders)),
            h('td', { class: 'num' }, r.leechers == null ? '—' : String(r.leechers)),
            h('td', null, r.indexer),
            h('td', null, h('button', { class: 'btn btn-xs btn-accent', onclick: () => App.addTorrentDialog({ uri: r.link, name: r.title, size: r.size }) }, icon('download'), 'Baixar'))));
        }
        emptyBox.replaceChildren(h('div', { style: { padding: '0 16px 30px' } },
          h('table', { class: 'results-table' }, h('thead', null, h('tr', null, ['Título', 'Tamanho', 'Seeds', 'Peers', 'Indexador', ''].map((t) => h('th', null, t)))), tbody)));
      } catch (err) {
        emptyBox.replaceChildren(h('div', { class: 'empty' }, icon('info'), h('h2', null, 'Busca indisponível'), h('p', null, err.message),
          h('button', { class: 'btn btn-outline', onclick: () => App.navigate('settings', { section: 'prowlarr' }) }, 'Configurar Prowlarr')));
      }
      drawMagnets([]);
    }

    function addSiteDialog() {
      const name = h('input', { class: 'input', placeholder: 'Ex.: Meu site favorito' });
      const url = h('input', { class: 'input', placeholder: 'https://…' });
      App.modal({
        title: 'Adicionar site de confiança',
        body: (b) => {
          b.append(h('p', null, 'O site abrirá no navegador integrado, com anúncios, pop-ups, redirecionamentos para outros sites e downloads de programas bloqueados.'));
          b.append(h('div', { class: 'field' }, h('label', null, 'Endereço'), url));
          b.append(h('div', { class: 'field' }, h('label', null, 'Nome (opcional)'), name));
        },
        actions: [{ label: 'Cancelar' }, {
          label: 'Adicionar', kind: 'btn-accent', run: async () => {
            let u = url.value.trim();
            if (!u) { App.toast('Informe o endereço do site.', 'warn'); return false; }
            if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
            let host;
            try { host = new URL(u).hostname; } catch (_) { App.toast('Endereço inválido.', 'warn'); return false; }
            const list = [...(App.state.settings.sources.sites || [])];
            list.push({ name: name.value.trim() || host.replace(/^www\./, ''), url: u });
            App.state.settings = await window.chimp.setSettings({ sources: { sites: list } });
            drawSites();
            setTimeout(() => openSite(u), 50);
            return true;
          },
        }],
      });
    }

    if (params.query) { prowlInput.value = params.query; runSearch(params.query); }
    else if (lastState && lastState.url) { setMode('web'); drawMagnets(lastState.magnets || []); address.value = lastState.url; }
    else showEmpty();
  };
})(window.App);
