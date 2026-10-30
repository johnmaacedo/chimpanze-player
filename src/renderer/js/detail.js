'use strict';
/* Página de detalhes (estilo Apple TV): fundo, sinopse, temporadas e episódios */
(function (App) {
  const { h, icon } = App;

  let current = null; // { id, season }

  App.openDetail = function (id, opts = {}) {
    const item = App.state.itemsById[id];
    if (!item) return;
    const layer = document.getElementById('detail-layer');
    const keepScroll = current && current.id === id ? layer.scrollTop : 0;
    if (!current || current.id !== id) current = { id, season: null };
    if (opts.season != null) current.season = opts.season;
    App.state.detailOpen = true;
    layer.hidden = false;
    render(layer, item);
    layer.scrollTop = keepScroll;
    App.emit('detail-opened');
  };

  App.closeDetail = function () {
    const layer = document.getElementById('detail-layer');
    layer.hidden = true;
    layer.replaceChildren();
    current = null;
    App.state.detailOpen = false;
    App.emit('detail-closed');
  };

  App.refreshDetail = function () {
    if (!current) return;
    const item = App.state.itemsById[current.id];
    if (!item) { App.closeDetail(); return; }
    const layer = document.getElementById('detail-layer');
    const st = layer.scrollTop;
    render(layer, item);
    layer.scrollTop = st;
  };

  App.detailOpenId = () => (current ? current.id : null);

  function render(layer, item) {
    const m = item.meta || {};
    const a = App.art(item);
    const title = App.titleOf(item);
    const resume = App.resumeInfo(item);

    const bg = h('div', { class: `detail-bg${a.backdrop ? '' : ' blur'}` });
    const bgUrl = a.backdrop || a.poster;
    if (bgUrl) bg.style.backgroundImage = `url("${bgUrl}")`;

    const metaLine = h('div', { class: 'meta-line' });
    const parts = [];
    if (App.yearOf(item)) parts.push(h('span', null, String(App.yearOf(item))));
    parts.push(h('span', { class: 'chip accent' }, App.KIND_LABEL[item.kind] || ''));
    if (item.type === 'show') {
      const seasons = [...new Set(item.episodes.map((e) => e.season))];
      parts.push(h('span', null, seasons.length > 1 ? `${seasons.length} temporadas` : `${item.episodes.length} episódio${item.episodes.length > 1 ? 's' : ''}`));
    } else if (m.runtime) parts.push(h('span', null, App.fmtDuration(m.runtime)));
    if (m.rating) parts.push(h('span', { class: 'rating' }, `★ ${String(m.rating).replace('.', ',')}`));
    if (m.contentRating) parts.push(h('span', { class: 'chip' }, m.contentRating));
    parts.forEach((p, i) => { if (i) metaLine.append(h('span', { class: 'dot' })); metaLine.append(p); });
    if ((m.genres || []).length) metaLine.append(h('span', { class: 'dot' }), h('span', null, m.genres.slice(0, 3).join(', ')));

    let titleNode = h('h1', { class: 'detail-title' }, title);
    if (a.logo) {
      const img = h('img', { class: 'detail-logo', alt: title });
      const fallbackTitle = titleNode;
      img.onerror = () => img.replaceWith(fallbackTitle);
      img.src = a.logo;
      titleNode = img;
    }

    const overview = m.overview ? h('p', { class: 'detail-overview clamp', onclick: (e) => e.currentTarget.classList.toggle('clamp') }, m.overview) : null;

    const actions = h('div', { class: 'detail-actions' },
      h('button', { class: 'btn btn-primary', onclick: () => App.playItem(item) }, icon('play'), resume ? resume.cta : 'Assistir'),
      resume && resume.progress > 0 ? h('button', { class: 'btn btn-ghost', onclick: () => App.playItem(item, { fromStart: true }) }, icon('restart'), 'Do início') : null,
      watchedButton(item),
      h('button', { class: 'btn btn-ghost btn-round', title: 'Mais opções', onclick: (e) => moreMenu(e.currentTarget, item) }, icon('more')),
    );

    const poster = a.poster ? h('img', { class: 'detail-poster', src: a.poster, alt: '', onerror: (e) => e.target.remove() }) : null;

    const statusNote = item.metaStatus === 'notfound' || item.metaStatus === 'error'
      ? h('div', { class: 'status-note' }, icon('info'), item.metaStatus === 'error' ? 'Não consegui buscar as informações (sem internet?).' : 'Não encontrei este título automaticamente.',
        h('button', { class: 'btn btn-xs btn-ghost', onclick: () => fixMatch(item) }, 'Buscar na internet'),
        h('button', { class: 'btn btn-xs btn-ghost', onclick: () => App.manualRegister(item) }, 'Cadastrar manualmente'))
      : item.metaStatus === 'pending' ? h('div', { class: 'status-note' }, h('span', { class: 'spinner' }), 'Buscando capa e informações…') : null;

    const hero = h('section', { class: 'detail-hero' }, bg,
      h('div', { class: 'detail-content' }, poster, h('div', { class: 'detail-main' }, statusNote, titleNode, metaLine, overview, actions)));

    const body = h('section', { class: 'detail-body' });
    if (item.type === 'show') body.append(episodesSection(item));
    else body.append(filesSection(item));
    body.append(factsSection(item));

    const closeBtn = h('button', { class: 'btn btn-ghost btn-round detail-close', title: 'Voltar (Esc)', onclick: App.closeDetail }, icon('back'));
    layer.replaceChildren(closeBtn, hero, body);
  }

  function watchedButton(item) {
    const files = item.type === 'show' ? item.episodes.map((e) => e.path) : item.files.map((f) => f.path);
    const allWatched = files.every((p) => App.state.progress[p] && App.state.progress[p].watched);
    return h('button', {
      class: 'btn btn-ghost', title: allWatched ? 'Marcar como não assistido' : 'Marcar tudo como assistido',
      onclick: async () => { await window.chimp.library.markWatched(files, !allWatched); },
    }, icon(allWatched ? 'check' : 'eye'), allWatched ? 'Assistido' : 'Marcar assistido');
  }

  function episodesSection(item) {
    const seasons = [...new Set(item.episodes.map((e) => e.season))].sort((a, b) => (a === 0) - (b === 0) || a - b);
    const resume = App.resumeInfo(item);
    if (current.season == null || !seasons.includes(current.season)) current.season = resume && resume.episode ? resume.episode.season : seasons[0];
    const wrap = h('div');
    const bar = h('div', { class: 'season-bar' }, h('h2', { class: 'section-title' }, 'Episódios'));
    if (seasons.length > 1) {
      for (const s of seasons) {
        bar.append(h('button', { class: `pill${s === current.season ? ' on' : ''}`, onclick: () => { current.season = s; App.refreshDetail(); } }, s === 0 ? 'Especiais' : `Temporada ${s}`));
      }
    } else bar.append(h('span', { class: 'chip' }, seasons[0] === 0 ? 'Especiais' : `Temporada ${seasons[0]}`));
    wrap.append(bar);
    const list = h('div', { class: 'episodes' });
    for (const ep of item.episodes.filter((e) => e.season === current.season)) list.append(episodeRow(item, ep, resume));
    wrap.append(list);
    return wrap;
  }

  function episodeRow(item, ep, resume) {
    const em = (item.episodeMeta || {})[`${ep.season}x${ep.episode}`] || {};
    const pr = App.state.progress[ep.path];
    const thumb = h('div', { class: 'ep-thumb' });
    const still = em.still ? App.remoteImg(em.still) : null;
    const local = App.thumbImg(ep.path, 22);
    thumb.append(App.lazyImg(still || local, '', () => { if (still) thumb.prepend(App.lazyImg(local, '')); }));
    thumb.append(h('div', { class: 'card-play' }, icon('play')));
    if (pr && !pr.watched && pr.dur) thumb.append(h('div', { class: 'card-progress' }, h('i', { style: { width: `${Math.max(3, Math.round((pr.pos / pr.dur) * 100))}%` } })));
    const isCurrent = resume && resume.episode && resume.episode.id === ep.id;
    const dur = em.runtime ? `${em.runtime} min` : (pr && pr.dur ? App.fmtDuration(pr.dur / 60) : '');
    const title = em.title || `Episódio ${ep.episode}`;
    const row = h('div', { class: `episode${isCurrent ? ' current' : ''}`, onclick: () => App.play({ itemId: item.id, episodeId: ep.id }) },
      h('div', { class: 'ep-num' }, String(ep.episode)),
      thumb,
      h('div', { class: 'ep-text' },
        h('div', { class: 'ep-title' }, h('span', null, `${App.epLabel(ep)} · ${title}`), dur ? h('span', { class: 'dur' }, dur) : null),
        em.overview ? h('div', { class: 'ep-desc' }, em.overview) : null,
        h('div', { class: 'ep-file', title: ep.path }, `${ep.name} · ${App.fmtBytes(ep.size)}`)),
      h('div', { class: 'ep-side' },
        pr && pr.watched ? h('span', { class: 'ep-watched', title: 'Assistido' }, icon('check')) : null,
        h('button', { class: 'icon-btn', title: 'Opções', onclick: (e) => { e.stopPropagation(); episodeMenu(e.currentTarget, item, ep); } }, icon('more'))));
    return row;
  }

  function episodeMenu(anchor, item, ep) {
    const pr = App.state.progress[ep.path];
    App.menu(anchor, [
      { label: 'Assistir do início', icon: 'restart', run: () => App.play({ itemId: item.id, episodeId: ep.id, start: 0 }) },
      pr && pr.watched
        ? { label: 'Marcar como não assistido', icon: 'eye', run: () => window.chimp.library.markWatched([ep.path], false) }
        : { label: 'Marcar como assistido', icon: 'check', run: () => window.chimp.library.markWatched([ep.path], true) },
      { label: 'Marcar anteriores como assistidos', icon: 'check', run: () => {
        const idx = item.episodes.findIndex((e) => e.id === ep.id);
        window.chimp.library.markWatched(item.episodes.slice(0, idx + 1).map((e) => e.path), true);
      } },
      '-',
      { label: 'Mostrar na pasta', icon: 'folder', run: () => window.chimp.shell.showItem(ep.path) },
    ]);
  }

  function filesSection(item) {
    const wrap = h('div');
    if (item.files.length > 1) {
      wrap.append(h('h2', { class: 'section-title', style: { marginBottom: '12px' } }, 'Versões'));
      const list = h('div', { class: 'files-list' });
      for (const f of item.files) {
        list.append(h('div', { class: 'file-row' },
          icon('film'), h('div', { class: 'name', title: f.path }, f.name), h('div', { class: 'size' }, App.fmtBytes(f.size)),
          h('button', { class: 'btn btn-xs btn-ghost', onclick: () => App.play({ itemId: item.id, file: f.path }) }, icon('play'), 'Assistir')));
      }
      wrap.append(list);
    }
    return wrap;
  }

  function factsSection(item) {
    const m = item.meta || {};
    const facts = [];
    if (m.originalTitle && m.originalTitle !== App.titleOf(item)) facts.push(['Título original', m.originalTitle]);
    if ((m.genres || []).length) facts.push(['Gêneros', m.genres.join(', ')]);
    if (item.type === 'show') {
      const size = item.episodes.reduce((s, e) => s + e.size, 0);
      facts.push(['Na sua biblioteca', `${item.episodes.length} arquivo${item.episodes.length > 1 ? 's' : ''} · ${App.fmtBytes(size)}`]);
    } else {
      facts.push(['Arquivo', `${item.files[0].name} · ${App.fmtBytes(item.files[0].size)}`]);
    }
    facts.push(['Pasta', item.dir]);
    if (m.provider) facts.push(['Informações de', { imdb: 'IMDb', tmdb: 'TMDB', anilist: 'AniList', tvmaze: 'TVmaze', itunes: 'Apple TV / iTunes' }[m.provider] || m.provider]);
    return h('div', { class: 'facts' }, facts.map(([k, v]) => h('div', { class: 'fact' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v))));
  }

  function moreMenu(anchor, item) {
    const hasProfile = !!App.state.settings.videoProfiles[item.id];
    App.menu(anchor, [
      { label: 'Corrigir identificação…', icon: 'search', run: () => fixMatch(item) },
      { label: 'Trocar capa…', icon: 'edit', run: () => App.pickArt(item, 'poster') },
      { label: 'Trocar imagem de fundo…', icon: 'edit', run: () => App.pickArt(item, 'backdrop') },
      item.localArt && (item.localArt.poster || item.localArt.backdrop) ? { label: 'Voltar às imagens automáticas', icon: 'restart', run: async () => { await window.chimp.library.clearArt(item.id, 'poster'); await window.chimp.library.clearArt(item.id, 'backdrop'); App.toast('Imagens restauradas.', 'ok'); } } : null,
      { label: 'Cadastrar manualmente…', icon: 'tag', run: () => App.manualRegister(item) },
      { label: 'Renomear…', icon: 'edit', run: async () => {
        const v = await App.prompt('Renomear título', { label: 'Nome exibido', value: App.titleOf(item), hint: 'Deixe vazio para voltar ao nome original.' });
        if (v !== null) await window.chimp.library.setTitle(item.id, v.trim());
      } },
      { label: 'Alterar categoria…', icon: 'tag', run: () => changeKind(item) },
      { label: 'Atualizar informações', icon: 'refresh', run: async () => { await window.chimp.library.refreshMeta(item.id); App.toast('Atualizando informações…'); } },
      '-',
      hasProfile ? { label: 'Remover ajustes de imagem deste título', icon: 'sparkle', run: async () => {
        App.state.settings = await window.chimp.setSettings({ removeVideoProfile: item.id });
        App.toast('Ajustes de imagem removidos.', 'ok');
      } } : null,
      { label: 'Abrir pasta', icon: 'folder', run: () => window.chimp.shell.open(item.dir) },
    ].filter(Boolean));
  }

  function changeKind(item) {
    let choice = item.kind;
    App.modal({
      title: 'Alterar categoria',
      body: (b) => {
        b.append(h('p', null, `Em qual seção “${App.titleOf(item)}” deve aparecer?`));
        b.append(App.seg([['series', 'Série'], ['anime', 'Anime'], ['movie', 'Filme']], choice, (v) => { choice = v; }));
      },
      actions: [{ label: 'Cancelar' }, { label: 'Salvar', kind: 'btn-accent', run: () => window.chimp.library.setKind(item.id, choice) }],
    });
  }

  function fixMatch(item, opts = {}) {
    let kind = item.type === 'movie' ? 'movie' : 'tv';
    let showAs = item.kind;
    const input = h('input', { class: 'input', value: App.titleOf(item), placeholder: 'Nome do título' });
    const results = h('div', { class: 'match-grid' });
    const status = h('div', { class: 'hint', style: { marginTop: '10px' } });
    async function search() {
      const q = input.value.trim();
      if (!q) return;
      results.replaceChildren();
      status.replaceChildren(h('span', { class: 'spinner', style: { display: 'inline-block', verticalAlign: 'middle', marginRight: '8px' } }), 'Buscando…');
      try {
        const list = await window.chimp.library.search(q, kind);
        status.textContent = list.length ? 'Clique no título correto:' : 'Nada encontrado. Tente outro nome (em inglês ou no idioma original costuma funcionar melhor).';
        for (const c of list) {
          const img = c.poster ? h('img', { class: 'mp', src: App.remoteImg(c.poster), alt: '', onerror: (e) => { e.target.replaceWith(h('div', { class: 'mp' })); } }) : h('div', { class: 'mp' });
          results.append(h('div', {
            class: 'match', title: c.overview || '',
            onclick: async () => {
              status.replaceChildren(h('span', { class: 'spinner', style: { display: 'inline-block', verticalAlign: 'middle', marginRight: '8px' } }), 'Aplicando…');
              try {
                await window.chimp.library.applyMatch(item.id, { provider: c.provider, id: c.id, kind: c.kind, kindOverride: showAs });
                App.toast('Identificação atualizada.', 'ok');
                dlg.close();
                if (opts.onDone) opts.onDone();
              } catch (err) { status.textContent = err.message; }
            },
          }, img, h('div', { class: 'mt' }, c.title), h('div', { class: 'my' }, c.year ? String(c.year) : '', h('span', { class: 'prov' }, c.provider))));
        }
      } catch (err) { status.textContent = err.message; }
    }
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
    const dlg = App.modal({
      title: 'Corrigir identificação', wide: true,
      body: (b) => {
        b.append(h('div', { class: 'input-row' }, input,
          App.seg([['tv', 'Série / Anime'], ['movie', 'Filme']], kind, (v) => { kind = v; search(); }),
          h('button', { class: 'btn btn-sm btn-accent', onclick: search }, icon('search'), 'Buscar')));
        b.append(h('div', { class: 'field', style: { marginTop: '14px', marginBottom: '0' } }, h('div', { class: 'field-label' }, 'Mostrar na seção'),
          App.seg([['movie', 'Filmes'], ['series', 'Séries'], ['anime', 'Animes']], showAs, (v) => { showAs = v; })));
        b.append(status, results);
      },
      actions: [
        { label: 'Escolher capa do computador', run: async () => { const ok = await App.pickArt(item, 'poster'); return ok ? undefined : false; } },
        { label: 'Cadastrar manualmente', run: () => { setTimeout(() => App.manualRegister(item), 50); } },
      ],
    });
    search();
  }

  App.fixMatch = fixMatch;

  // Escolher uma imagem do computador como capa/fundo.
  App.pickArt = async function (item, kind) {
    const f = await window.chimp.shell.pickFile([{ name: 'Imagens', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]);
    if (!f) return false;
    try {
      await window.chimp.library.setArt(item.id, kind, f);
      App.toast(kind === 'poster' ? 'Capa atualizada.' : 'Imagem de fundo atualizada.', 'ok');
      return true;
    } catch (e) { App.toast(e.message, 'error'); return false; }
  };

  // Cadastro manual: nome, ano, seção, sinopse e imagens.
  App.manualRegister = function (item) {
    const m = item.meta || {};
    const title = h('input', { class: 'input', value: App.titleOf(item) });
    const year = h('input', { class: 'input', type: 'number', min: '1900', max: '2100', value: App.yearOf(item) || '' });
    const overview = h('textarea', { class: 'input', rows: '3', style: { fontFamily: 'inherit', fontSize: '14px' } });
    overview.value = m.overview || '';
    let kind = item.kind;
    const files = { poster: null, backdrop: null };
    const fileLabel = (k) => h('span', { class: 'hint', 'data-k': k }, item.localArt && item.localArt[k] ? 'Imagem atual mantida' : 'Nenhuma escolhida');
    const pick = (k, label) => h('div', { class: 'folder-item', style: { marginBottom: '8px' } }, icon('folder'), h('div', { class: 'p' }, label), fileLabel(k),
      h('button', { class: 'btn btn-xs btn-ghost', onclick: async (e) => {
        const f = await window.chimp.shell.pickFile([{ name: 'Imagens', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]);
        if (f) { files[k] = f; e.currentTarget.parentElement.querySelector(`[data-k="${k}"]`).textContent = f.split(/[\\/]/).pop(); }
      } }, 'Escolher'));
    App.modal({
      title: 'Cadastrar manualmente',
      body: (b) => {
        b.append(h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 140px', gap: '12px' } },
          h('div', { class: 'field' }, h('label', null, 'Nome'), title),
          h('div', { class: 'field' }, h('label', null, 'Ano'), year)));
        b.append(h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Seção'), App.seg([['movie', 'Filme'], ['series', 'Série'], ['anime', 'Anime']], kind, (v) => { kind = v; })));
        b.append(h('div', { class: 'field' }, h('label', null, 'Sinopse (opcional)'), overview));
        b.append(h('div', { class: 'field-label', style: { marginBottom: '8px' } }, 'Imagens'), pick('poster', 'Capa (vertical)'), pick('backdrop', 'Fundo (horizontal, opcional)'));
      },
      actions: [{ label: 'Cancelar' }, {
        label: 'Salvar', kind: 'btn-accent', run: async () => {
          await window.chimp.library.setManual(item.id, { title: title.value.trim(), year: year.value ? Number(year.value) : null, kind, overview: overview.value.trim() });
          for (const k of ['poster', 'backdrop']) if (files[k]) await window.chimp.library.setArt(item.id, k, files[k]);
          App.toast('Cadastro salvo.', 'ok');
        },
      }],
    });
  };

  // Confirmação de identificação (ex.: ao terminar um download).
  const confirmQueue = [];
  let confirmOpen = false;
  App.confirmIdentity = function (itemId, opts = {}) {
    confirmQueue.push({ itemId, opts });
    if (!confirmOpen) nextConfirm();
  };
  function nextConfirm() {
    const next = confirmQueue.shift();
    if (!next) { confirmOpen = false; return; }
    const item = App.state.itemsById[next.itemId];
    if (!item || item.confirmed) { nextConfirm(); return; }
    confirmOpen = true;
    const m = item.meta || {};
    const a = App.art(item);
    const found = item.metaStatus === 'ok' || item.metaStatus === 'manual';
    let kind = item.kind;
    const providerName = { imdb: 'IMDb', tmdb: 'TMDB', anilist: 'AniList', tvmaze: 'TVmaze', itunes: 'Apple TV / iTunes' }[m.provider] || '';
    const posterEl = a.poster ? h('img', { src: a.poster, alt: '', style: { width: '150px', aspectRatio: '2/3', objectFit: 'cover', borderRadius: '10px', flex: 'none', background: 'var(--surface-2)' } })
      : h('div', { style: { width: '150px', aspectRatio: '2/3', borderRadius: '10px', flex: 'none', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', fontSize: '12px', textAlign: 'center', padding: '10px' } }, 'Sem capa');
    const close = () => { setTimeout(nextConfirm, 200); };
    App.modal({
      title: found ? 'Confirme o título' : 'Não encontrei este título',
      onClose: close,
      body: (b) => {
        if (next.opts.torrentName) b.append(h('p', null, 'Download concluído: ', h('b', null, next.opts.torrentName)));
        b.append(h('div', { style: { display: 'flex', gap: '18px', alignItems: 'flex-start' } }, posterEl,
          h('div', { style: { minWidth: 0 } },
            h('div', { style: { fontSize: '20px', fontWeight: 800, letterSpacing: '-0.02em' } }, App.titleOf(item)),
            h('div', { class: 'meta-line', style: { margin: '6px 0 10px' } }, App.yearOf(item) ? String(App.yearOf(item)) : 'Ano desconhecido', providerName ? h('span', { class: 'chip' }, providerName) : null),
            m.overview ? h('p', { style: { display: '-webkit-box', WebkitLineClamp: '4', WebkitBoxOrient: 'vertical', overflow: 'hidden', margin: '0 0 12px' } }, m.overview)
              : h('p', null, found ? '' : 'Você pode buscar pelo nome certo ou cadastrar manualmente com a sua própria capa.'),
            h('div', { class: 'field-label', style: { marginBottom: '6px' } }, 'Mostrar na seção'),
            App.seg([['movie', 'Filme'], ['series', 'Série'], ['anime', 'Anime']], kind, (v) => { kind = v; }))));
        b.append(h('p', { class: 'hint', style: { marginTop: '14px', marginBottom: 0 } }, found ? 'A informação está batendo com o que você baixou?' : 'Escolha uma opção abaixo.'));
      },
      actions: [
        { label: 'Cadastrar manualmente', run: () => { setTimeout(() => App.manualRegister(item), 60); } },
        { label: found ? 'Não, buscar outro' : 'Buscar na internet', run: () => { setTimeout(() => fixMatch(item), 60); } },
        found ? { label: 'Sim, está certo', kind: 'btn-accent', run: async () => { await window.chimp.library.confirm(item.id, kind); App.toast(`“${App.titleOf(item)}” confirmado.`, 'ok'); } } : null,
      ].filter(Boolean),
    });
  }

})(window.App);
