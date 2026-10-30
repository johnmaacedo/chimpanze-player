'use strict';
/* Início, navegação por categoria e busca */
(function (App) {
  const { h, icon } = App;
  App.views = App.views || {};

  let heroTimer = null;

  function heroCandidates() {
    const items = App.allItems().filter((i) => i.meta && (i.meta.backdrop || (i.localArt && i.localArt.backdrop)));
    const cont = App.continueEntries().map((e) => e.item).filter((i) => items.includes(i));
    const recent = [...items].sort((a, b) => b.addedAt - a.addedAt);
    const picks = [];
    for (const i of [...cont.slice(0, 2), ...recent]) {
      if (!picks.includes(i)) picks.push(i);
      if (picks.length >= 6) break;
    }
    if (!picks.length) {
      // Sem fundo: usa pôster desfocado.
      const withPoster = App.allItems().filter((i) => App.art(i).poster);
      return withPoster.sort((a, b) => b.addedAt - a.addedAt).slice(0, 4);
    }
    return picks;
  }

  function heroEl(items) {
    if (!items.length) return null;
    const hero = h('section', { class: 'hero' });
    const bgA = h('div', { class: 'hero-bg show' });
    const bgB = h('div', { class: 'hero-bg hide' });
    const content = h('div', { class: 'hero-content' });
    const dots = h('div', { class: 'hero-dots' });
    hero.append(bgA, bgB, content, dots);
    let idx = 0;
    let front = bgA, back = bgB;

    function render(i, first) {
      const item = items[i];
      const a = App.art(item);
      const url = a.backdrop || a.poster;
      back.style.backgroundImage = url ? `url("${url}")` : '';
      back.classList.toggle('blur', !a.backdrop);
      if (first) { front.style.backgroundImage = back.style.backgroundImage; front.classList.toggle('blur', !a.backdrop); }
      else {
        back.classList.remove('hide'); back.classList.add('show');
        front.classList.remove('show'); front.classList.add('hide');
        [front, back] = [back, front];
      }
      const m = item.meta || {};
      const title = App.titleOf(item);
      const resume = App.resumeInfo(item);
      const meta = [];
      if (App.yearOf(item)) meta.push(String(App.yearOf(item)));
      meta.push(App.KIND_LABEL[item.kind] || '');
      if (item.type === 'show') {
        const seasons = new Set(item.episodes.map((e) => e.season)).size;
        meta.push(seasons > 1 ? `${seasons} temporadas` : `${item.episodes.length} episódio${item.episodes.length > 1 ? 's' : ''}`);
      } else if (m.runtime) meta.push(App.fmtDuration(m.runtime));
      const metaLine = h('div', { class: 'meta-line' });
      meta.filter(Boolean).forEach((t, k) => { if (k) metaLine.append(h('span', { class: 'dot' })); metaLine.append(h('span', null, t)); });
      if (m.rating) { metaLine.append(h('span', { class: 'dot' }), h('span', { class: 'rating' }, `★ ${String(m.rating).replace('.', ',')}`)); }
      const titleEl = h('h1', { class: 'hero-title' }, title);
      const logoUrl = a.logo;
      let titleNode = titleEl;
      if (logoUrl) {
        const img = h('img', { class: 'hero-logo', alt: title });
        img.onerror = () => img.replaceWith(titleEl);
        img.src = logoUrl;
        titleNode = img;
      }
      content.replaceChildren(
        h('div', { class: 'hero-kicker' }, resume && resume.progress > 0 ? 'Continue de onde parou' : (Date.now() - item.addedAt < 7 * 864e5 ? 'Novo na sua biblioteca' : 'Destaque')),
        titleNode,
        metaLine,
        m.overview ? h('p', { class: 'hero-overview' }, m.overview) : null,
        h('div', { class: 'hero-actions' },
          h('button', { class: 'btn btn-primary', onclick: () => App.playItem(item) }, icon('play'), resume ? resume.cta : 'Assistir'),
          h('button', { class: 'btn btn-ghost', onclick: () => App.openDetail(item.id) }, icon('info'), 'Mais informações')),
      );
      content.style.animation = 'none'; void content.offsetWidth; content.style.animation = '';
      dots.querySelectorAll('button').forEach((d, k) => d.classList.toggle('on', k === i));
    }

    items.forEach((_, k) => dots.append(h('button', { onclick: () => { idx = k; render(idx); restart(); } })));
    if (items.length < 2) dots.hidden = true;
    render(0, true);
    function restart() {
      clearInterval(heroTimer);
      if (items.length > 1 && App.state.settings.ui.heroAutoplay) heroTimer = setInterval(() => { if (document.hidden || App.state.detailOpen) return; idx = (idx + 1) % items.length; render(idx); }, 11000);
    }
    restart();
    return hero;
  }

  function byKind(kind) { return App.allItems().filter((i) => i.kind === kind); }

  App.views.home = function (root) {
    clearInterval(heroTimer);
    const items = App.allItems();
    if (!App.state.library.folders.length) return App.views.welcome(root);
    if (!items.length) {
      root.append(h('div', { class: 'page' }, h('div', { class: 'empty' },
        App.state.library.scanning ? h('div', { class: 'spinner lg' }) : icon('folder'),
        h('h2', null, App.state.library.scanning ? 'Procurando seus vídeos…' : 'Nenhum vídeo encontrado'),
        h('p', null, App.state.library.scanning ? 'Estou varrendo as pastas da biblioteca. Isso pode levar alguns instantes na primeira vez.' : 'Verifique se a pasta escolhida contém arquivos de vídeo (mkv, mp4, avi…). Você pode adicionar outras pastas nas configurações.'),
        App.state.library.scanning ? null : h('div', { class: 'hero-actions' },
          h('button', { class: 'btn btn-accent', onclick: () => App.pickFolder() }, icon('plus'), 'Adicionar pasta'),
          h('button', { class: 'btn btn-outline', onclick: () => window.chimp.library.scan() }, icon('refresh'), 'Procurar novamente')))));
      return;
    }
    const hero = heroEl(heroCandidates());
    const rows = h('div', { class: 'rows', style: hero ? null : { paddingTop: 'calc(var(--top) + 30px)' } });
    const add = (x) => { if (x) rows.append(x); };
    const cont = App.continueEntries();
    add(App.row('Continuar assistindo', cont.map((e) => App.wideCard(e))));
    const recent = [...items].sort((a, b) => b.addedAt - a.addedAt).slice(0, 24);
    const isNew = (i) => Date.now() - i.addedAt < 7 * 864e5;
    add(App.row('Adicionados recentemente', recent.map((i) => App.posterCard(i, { badge: isNew(i) ? 'Novo' : null, ...App.cardState(i) }))));
    const sections = [['series', 'Séries'], ['anime', 'Animes'], ['movie', 'Filmes']];
    for (const [k, label] of sections) {
      const list = byKind(k).sort((a, b) => App.titleOf(a).localeCompare(App.titleOf(b), 'pt'));
      add(App.row(label, list.slice(0, 40).map((i) => App.posterCard(i, App.cardState(i))), { more: () => App.navigate(k) }));
    }
    // Fileiras por gênero
    const genres = new Map();
    for (const i of items) for (const g of ((i.meta && i.meta.genres) || [])) { if (!genres.has(g)) genres.set(g, []); genres.get(g).push(i); }
    [...genres.entries()].filter(([, l]) => l.length >= 5).sort((a, b) => b[1].length - a[1].length).slice(0, 6).forEach(([g, l]) => {
      add(App.row(g, l.slice(0, 30).map((i) => App.posterCard(i, App.cardState(i)))));
    });
    // Itens não identificados
    const unknown = items.filter((i) => i.metaStatus === 'notfound');
    if (unknown.length) add(App.row('Sem identificação', unknown.map((i) => App.posterCard(i, { badge: '?' }))));
    root.append(h('div', null, hero, rows));
  };

  App.views.browse = function (root, kind) {
    clearInterval(heroTimer);
    const titles = { series: 'Séries', anime: 'Animes', movie: 'Filmes' };
    const st = App.state.browse[kind] || (App.state.browse[kind] = { sort: 'recent', genre: '' });
    const all = byKind(kind);
    const genres = [...new Set(all.flatMap((i) => (i.meta && i.meta.genres) || []))].sort((a, b) => a.localeCompare(b, 'pt'));
    const page = h('div', { class: 'page' });
    const grid = h('div', { class: 'grid' });
    function draw() {
      let list = all.filter((i) => !st.genre || ((i.meta && i.meta.genres) || []).includes(st.genre));
      if (st.sort === 'az') list.sort((a, b) => App.titleOf(a).localeCompare(App.titleOf(b), 'pt'));
      else if (st.sort === 'year') list.sort((a, b) => (App.yearOf(b) || 0) - (App.yearOf(a) || 0));
      else if (st.sort === 'rating') list.sort((a, b) => ((b.meta && b.meta.rating) || 0) - ((a.meta && a.meta.rating) || 0));
      else list.sort((a, b) => b.addedAt - a.addedAt);
      grid.replaceChildren(...list.map((i) => h('div', { class: 'grid-item' }, App.posterCard(i, App.cardState(i)), h('div', { class: 'card-title-below' }, App.titleOf(i)))));
      if (!list.length) grid.replaceChildren(h('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, h('h2', null, 'Nada por aqui ainda'), h('p', null, kind === 'movie' ? 'Nenhum filme encontrado nas pastas da biblioteca.' : 'Nenhum título desta categoria nas pastas da biblioteca.')));
    }
    const sortSel = h('select', { class: 'select', onchange: (e) => { st.sort = e.target.value; draw(); } },
      [['recent', 'Adicionados recentemente'], ['az', 'Ordem alfabética'], ['year', 'Ano de lançamento'], ['rating', 'Mais bem avaliados']].map(([v, l]) => { const o = h('option', { value: v }, l); if (v === st.sort) o.selected = true; return o; }));
    const genreSel = h('select', { class: 'select', onchange: (e) => { st.genre = e.target.value; draw(); } },
      h('option', { value: '' }, 'Todos os gêneros'), genres.map((g) => { const o = h('option', { value: g }, g); if (g === st.genre) o.selected = true; return o; }));
    page.append(h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, titles[kind]), h('span', { class: 'chip' }, `${all.length} título${all.length === 1 ? '' : 's'}`), h('div', { class: 'spacer' }), genres.length ? genreSel : null, sortSel), grid);
    draw();
    root.append(page);
  };

  App.views.search = function (root, q) {
    clearInterval(heroTimer);
    const nq = App.norm(q).trim();
    const items = App.allItems().filter((i) => {
      const hay = App.norm([App.titleOf(i), i.title, i.meta && i.meta.originalTitle, ...((i.meta && i.meta.genres) || [])].join(' '));
      return nq.split(/\s+/).every((w) => hay.includes(w));
    });
    const page = h('div', { class: 'page' },
      h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, `Resultados para “${q}”`), h('span', { class: 'chip' }, `${items.length}`)),
      items.length
        ? h('div', { class: 'grid' }, items.map((i) => h('div', { class: 'grid-item' }, App.posterCard(i, App.cardState(i)), h('div', { class: 'card-title-below' }, App.titleOf(i)))))
        : h('div', { class: 'empty' }, icon('search'), h('h2', null, 'Nada encontrado na biblioteca'), h('p', null, 'Quer procurar para baixar? Use a aba Fontes.'), h('button', { class: 'btn btn-outline', onclick: () => App.navigate('sources', { query: q }) }, icon('magnet'), 'Procurar nas fontes')));
    root.append(page);
  };

  App.views.welcome = function (root) {
    const lib = App.state.library;
    const scan = App.state.scan;
    const card = h('div', { class: 'welcome-card' },
      h('img', { class: 'welcome-logo', src: 'assets/logo.svg', alt: '' }),
      h('h1', null, 'Bem-vindo ao ', h('span', null, 'Chimpanzé Player')),
      h('div', { style: { marginBottom: '14px' } }, h('span', { class: 'alpha-tag' }, 'Versão Alpha')),
      h('p', null, 'Seu cinema particular. Escolha a pasta onde ficam seus filmes, séries e animes — eu organizo tudo, busco as capas e deixo pronto para assistir com a sua placa de vídeo.'),
      h('div', { class: 'hero-actions', style: { justifyContent: 'center' } },
        h('button', { class: 'btn btn-accent', onclick: () => App.pickFolder() }, icon('folder'), 'Escolher pasta da biblioteca')),
      lib.scanning ? h('div', { class: 'scan-progress' }, h('div', { class: 'spinner lg' }), `Encontrados ${scan.count || 0} vídeos…`) : null,
      h('div', { class: 'welcome-hint' }, 'Dica: organize como ', h('code', null, 'Séries/Nome da Série/Temporada 1'), ', ', h('code', null, 'Animes/Nome'), ' e ', h('code', null, 'Filmes/Nome (Ano).mkv'), ' — mas qualquer organização funciona.'));
    root.append(h('div', { class: 'welcome' }, card));
  };

  App.stopHero = () => clearInterval(heroTimer);
})(window.App);
