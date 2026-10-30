'use strict';
/* Controles do player: comunicação com o mpv via processo principal */
(function () {
  for (const proto of [Element.prototype, DocumentFragment.prototype]) {
    for (const m of ['append', 'prepend', 'replaceChildren']) {
      const orig = proto[m];
      proto[m] = function (...nodes) { return orig.apply(this, nodes.filter((n) => n != null && n !== false)); };
    }
  }
  const P = window.player;
  const $ = (id) => document.getElementById(id);
  const S = {}; // propriedades do mpv
  let info = null; // dados do título/episódios/vídeo
  let video = null; // ajustes de imagem atuais
  let panel = null; // 'image' | 'tracks' | 'episodes' | 'speed'
  let hideTimer = null;
  let seeking = false;
  let seekPreview = null;
  let endTimer = null;
  let win = { fullscreen: false, maximized: false };

  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15a1 1 0 0 0 1.52.85l12.2-7.5a1 1 0 0 0 0-1.7L8.52 3.65A1 1 0 0 0 7 4.5Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
    vol: '<svg viewBox="0 0 24 24"><path d="M3 9h4l5-4v14l-5-4H3V9Zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4ZM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z"/></svg>',
    volLow: '<svg viewBox="0 0 24 24"><path d="M3 9h4l5-4v14l-5-4H3V9Zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4Z"/></svg>',
    mute: '<svg viewBox="0 0 24 24"><path d="M3 9h4l5-4v14l-5-4H3V9Zm13.6.2 1.4-1.4 2.2 2.2 2.2-2.2 1.4 1.4-2.2 2.2 2.2 2.2-1.4 1.4-2.2-2.2-2.2 2.2-1.4-1.4 2.2-2.2-2.2-2.2Z"/></svg>',
    fs: '<svg viewBox="0 0 24 24"><path d="M4 4h6v2H6v4H4V4Zm10 0h6v6h-2V6h-4V4ZM4 14h2v4h4v2H4v-6Zm14 0h2v6h-6v-2h4v-4Z"/></svg>',
    fsExit: '<svg viewBox="0 0 24 24"><path d="M8 4h2v6H4V8h4V4Zm6 0h2v4h4v2h-6V4ZM4 14h6v6H8v-4H4v-2Zm10 0h6v2h-4v4h-2v-6Z"/></svg>',
    check: '<svg viewBox="0 0 24 24" class="ck"><path d="m9.5 16.2-4.2-4.2-1.4 1.4 5.6 5.6 11-11-1.4-1.4-9.6 9.6Z"/></svg>',
    fwd: '<svg viewBox="0 0 24 24"><path d="m8.6 19.4 7.4-7.4-7.4-7.4L10 3.2 18.8 12 10 20.8l-1.4-1.4Z"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M15.4 4.6 8 12l7.4 7.4-1.4 1.4L5.2 12 14 3.2l1.4 1.4Z"/></svg>',
  };

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }
  function b64url(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  const remoteImg = (u) => (u ? `chimp-img://r/${b64url(u)}` : null);
  const thumbImg = (p) => (p ? `chimp-img://t/${b64url(p)}?p=22` : null);
  function fmt(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  const cmd = (c) => P.cmd(c).catch(() => {});

  // ---------- visibilidade dos controles ----------
  function showUI(stay) {
    document.body.classList.remove('hide-ui');
    document.body.classList.add('show-ui');
    clearTimeout(hideTimer);
    if (!stay) hideTimer = setTimeout(maybeHide, 2800);
  }
  function maybeHide() {
    if (S.pause || panel || seeking || document.querySelector('#bottom:hover, #top:hover')) { hideTimer = setTimeout(maybeHide, 1500); return; }
    document.body.classList.add('hide-ui');
    document.body.classList.remove('show-ui');
  }
  let lastMove = 0;
  document.addEventListener('mousemove', (e) => {
    if (Math.abs(e.movementX) + Math.abs(e.movementY) < 2 && Date.now() - lastMove < 1000) return;
    lastMove = Date.now();
    showUI();
  });
  document.addEventListener('mouseleave', () => { clearTimeout(hideTimer); hideTimer = setTimeout(maybeHide, 600); });

  function toast(text, level = 'info', ms = 4200, actions) {
    const t = el('div', { class: `toast ${level}` }, el('span', null, text), actions ? el('span', { class: 'ta' }, actions) : null);
    $('toasts').append(t);
    while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
    setTimeout(() => t.remove(), ms);
    return t;
  }
  function flash(html) {
    const f = $('flash');
    f.innerHTML = html;
    f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  }

  // ---------- atualização da interface ----------
  function renderPlay() {
    $('btn-play').innerHTML = S.pause ? ICON.play : ICON.pause;
  }
  function renderVolume() {
    const v = Math.round(S.volume ?? 100);
    $('btn-mute').innerHTML = S.mute || v === 0 ? ICON.mute : v < 50 ? ICON.volLow : ICON.vol;
    if (document.activeElement !== $('vol')) $('vol').value = v;
    $('vol-n').textContent = String(v);
  }
  function renderTime() {
    const pos = seeking && seekPreview != null ? seekPreview : (S['time-pos'] || 0);
    const dur = S.duration || 0;
    $('t-cur').textContent = fmt(pos);
    $('t-dur').textContent = dur ? fmt(dur) : '--:--';
    const pct = dur ? Math.min(100, (pos / dur) * 100) : 0;
    $('seek-played').style.width = `${pct}%`;
    $('seek-thumb').style.left = `${pct}%`;
    // Botão "próximo episódio" perto do fim
    const remaining = dur - (S['time-pos'] || 0);
    $('skip-next').hidden = !(info && info.hasNext && dur > 300 && remaining > 0 && remaining < 45 && !$('endcard').innerHTML);
  }
  function renderBuffer() {
    const cache = S['demuxer-cache-state'];
    const box = $('seek-buffer');
    box.innerHTML = '';
    const dur = S.duration;
    if (!cache || !dur || !cache['seekable-ranges']) return;
    for (const r of cache['seekable-ranges']) {
      const a = Math.max(0, r.start / dur), b = Math.min(1, r.end / dur);
      box.append(el('i', { style: `left:${a * 100}%;width:${Math.max(0, b - a) * 100}%` }));
    }
  }
  function renderChapters() {
    const box = $('seek-chapters');
    box.innerHTML = '';
    const dur = S.duration;
    if (!dur || !Array.isArray(S['chapter-list'])) return;
    for (const c of S['chapter-list']) if (c.time > 1) box.append(el('i', { style: `left:${(c.time / dur) * 100}%` }));
  }
  function renderLoading() {
    const busy = S['paused-for-cache'] || (S['idle-active'] === false && S['time-pos'] == null && !S.pause) || (S.seeking && !S.pause);
    $('buffer').hidden = !busy;
    if (S['paused-for-cache'] && S['demuxer-cache-state']) {
      const c = S['demuxer-cache-state'];
      $('buffer-text').textContent = c['cache-duration'] != null ? `Carregando… ${Math.round(c['cache-duration'])}s em memória` : 'Carregando…';
    } else $('buffer-text').textContent = 'Carregando…';
  }
  function renderBadges() {
    const b = $('badges');
    b.innerHTML = '';
    const vp = S['video-params'];
    if (vp && vp.h) {
      const hgt = vp.h;
      const label = hgt >= 2000 ? '4K' : hgt >= 1400 ? '1440p' : hgt >= 1000 ? '1080p' : hgt >= 700 ? '720p' : `${hgt}p`;
      b.append(el('span', { class: 'badge' }, label));
      if (vp.gamma === 'pq' || vp.gamma === 'hlg' || (vp['colormatrix'] || '').includes('2020')) b.append(el('span', { class: 'badge' }, 'HDR'));
    }
    if (S['hwdec-current'] && S['hwdec-current'] !== 'no') b.append(el('span', { class: 'badge' }, 'GPU'));
    if (video) {
      if (video.upscaler === 'rtx') b.append(el('span', { class: 'badge hot' }, 'RTX VSR'));
      if (video.upscaler.startsWith('anime4k')) b.append(el('span', { class: 'badge hot' }, 'Anime4K'));
      if (video.motion === 'rife') b.append(el('span', { class: 'badge hot' }, `${info && info.rtx && info.rtx.installed && video.aiEngine !== 'vulkan' ? 'IA RTX' : 'IA'} ${(tuneState.targetFps || video.targetFps) || Math.round(S['display-fps'] || 60)} FPS`));
      if (video.motion === 'smooth') b.append(el('span', { class: 'badge' }, 'Suave'));
    }
  }
  function renderFsButton() {
    $('btn-fs').innerHTML = win.fullscreen ? ICON.fsExit : ICON.fs;
    document.body.classList.toggle('fullscreen', !!win.fullscreen);
    document.body.classList.toggle('maximized', !!win.maximized);
  }
  function renderInfo() {
    if (!info || !info.current) return;
    $('t-title').textContent = info.current.title || '';
    $('t-sub').textContent = info.current.subtitle || '';
    document.title = info.current.title || 'Chimpanzé Player';
    $('btn-next').hidden = !info.hasNext;
    $('btn-eps').hidden = !(info.current.episodes && info.current.episodes.length > 1);
    $('rew-n').textContent = String(info.skipSeconds);
    $('fwd-n').textContent = String(info.skipSeconds);
    $('btn-rew').title = `Voltar ${info.skipSeconds}s (←)`;
    $('btn-fwd').title = `Avançar ${info.skipSeconds}s (→)`;
  }
  function renderSpeed() { $('speed-n').textContent = `${Number(S.speed || 1).toString().replace('.', ',')}×`; }

  // ---------- eventos vindos do processo principal ----------
  P.on('player:prop', ({ name, value }) => {
    S[name] = value;
    switch (name) {
      case 'pause': renderPlay(); if (value) showUI(true); else showUI(); renderLoading(); break;
      case 'time-pos': case 'duration': renderTime(); if (name === 'duration') renderChapters(); renderLoading(); break;
      case 'volume': case 'mute': renderVolume(); break;
      case 'demuxer-cache-state': renderBuffer(); renderLoading(); break;
      case 'paused-for-cache': case 'seeking': case 'idle-active': renderLoading(); break;
      case 'chapter-list': renderChapters(); break;
      case 'video-params': case 'hwdec-current': renderBadges(); break;
      case 'speed': renderSpeed(); break;
      case 'track-list': case 'sid': case 'aid': case 'sub-delay': case 'audio-delay': if (panel === 'tracks') renderPanel(); break;
      default: break;
    }
    if (!$('stats').hidden) renderStats();
  });
  P.on('player:info', (d) => {
    info = d;
    video = d.video;
    renderInfo();
    renderBadges();
    hideEnd();
    if (d.resumeFrom > 0) {
      toast(`Retomando de ${fmt(d.resumeFrom)}`, 'info', 6000, el('button', { class: 'pbtn', onclick: () => cmd({ type: 'seek-abs', sec: 0 }) }, 'Do início'));
    }
    if (panel) renderPanel();
  });
  P.on('player:video', (v) => { video = v; renderBadges(); if (panel === 'image') renderPanel(true); });
  let tuneState = {};
  P.on('player:tune', (t) => { tuneState = (t && t.tune) || {}; if (panel === 'image') renderPanel(true); });
  P.on('player:toast', (t) => toast(t.text, t.level, t.level === 'error' ? 9000 : 5000));
  P.on('player:window', (w) => { win = w; renderFsButton(); });
  P.on('player:loaded', () => { hideEnd(); showUI(); });
  P.on('player:ended', (d) => showEnd(d));

  // ---------- fim do vídeo / próximo episódio ----------
  function hideEnd() { clearInterval(endTimer); $('endcard').hidden = true; $('endcard').innerHTML = ''; }
  function showEnd(d) {
    hideEnd();
    const box = $('endcard');
    if (d.next) {
      const img = d.next.still ? remoteImg(d.next.still) : thumbImg(d.next.path);
      const count = el('div', { class: 'count' });
      const card = el('div', { class: 'ec' },
        el('div', { class: 'img' }, img ? el('img', { src: img, onerror: (e) => e.target.remove() }) : null, count),
        el('div', { class: 'bd' },
          el('div', { class: 'k' }, d.autoNext ? 'Próximo episódio em instantes' : 'Próximo episódio'),
          el('div', { class: 't' }, `T${d.next.season}:E${d.next.episode}${d.next.title ? ' · ' + d.next.title : ''}`),
          el('div', { class: 'bt' },
            el('button', { class: 'pbtn primary', onclick: () => { hideEnd(); cmd({ type: 'next' }); } }, '▶  Assistir agora'),
            el('button', { class: 'pbtn', onclick: () => { hideEnd(); } }, 'Cancelar'),
            el('button', { class: 'pbtn', onclick: () => cmd({ type: 'close' }) }, 'Sair'))));
      box.append(card);
      box.hidden = false;
      showUI(true);
      if (d.autoNext) {
        const total = 8000; const start = Date.now();
        endTimer = setInterval(() => {
          const p = Math.min(1, (Date.now() - start) / total);
          count.style.width = `${p * 100}%`;
          if (p >= 1) { clearInterval(endTimer); hideEnd(); cmd({ type: 'next' }); }
        }, 50);
      }
    } else {
      box.append(el('div', { class: 'ec' }, el('div', { class: 'bd' },
        el('div', { class: 'k' }, 'Fim'),
        el('div', { class: 't' }, info && info.current ? info.current.title : ''),
        el('div', { class: 'bt' },
          el('button', { class: 'pbtn primary', onclick: () => cmd({ type: 'close' }) }, 'Voltar à biblioteca'),
          el('button', { class: 'pbtn', onclick: () => { hideEnd(); cmd({ type: 'restart' }); cmd({ type: 'set-pause', value: false }); } }, 'Assistir de novo')))));
      box.hidden = false;
      showUI(true);
    }
  }

  // ---------- barra de progresso ----------
  const seekEl = $('seek');
  function posFromEvent(e) {
    const r = $('seek-track').getBoundingClientRect();
    const x = Math.min(Math.max(0, e.clientX - r.left), r.width);
    return { frac: r.width ? x / r.width : 0, x };
  }
  seekEl.addEventListener('mousemove', (e) => {
    const { frac, x } = posFromEvent(e);
    const tip = $('seek-tip');
    const t = frac * (S.duration || 0);
    let label = fmt(t);
    if (Array.isArray(S['chapter-list'])) {
      const ch = [...S['chapter-list']].reverse().find((c) => c.time <= t);
      if (ch && ch.title) label += ` · ${ch.title}`;
    }
    tip.textContent = label;
    const r = $('seek-track').getBoundingClientRect();
    tip.style.left = `${Math.min(Math.max(x, 40), r.width - 40)}px`;
    if (seeking) { seekPreview = t; renderTime(); }
  });
  seekEl.addEventListener('pointerdown', (e) => {
    if (!S.duration) return;
    seeking = true;
    seekEl.classList.add('drag');
    seekEl.setPointerCapture(e.pointerId);
    seekPreview = posFromEvent(e).frac * S.duration;
    renderTime();
  });
  seekEl.addEventListener('pointermove', (e) => {
    if (!seeking) return;
    seekPreview = posFromEvent(e).frac * S.duration;
    renderTime();
  });
  seekEl.addEventListener('pointerup', (e) => {
    if (!seeking) return;
    seeking = false;
    seekEl.classList.remove('drag');
    const t = posFromEvent(e).frac * S.duration;
    seekPreview = null;
    hideEnd();
    cmd({ type: 'seek-abs', sec: t });
  });

  // ---------- botões ----------
  const skip = () => (info ? info.skipSeconds : 10);
  $('btn-play').addEventListener('click', () => { cmd({ type: 'toggle-pause' }); flash(S.pause ? ICON.play : ICON.pause); });
  $('btn-rew').addEventListener('click', () => { cmd({ type: 'seek-rel', sec: -skip() }); flash(`<span class="lbl">−${skip()}s</span>`); });
  $('btn-fwd').addEventListener('click', () => { cmd({ type: 'seek-rel', sec: skip() }); flash(`<span class="lbl">+${skip()}s</span>`); });
  $('btn-mute').addEventListener('click', () => cmd({ type: 'toggle-mute' }));
  $('vol').addEventListener('input', (e) => { cmd({ type: 'set-volume', value: Number(e.target.value) }); $('vol-n').textContent = e.target.value; });
  $('btn-fs').addEventListener('click', () => cmd({ type: 'fullscreen' }));
  $('btn-back').addEventListener('click', () => cmd({ type: 'close' }));
  $('btn-next').addEventListener('click', () => cmd({ type: 'next' }));
  $('skip-next').addEventListener('click', () => cmd({ type: 'next' }));
  $('btn-image').addEventListener('click', () => togglePanel('image'));
  $('btn-tracks').addEventListener('click', () => togglePanel('tracks'));
  $('btn-eps').addEventListener('click', () => togglePanel('episodes'));
  $('btn-speed').addEventListener('click', () => togglePanel('speed'));
  $('btn-stats').addEventListener('click', toggleStats);
  $('panel-close').addEventListener('click', () => togglePanel(null));
  document.querySelectorAll('[data-w]').forEach((b) => b.addEventListener('click', () => cmd({ type: b.dataset.w === 'close' ? 'close' : b.dataset.w })));

  // Clique no vídeo: pausa; duplo clique: tela cheia.
  let clickTimer = null;
  $('hit').addEventListener('click', () => {
    if (panel) { togglePanel(null); return; }
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => { cmd({ type: 'toggle-pause' }); flash(S.pause ? ICON.play : ICON.pause); }, 220);
  });
  $('hit').addEventListener('dblclick', () => { clearTimeout(clickTimer); cmd({ type: 'fullscreen' }); });
  $('hit').addEventListener('wheel', (e) => { cmd({ type: 'add-volume', value: e.deltaY < 0 ? 5 : -5 }); showUI(); }, { passive: true });

  // Arrastar a janela pela barra superior e redimensionar pelo canto.
  function dragHandler(target, type) {
    let last = null;
    target.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || win.fullscreen) return;
      if (type === 'drag' && e.target.closest('button')) return;
      last = { x: e.screenX, y: e.screenY };
      target.setPointerCapture(e.pointerId);
    });
    target.addEventListener('pointermove', (e) => {
      if (!last) return;
      const dx = e.screenX - last.x, dy = e.screenY - last.y;
      if (!dx && !dy) return;
      last = { x: e.screenX, y: e.screenY };
      if (type === 'drag') cmd({ type: 'drag', dx, dy }); else cmd({ type: 'resize', dw: dx, dh: dy });
    });
    target.addEventListener('pointerup', () => { last = null; });
    target.addEventListener('dblclick', (e) => { if (type === 'drag' && !e.target.closest('button')) cmd({ type: 'maximize' }); });
  }
  dragHandler($('top'), 'drag');
  dragHandler($('grip'), 'resize');

  // ---------- painéis ----------
  function togglePanel(name) {
    panel = panel === name ? null : name;
    $('panel').hidden = !panel;
    document.body.classList.toggle('panel-open', !!panel);
    ['image', 'tracks', 'episodes', 'speed'].forEach((n) => { const b = $(`btn-${n === 'episodes' ? 'eps' : n}`); if (b) b.classList.toggle('on', panel === n); });
    if (panel) { renderPanel(); showUI(true); } else showUI();
  }

  function renderPanel(keepScroll) {
    const body = $('panel-body');
    const st = body.scrollTop;
    body.innerHTML = '';
    const foot = document.querySelector('.panel-foot');
    if (foot) foot.remove();
    if (panel === 'image') { $('panel-title').textContent = 'Imagem e IA'; buildImagePanel(body); }
    if (panel === 'tracks') { $('panel-title').textContent = 'Áudio e legendas'; buildTracksPanel(body); }
    if (panel === 'episodes') { $('panel-title').textContent = 'Episódios'; buildEpisodesPanel(body); }
    if (panel === 'speed') { $('panel-title').textContent = 'Velocidade'; buildSpeedPanel(body); }
    if (keepScroll) body.scrollTop = st;
  }

  let pendingPatch = {};
  let patchTimer = null;
  function setVideo(patch, immediate) {
    Object.assign(video, patch);
    Object.assign(pendingPatch, patch);
    clearTimeout(patchTimer);
    const run = () => { const p = pendingPatch; pendingPatch = {}; cmd({ type: 'set-video', patch: p }); };
    if (immediate) run(); else patchTimer = setTimeout(run, 45);
    renderBadges();
  }

  function slider(label, key, min, max, step, fmtv, def = 0) {
    const input = el('input', { type: 'range', min, max, step, value: video[key] });
    const val = el('span', { class: 'v' }, fmtv(video[key]));
    const row = el('div', { class: `slider${video[key] !== def ? ' changed' : ''}`, title: 'Duplo clique para zerar' }, el('span', { class: 'lbl' }, label), input, val);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      val.textContent = fmtv(v);
      row.classList.toggle('changed', v !== def);
      setVideo({ [key]: v });
    });
    row.addEventListener('dblclick', () => { input.value = def; input.dispatchEvent(new Event('input')); });
    return row;
  }
  const signed = (v) => (v > 0 ? `+${v}` : String(v));
  const pct = (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;

  function chips(options, value, onpick) {
    return el('div', { class: 'chips' }, options.map(([v, label, disabled]) => el('button', {
      class: `chip${String(v) === String(value) ? ' on' : ''}`, disabled: !!disabled,
      onclick: () => onpick(v),
    }, label)));
  }
  function sw(checked, onchange) {
    const i = el('input', { type: 'checkbox' });
    i.checked = !!checked;
    i.addEventListener('change', () => onchange(i.checked));
    return el('label', { class: 'switch' }, i, el('i'));
  }

  function buildImagePanel(body) {
    if (!video) return;
    const presetNames = { padrao: 'Padrão', cinema: 'Cinema', vivido: 'Vívido', anime: 'Anime', fluido: 'Fluido 60 FPS' };
    body.append(el('div', { class: 'sec' }, el('div', { class: 'sec-t' }, 'Predefinições'),
      chips(Object.keys(presetNames).map((k) => [k, presetNames[k]]), null, (k) => cmd({ type: 'preset', name: k }))));

    const cor = el('div', { class: 'sec' }, el('div', { class: 'sec-t' }, 'Cor e luz', el('button', { class: 'reset', onclick: () => setVideo({ exposure: 0, brightness: 0, contrast: 0, saturation: 0, gamma: 0, hue: 0, temperature: 0, tint: 0, vibrance: 0 }, true) || renderPanel(true) }, 'Zerar')));
    cor.append(
      slider('Exposição', 'exposure', -3, 3, 0.05, (v) => `${v > 0 ? '+' : ''}${Number(v).toFixed(2).replace('.', ',')}`),
      slider('Brilho', 'brightness', -100, 100, 1, signed),
      slider('Contraste', 'contrast', -100, 100, 1, signed),
      slider('Saturação', 'saturation', -100, 100, 1, signed),
      slider('Vibrância', 'vibrance', -1, 1, 0.01, pct),
      slider('Gama', 'gamma', -100, 100, 1, signed),
      slider('Temperatura', 'temperature', -1, 1, 0.01, pct),
      slider('Tonalidade', 'tint', -1, 1, 0.01, pct),
      slider('Matiz', 'hue', -100, 100, 1, signed));
    body.append(cor);

    const nit = el('div', { class: 'sec' }, el('div', { class: 'sec-t' }, 'Nitidez'));
    nit.append(slider('Nitidez', 'sharpness', 0, 2, 0.05, (v) => `${Math.round(v * 100)}%`));
    nit.append(el('div', { class: 'row' }, el('span', null, 'Remover faixas (debanding)'), sw(video.deband, (v) => setVideo({ deband: v }, true))));
    body.append(nit);

    const ia = el('div', { class: 'sec' }, el('div', { class: 'sec-t' }, 'Upscale com IA'));
    const win32 = info && info.isWindows;
    ia.append(chips([
      ['none', 'Desligado'],
      ['rtx', 'RTX Super Resolution', !win32],
      ['anime4k-a', 'Anime4K A'], ['anime4k-b', 'Anime4K B'], ['anime4k-c', 'Anime4K C'],
    ], video.upscaler, (v) => { setVideo({ upscaler: v }, true); renderPanel(true); }));
    const notes = {
      none: 'Escala de alta qualidade (EWA Lanczos) sem IA.',
      rtx: 'Usa os Tensor Cores da sua RTX. Ative em Painel de Controle NVIDIA › Ajustar configurações de imagem de vídeo › Aprimoramento de vídeo RTX › Super resolução.',
      'anime4k-a': 'Restaura e amplia animes com borrão (fontes 1080p).',
      'anime4k-b': 'Restaura animes com serrilhado (fontes 720p), mais suave.',
      'anime4k-c': 'Remove ruído e amplia (fontes SD/480p).',
    };
    ia.append(el('div', { class: 'note' }, notes[video.upscaler] || ''));
    if (video.upscaler.startsWith('anime4k')) ia.append(el('div', { class: 'row' }, el('span', null, 'Qualidade máxima (mais GPU)'), sw(video.anime4kQuality === 'hq', (v) => setVideo({ anime4kQuality: v ? 'hq' : 'fast' }, true))));
    if (win32) ia.append(el('div', { class: 'row' }, el('span', null, 'RTX Video HDR (SDR → HDR)'), sw(video.rtxHdr, (v) => setVideo({ rtxHdr: v }, true))));
    if (video.rtxHdr) ia.append(el('div', { class: 'note' }, 'Requer monitor HDR com o HDR do Windows ligado.'));
    body.append(ia);

    const fl = el('div', { class: 'sec' }, el('div', { class: 'sec-t' }, 'Fluidez'));
    fl.append(chips([['rife', '60 FPS (IA RTX)'], ['off', 'Original']], video.motion, (v) => { setVideo({ motion: v }, true); renderPanel(true); }));
    const hz = info ? info.displayHz : 60;
    if (video.motion === 'smooth') fl.append(el('div', { class: 'note' }, `Sincroniza cada quadro com o monitor (${hz} Hz) e mistura quadros para eliminar trepidação. Leve e sem artefatos.`));
    if (video.motion === 'rife') {
      const rtxI = info && info.rtx;
      const rtxOk = !!(rtxI && rtxI.installed);
      fl.append(el('div', { class: 'sec-t', style: 'margin-top:14px' }, 'Motor da IA'));
      fl.append(chips([['auto', 'Automático'], ['rtx', 'RTX (Tensor Cores)', !(info && info.isWindows)], ['vulkan', 'Vulkan']], video.aiEngine, (v) => { setVideo({ aiEngine: v }, true); renderPanel(true); }));
      const usingRtx = rtxOk && video.aiEngine !== 'vulkan';
      fl.append(el('div', { class: `note${!rtxOk && video.aiEngine === 'rtx' ? ' warn' : ''}` }, rtxOk
        ? (usingRtx ? `Usando TensorRT nos Tensor Cores${rtxI.device ? ' da ' + rtxI.device : ''}. É o modo mais rápido.` : 'Motor Vulkan: funciona em qualquer placa, mas é bem mais lento que o RTX.')
        : 'O motor RTX ainda está sendo preparado (veja Configurações › Imagem e IA). Até lá, o vídeo toca no original.'));
      fl.append(el('div', { class: 'sec-t', style: 'margin-top:14px' }, 'Modelo de IA'));
      fl.append(chips([['fast', 'Rápido'], ['balanced', 'Equilibrado'], ['quality', 'Qualidade']], video.rifeModel, (v) => { setVideo({ rifeModel: v }, true); renderPanel(true); }));
      fl.append(el('div', { class: 'sec-t', style: 'margin-top:14px' }, 'Resolução da IA'));
      fl.append(chips([['auto', 'Automática'], ['native', 'Nativa'], ['1080', '1080p'], ['720', '720p']], video.aiRes, (v) => { setVideo({ aiRes: v }, true); renderPanel(true); }));
      fl.append(el('div', { class: 'note' }, 'Quanto menor, mais leve. A IA cria os quadros nessa resolução e a imagem final continua sendo ampliada para a tela.'));
      fl.append(el('div', { class: 'row' }, el('span', null, 'Auto-ajuste contra travadas'), sw(video.aiAdaptive, (v) => setVideo({ aiAdaptive: v }, true))));
      const vh = S['video-dec-params'] && S['video-dec-params'].h;
      if (vh && vh > 1500) fl.append(el('div', { class: 'note warn' }, 'Vídeo 4K: a IA trabalha em até 1080p e a imagem é ampliada depois.'));
      if (tuneState && Object.keys(tuneState).length) {
        const labels = { anime4kQuality: 'Anime4K leve', rifeModel: 'modelo ' + ({ fast: 'rápido', balanced: 'equilibrado' }[tuneState.rifeModel] || ''), targetFps: `${tuneState.targetFps} FPS`, aiRes: `IA em ${tuneState.aiRes}p`, upscaler: 'Anime4K desligado', motion: 'modo Suave' };
        fl.append(el('div', { class: 'note warn' }, 'Auto-ajuste aplicado nesta sessão: ' + Object.keys(tuneState).map((k) => labels[k] || k).join(', ') + '.'));
      }
      const vf = Number(S['estimated-vf-fps']);
      if (vf) fl.append(el('div', { class: 'note' }, `Saída atual: ${vf.toFixed(1).replace('.', ',')} FPS`));
    }
    body.append(fl);

    const foot = el('div', { class: 'panel-foot' },
      info && info.current && info.current.itemId ? el('button', { class: 'pbtn primary', onclick: () => cmd({ type: 'save-video-show' }) }, info.hasShowProfile ? 'Atualizar para este título' : 'Salvar para este título') : null,
      el('button', { class: 'pbtn', onclick: () => cmd({ type: 'save-video-default' }) }, 'Salvar como padrão'),
      info && info.hasShowProfile ? el('button', { class: 'pbtn', onclick: () => cmd({ type: 'clear-video-show' }) }, 'Usar padrão') : null,
      el('button', { class: 'pbtn', onclick: () => cmd({ type: 'reset-video' }) }, 'Restaurar'));
    $('panel').append(foot);
  }

  function trackLabel(t) {
    const lang = t.lang ? langName(t.lang) : '';
    const parts = [t.title, lang].filter(Boolean);
    let s = parts.length ? [...new Set(parts)].join(' · ') : `Faixa ${t.id}`;
    return s;
  }
  function trackDesc(t) {
    const d = [];
    if (t.codec) d.push(String(t.codec).toUpperCase());
    if (t['demux-channel-count']) d.push(t['demux-channel-count'] >= 6 ? `${t['demux-channel-count'] - 1}.1` : `${t['demux-channel-count']} canais`);
    if (t.external) d.push('externa');
    if (t.forced) d.push('forçada');
    if (t.default) d.push('padrão');
    return d.join(' · ');
  }
  const LANGS = { por: 'Português', pt: 'Português', 'pt-br': 'Português (BR)', pob: 'Português (BR)', eng: 'Inglês', en: 'Inglês', jpn: 'Japonês', ja: 'Japonês', spa: 'Espanhol', es: 'Espanhol', fre: 'Francês', fra: 'Francês', fr: 'Francês', ger: 'Alemão', deu: 'Alemão', de: 'Alemão', ita: 'Italiano', it: 'Italiano', kor: 'Coreano', ko: 'Coreano', chi: 'Chinês', zho: 'Chinês', zh: 'Chinês', rus: 'Russo', ru: 'Russo', ara: 'Árabe', und: '' };
  function langName(l) { return LANGS[String(l).toLowerCase()] ?? String(l).toUpperCase(); }

  function buildTracksPanel(body) {
    const tracks = S['track-list'] || [];
    const audio = tracks.filter((t) => t.type === 'audio');
    const subs = tracks.filter((t) => t.type === 'sub');
    const a = el('div', { class: 'sec' }, el('div', { class: 'sec-t' }, 'Áudio'));
    if (!audio.length) a.append(el('div', { class: 'note' }, 'Sem faixas de áudio.'));
    for (const t of audio) {
      a.append(el('div', { class: `opt${t.selected ? ' on' : ''}`, onclick: () => cmd({ type: 'set-track', kind: 'aid', id: t.id }) },
        t.selected ? el('span', { html: ICON.check }) : el('span', { style: 'width:18px' }),
        el('div', null, el('div', null, trackLabel(t)), el('div', { class: 'd' }, trackDesc(t)))));
    }
    body.append(a);
    const s = el('div', { class: 'sec' }, el('div', { class: 'sec-t' }, 'Legendas'));
    const noneOn = !subs.some((t) => t.selected);
    s.append(el('div', { class: `opt${noneOn ? ' on' : ''}`, onclick: () => cmd({ type: 'set-track', kind: 'sid', id: 'no' }) }, noneOn ? el('span', { html: ICON.check }) : el('span', { style: 'width:18px' }), el('div', null, 'Desligadas')));
    for (const t of subs) {
      s.append(el('div', { class: `opt${t.selected ? ' on' : ''}`, onclick: () => cmd({ type: 'set-track', kind: 'sid', id: t.id }) },
        t.selected ? el('span', { html: ICON.check }) : el('span', { style: 'width:18px' }),
        el('div', null, el('div', null, trackLabel(t)), el('div', { class: 'd' }, trackDesc(t)))));
    }
    body.append(s);
    const sync = el('div', { class: 'sec' }, el('div', { class: 'sec-t' }, 'Sincronia'));
    const delayRow = (label, prop, type) => el('div', { class: 'delay' }, el('span', { class: 'lbl' }, label),
      el('button', { class: 'pbtn', onclick: () => cmd({ type, value: -0.1 }) }, '−0,1s'),
      el('span', { class: 'val' }, `${Number(S[prop] || 0).toFixed(1).replace('.', ',')}s`),
      el('button', { class: 'pbtn', onclick: () => cmd({ type, value: 0.1 }) }, '+0,1s'));
    sync.append(delayRow('Legenda', 'sub-delay', 'sub-delay'), delayRow('Áudio', 'audio-delay', 'audio-delay'));
    body.append(sync);
  }

  function buildEpisodesPanel(body) {
    const eps = (info && info.current && info.current.episodes) || [];
    const cur = info && info.current ? info.current.episodeId : null;
    let lastSeason = null;
    for (const e of eps) {
      if (e.season !== lastSeason) {
        lastSeason = e.season;
        body.append(el('div', { class: 'sec-t', style: 'margin-top:16px' }, e.season === 0 ? 'Especiais' : `Temporada ${e.season}`));
      }
      const src = e.still ? remoteImg(e.still) : thumbImg(e.path);
      const row = el('div', { class: `ep${e.id === cur ? ' on' : ''}`, onclick: () => { cmd({ type: 'play-episode', id: e.id }); togglePanel(null); } },
        el('div', { class: 'th' }, src ? el('img', { src, loading: 'lazy', onerror: (ev) => ev.target.remove() }) : null),
        el('div', null, el('div', { class: 'et' }, `${e.episode}. ${e.title || 'Episódio ' + e.episode}`), el('div', { class: 'es' }, e.id === cur ? 'Assistindo agora' : '')));
      body.append(row);
      if (e.id === cur) setTimeout(() => row.scrollIntoView({ block: 'center' }), 30);
    }
  }

  function buildSpeedPanel(body) {
    const speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    const s = el('div', { class: 'sec' });
    for (const v of speeds) {
      const on = Math.abs((S.speed || 1) - v) < 0.01;
      s.append(el('div', { class: `opt${on ? ' on' : ''}`, onclick: () => { cmd({ type: 'set-speed', value: v }); setTimeout(() => renderPanel(), 80); } },
        on ? el('span', { html: ICON.check }) : el('span', { style: 'width:18px' }), el('div', null, v === 1 ? 'Normal' : `${String(v).replace('.', ',')}×`)));
    }
    body.append(s);
  }

  // ---------- estatísticas ----------
  function toggleStats() {
    $('stats').hidden = !$('stats').hidden;
    $('btn-stats').classList.toggle('on', !$('stats').hidden);
    if (!$('stats').hidden) renderStats();
  }
  function renderStats() {
    const vp = S['video-params'] || {};
    const hw = S['hwdec-current'];
    const drop = Number(S['frame-drop-count'] || 0);
    const delayed = Number(S['vo-delayed-frame-count'] || 0);
    const line = (k, v, cls) => `<div><span class="k">${k}</span><span class="${cls || ''}">${v}</span></div>`;
    const motion = video ? { off: 'Original', smooth: 'Original', rife: 'IA RIFE → 60 FPS' }[video.motion] : '—';
    const ups = video ? { none: 'Nenhum (EWA Lanczos)', rtx: 'NVIDIA RTX VSR', 'anime4k-a': 'Anime4K A', 'anime4k-b': 'Anime4K B', 'anime4k-c': 'Anime4K C' }[video.upscaler] : '—';
    $('stats').innerHTML = [
      line('Resolução', vp.w ? `${vp.w}×${vp.h}` : '—'),
      line('Codec', (S['video-codec'] || '—').split(' ')[0]),
      line('Decodificação', hw && hw !== 'no' ? `GPU (${hw})` : 'CPU (software)', hw && hw !== 'no' ? 'good' : 'bad'),
      line('Cores', vp.primaries ? `${vp.primaries} / ${vp.gamma || ''}` : '—'),
      line('FPS do arquivo', S['container-fps'] ? Number(S['container-fps']).toFixed(3) : '—'),
      line('FPS exibido', S['estimated-vf-fps'] ? Number(S['estimated-vf-fps']).toFixed(2) : '—', 'good'),
      line('Monitor', S['display-fps'] ? `${Number(S['display-fps']).toFixed(2)} Hz` : (info ? `${info.displayHz} Hz` : '—')),
      line('Quadros perdidos', String(drop), drop > 20 ? 'bad' : ''),
      line('Quadros atrasados', String(delayed), delayed > 50 ? 'bad' : ''),
      line('Upscale', ups),
      line('Interpolação', motion),
      line('Áudio', S['audio-codec-name'] || '—'),
      line('Bitrate de vídeo', S['video-bitrate'] ? `${(S['video-bitrate'] / 1e6).toFixed(1)} Mb/s` : '—'),
    ].join('');
  }
  setInterval(() => { if (!$('stats').hidden) renderStats(); }, 1000);

  // ---------- teclado ----------
  document.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    const k = e.key;
    const sk = skip();
    let handled = true;
    switch (k) {
      case ' ': case 'k': case 'K': case 'MediaPlayPause': cmd({ type: 'toggle-pause' }); flash(S.pause ? ICON.play : ICON.pause); break;
      case 'ArrowLeft': case 'j': case 'J': cmd({ type: 'seek-rel', sec: e.shiftKey ? -60 : -sk }); flash(`<span class="lbl">−${e.shiftKey ? 60 : sk}s</span>`); break;
      case 'ArrowRight': case 'l': case 'L': cmd({ type: 'seek-rel', sec: e.shiftKey ? 60 : sk }); flash(`<span class="lbl">+${e.shiftKey ? 60 : sk}s</span>`); break;
      case 'ArrowUp': cmd({ type: 'add-volume', value: 5 }); break;
      case 'ArrowDown': cmd({ type: 'add-volume', value: -5 }); break;
      case 'f': case 'F': case 'F11': cmd({ type: 'fullscreen' }); break;
      case 'Enter': if (e.altKey) cmd({ type: 'fullscreen' }); else handled = false; break;
      case 'm': case 'M': cmd({ type: 'toggle-mute' }); break;
      case 'e': case 'E': togglePanel('image'); break;
      case 's': case 'S': cmd({ type: 'cycle-sub' }); break;
      case 'a': case 'A': cmd({ type: 'cycle-audio' }); break;
      case 'n': case 'N': if (info && info.hasNext) cmd({ type: 'next' }); break;
      case 'i': case 'I': toggleStats(); break;
      case 'p': case 'P': cmd({ type: 'screenshot' }); break;
      case ',': cmd({ type: 'seek-frame', dir: -1 }); break;
      case '.': cmd({ type: 'seek-frame', dir: 1 }); break;
      case '[': cmd({ type: 'set-speed', value: Math.max(0.25, (S.speed || 1) - 0.25) }); break;
      case ']': cmd({ type: 'set-speed', value: Math.min(4, (S.speed || 1) + 0.25) }); break;
      case 'Home': cmd({ type: 'seek-abs', sec: 0 }); break;
      case 'Escape':
        if (panel) togglePanel(null);
        else if (!$('stats').hidden) toggleStats();
        else if (win.fullscreen) cmd({ type: 'fullscreen', value: false });
        else cmd({ type: 'close' });
        break;
      case 'Backspace': cmd({ type: 'close' }); break;
      default:
        if (/^[0-9]$/.test(k) && S.duration) cmd({ type: 'seek-abs', sec: (Number(k) / 10) * S.duration });
        else handled = false;
    }
    if (handled) { e.preventDefault(); showUI(); }
  });

  // Estado inicial
  renderPlay(); renderVolume(); renderTime(); renderFsButton(); renderSpeed();
  showUI();
})();
