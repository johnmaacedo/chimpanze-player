'use strict';
/* Utilitários compartilhados da interface */
window.App = window.App || {};

(function (App) {
  // Ignora null/undefined/false ao inserir filhos (evita aparecer o texto "null").
  for (const proto of [Element.prototype, DocumentFragment.prototype]) {
    for (const m of ['append', 'prepend', 'replaceChildren']) {
      const orig = proto[m];
      proto[m] = function (...nodes) { return orig.apply(this, nodes.filter((n) => n != null && n !== false)); };
    }
  }

  // Construtor de elementos: h('div', {class:'x', onclick}, filhos...)
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    append(el, children);
    return el;
  }
  function append(el, children) {
    for (const c of children) {
      if (c == null || c === false) continue;
      if (Array.isArray(c)) append(el, c);
      else if (c instanceof Node) el.appendChild(c);
      else el.appendChild(document.createTextNode(String(c)));
    }
  }

  // Ícones (SVG inline)
  const ICONS = {
    play: '<path d="M7 4.5v15a1 1 0 0 0 1.52.85l12.2-7.5a1 1 0 0 0 0-1.7L8.52 3.65A1 1 0 0 0 7 4.5Z"/>',
    pause: '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>',
    info: '<path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm1 7v6h-2v-6h2Zm-1-4a1.25 1.25 0 1 1 0 2.5A1.25 1.25 0 0 1 12 7Z"/>',
    back: '<path d="M15.4 4.6 8 12l7.4 7.4-1.4 1.4L5.2 12 14 3.2l1.4 1.4Z"/>',
    forward: '<path d="m8.6 19.4 7.4-7.4-7.4-7.4L10 3.2 18.8 12 10 20.8l-1.4-1.4Z"/>',
    left: '<path d="M15.4 4.6 8 12l7.4 7.4-1.4 1.4L5.2 12 14 3.2l1.4 1.4Z"/>',
    right: '<path d="m8.6 19.4 7.4-7.4-7.4-7.4L10 3.2 18.8 12 10 20.8l-1.4-1.4Z"/>',
    close: '<path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5Z"/>',
    check: '<path d="m9.5 16.2-4.2-4.2-1.4 1.4 5.6 5.6 11-11-1.4-1.4-9.6 9.6Z"/>',
    more: '<path d="M5 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z"/>',
    plus: '<path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z"/>',
    folder: '<path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h5l2 2h8A1.5 1.5 0 0 1 21 7.5v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-13Z"/>',
    refresh: '<path d="M12 4a8 8 0 0 1 7.75 6h-2.1A6 6 0 1 0 18 13h2a8 8 0 1 1-8-9Zm5-1h3v6h-6V7h2.2A6 6 0 0 0 12 6V4c1.9 0 3.65.66 5 1.76V3Z"/>',
    search: '<path d="M10.5 3a7.5 7.5 0 0 1 5.96 12.05l4.25 4.24-1.42 1.42-4.24-4.25A7.5 7.5 0 1 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z"/>',
    download: '<path d="M11 3h2v9.6l3.3-3.3 1.4 1.4L12 16.4l-5.7-5.7 1.4-1.4 3.3 3.3V3ZM4 18h16v2H4v-2Z"/>',
    magnet: '<path d="M4 3h5v8a3 3 0 0 0 6 0V3h5v8a8 8 0 0 1-16 0V3Z"/><path d="M4 3h5v3H4zM15 3h5v3h-5z" fill="#fff" opacity=".35"/>',
    trash: '<path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Z"/>',
    shield: '<path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Zm-1.2 14.2-3.5-3.5 1.4-1.4 2.1 2.1 4.6-4.6 1.4 1.4-6 6Z"/>',
    edit: '<path d="m14.06 6.19 3.75 3.75L8.75 19H5v-3.75l9.06-9.06Zm1.41-1.41 1.84-1.84a1 1 0 0 1 1.41 0l2.34 2.34a1 1 0 0 1 0 1.41l-1.84 1.84-3.75-3.75Z"/>',
    tag: '<path d="M3 3h8.6l9.4 9.4-8.6 8.6L3 11.6V3Zm4.5 3a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/>',
    eye: '<path d="M12 5c5 0 8.5 4.2 9.8 7-1.3 2.8-4.8 7-9.8 7s-8.5-4.2-9.8-7C3.5 9.2 7 5 12 5Zm0 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z"/>',
    restart: '<path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z"/>',
    link: '<path d="M10.6 13.4a1 1 0 0 1 0-1.4l3.5-3.5a3 3 0 1 1 4.2 4.2l-2.1 2.1-1.4-1.4 2.1-2.1a1 1 0 1 0-1.4-1.4L12 13.4a1 1 0 0 1-1.4 0Zm2.8-2.8a1 1 0 0 1 0 1.4L9.9 15.5a3 3 0 1 1-4.2-4.2l2.1-2.1 1.4 1.4-2.1 2.1a1 1 0 1 0 1.4 1.4L12 10.6a1 1 0 0 1 1.4 0Z"/>',
    sparkle: '<path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2Zm7 12 .9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9L19 14Z"/>',
    film: '<path d="M4 4h16v16H4V4Zm2 2v2h2V6H6Zm10 0v2h2V6h-2ZM6 10v4h2v-4H6Zm10 0v4h2v-4h-2ZM6 16v2h2v-2H6Zm10 0v2h2v-2h-2Zm-6-10v12h4V6h-4Z"/>',
    tv: '<path d="M3 6h18v12H3V6Zm2 2v8h14V8H5Zm3-6 4 3 4-3 1 1-3.5 2.5h-3L7 3l1-1ZM8 20h8v1H8v-1Z"/>',
  };
  function icon(name, cls) {
    const span = document.createElement('span');
    span.innerHTML = `<svg viewBox="0 0 24 24" class="ico ${cls || ''}">${ICONS[name] || ''}</svg>`;
    return span.firstChild;
  }

  // Codificação base64url compatível com o protocolo chimp-img://
  function b64url(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function remoteImg(url) { return url ? `chimp-img://r/${b64url(url)}` : null; }
  function localImg(p) { return p ? `chimp-img://l/${b64url(p)}` : null; }
  function thumbImg(p, pct) { return p ? `chimp-img://t/${b64url(p)}?p=${pct || 25}` : null; }

  function art(item) {
    const m = item.meta || {};
    const la = item.localArt || {};
    return {
      poster: la.poster ? localImg(la.poster) : remoteImg(m.poster),
      backdrop: la.backdrop ? localImg(la.backdrop) : remoteImg(m.backdrop),
      logo: la.logo ? localImg(la.logo) : remoteImg(m.logo),
    };
  }

  function titleOf(item) { return item.customTitle || (item.meta && item.meta.title) || item.title; }
  function yearOf(item) { return item.customYear || (item.meta && item.meta.year) || item.year || null; }

  const KIND_LABEL = { movie: 'Filme', series: 'Série', anime: 'Anime' };

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  function fmtDuration(min) {
    if (!min) return '';
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return h ? `${h}h ${m ? m + 'min' : ''}`.trim() : `${m} min`;
  }
  function fmtBytes(b) {
    if (!b && b !== 0) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let n = b;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1).replace('.', ',')} ${u[i]}`;
  }
  function fmtSpeed(b) { return b ? fmtBytes(b) + '/s' : '0 B/s'; }
  function fmtEta(s) {
    if (!s || s >= 8640000) return '∞';
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}min`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}min`;
    return `${Math.floor(s / 86400)}d`;
  }
  function epLabel(ep) {
    if (!ep) return '';
    if (ep.season === 0) return `Especial ${ep.episode}`;
    return `T${ep.season}:E${ep.episode}${ep.episodeEnd ? '-' + ep.episodeEnd : ''}`;
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  function norm(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  // Carrega imagem com efeito de fade e fallback.
  function lazyImg(src, cls, onFail) {
    const img = h('img', { class: cls || 'card-img', alt: '', loading: 'lazy', decoding: 'async' });
    if (!src) { if (onFail) setTimeout(onFail, 0); return img; }
    img.addEventListener('load', () => img.classList.add('loaded'));
    img.addEventListener('error', () => { img.remove(); if (onFail) onFail(); });
    img.src = src;
    return img;
  }

  Object.assign(App, { h, icon, b64url, remoteImg, localImg, thumbImg, art, titleOf, yearOf, KIND_LABEL, fmtTime, fmtDuration, fmtBytes, fmtSpeed, fmtEta, epLabel, debounce, norm, lazyImg });
})(window.App);
