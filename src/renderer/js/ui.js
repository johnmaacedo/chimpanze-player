'use strict';
/* Componentes: avisos, modais, menus, cartões e fileiras */
(function (App) {
  const { h, icon } = App;

  // ---------- avisos ----------
  function toast(text, level = 'info', opts = {}) {
    const box = document.getElementById('toasts');
    const actions = (opts.actions || []).map((a) => h('button', {
      class: 'btn btn-xs btn-ghost',
      onclick: () => { try { a.run(); } finally { close(); } },
    }, a.label));
    const el = h('div', { class: `toast ${level}` }, h('div', { class: 'tx' }, text, actions.length ? h('div', { class: 'ta' }, actions) : null));
    let timer;
    function close() {
      clearTimeout(timer);
      el.classList.add('out');
      setTimeout(() => el.remove(), 260);
    }
    el.addEventListener('click', (e) => { if (e.target === el || e.target.classList.contains('tx')) close(); });
    box.appendChild(el);
    while (box.children.length > 5) box.firstChild.remove();
    timer = setTimeout(close, opts.duration || (level === 'error' ? 9000 : actions.length ? 9000 : 4500));
    return close;
  }

  // ---------- modais ----------
  const modalStack = [];
  function modal({ title, body, actions = [], wide = false, onClose }) {
    const layer = document.getElementById('modal-layer');
    const box = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog' });
    const close = (result) => {
      const idx = modalStack.indexOf(entry);
      if (idx >= 0) modalStack.splice(idx, 1);
      box.remove();
      if (!modalStack.length) { layer.hidden = true; App.emit('modal-closed'); }
      if (onClose) onClose(result);
    };
    const entry = { box, close };
    const head = h('div', { class: 'modal-head' }, h('h3', null, title), h('button', { class: 'icon-btn', title: 'Fechar', onclick: () => close() }, icon('close')));
    const bodyEl = h('div', { class: 'modal-body' });
    if (typeof body === 'function') body(bodyEl, close); else if (body) bodyEl.append(body);
    box.append(head, bodyEl);
    if (actions.length) {
      box.append(h('div', { class: 'modal-foot' }, actions.map((a) => h('button', {
        class: `btn btn-sm ${a.kind || 'btn-outline'}`,
        onclick: async (ev) => {
          if (!a.run) return close();
          const btn = ev.currentTarget;
          btn.disabled = true;
          try { const r = await a.run(close); if (r !== false) close(r); } catch (err) { toast(err.message, 'error'); } finally { btn.disabled = false; }
        },
      }, a.label))));
    }
    if (!modalStack.length) App.emit('modal-opened');
    modalStack.push(entry);
    layer.hidden = false;
    layer.appendChild(box);
    layer.onclick = (e) => { if (e.target === layer && modalStack.length) modalStack[modalStack.length - 1].close(); };
    setTimeout(() => { const f = box.querySelector('input:not([type=checkbox]), textarea'); if (f) f.focus(); }, 30);
    return { close, body: bodyEl, box };
  }
  function topModal() { return modalStack[modalStack.length - 1]; }

  function confirm(title, text, { okLabel = 'Confirmar', danger = false } = {}) {
    return new Promise((resolve) => {
      modal({
        title, body: h('p', null, text),
        actions: [
          { label: 'Cancelar', run: () => { resolve(false); } },
          { label: okLabel, kind: danger ? 'btn-danger' : 'btn-accent', run: () => { resolve(true); } },
        ],
        onClose: () => resolve(false),
      });
    });
  }

  function prompt(title, { label, value = '', placeholder = '', okLabel = 'Salvar', hint } = {}) {
    return new Promise((resolve) => {
      let input;
      modal({
        title,
        body: (b) => {
          input = h('input', { class: 'input', value, placeholder, onkeydown: (e) => { if (e.key === 'Enter') { resolve(input.value); m.close(); } } });
          b.append(h('div', { class: 'field' }, label ? h('label', null, label) : null, input, hint ? h('div', { class: 'hint' }, hint) : null));
        },
        actions: [{ label: 'Cancelar', run: () => resolve(null) }, { label: okLabel, kind: 'btn-accent', run: () => resolve(input.value) }],
        onClose: () => resolve(null),
      });
      const m = topModal();
    });
  }

  // ---------- menu suspenso ----------
  let openMenu = null;
  function menu(anchor, items) {
    closeMenu();
    const el = h('div', { class: 'menu' }, items.map((it) => {
      if (it === '-') return h('hr');
      return h('button', { class: it.danger ? 'danger' : '', onclick: () => { closeMenu(); it.run(); } }, it.icon ? icon(it.icon) : null, it.label);
    }));
    document.body.appendChild(el);
    const r = anchor.getBoundingClientRect();
    const mw = el.offsetWidth, mh = el.offsetHeight;
    let x = r.left, y = r.bottom + 6;
    if (x + mw > innerWidth - 10) x = innerWidth - mw - 10;
    if (y + mh > innerHeight - 10) y = r.top - mh - 6;
    el.style.left = `${Math.max(10, x)}px`;
    el.style.top = `${Math.max(10, y)}px`;
    openMenu = el;
    setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
    App.emit('modal-opened');
  }
  function outside(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
  function closeMenu() {
    if (!openMenu) return;
    openMenu.remove();
    openMenu = null;
    document.removeEventListener('mousedown', outside, true);
    if (!modalStack.length) App.emit('modal-closed');
  }

  // ---------- cartões ----------
  function posterCard(item, opts = {}) {
    const { art, titleOf, yearOf, KIND_LABEL } = App;
    const a = art(item);
    const title = titleOf(item);
    const card = h('div', { class: 'card card-poster', tabindex: '0' });
    const fallback = () => card.prepend(h('div', { class: 'card-fallback' }, h('span', null, title)));
    card.append(App.lazyImg(a.poster, 'card-img', fallback));
    card.append(h('div', { class: 'card-shade' }));
    const sub = [yearOf(item), KIND_LABEL[item.kind]].filter(Boolean).join(' · ');
    card.append(h('div', { class: 'card-info' }, h('div', { class: 't' }, title), h('div', { class: 's' }, sub)));
    if (opts.badge) card.append(h('div', { class: 'card-badge' }, opts.badge));
    if (opts.progress) card.append(h('div', { class: 'card-progress' }, h('i', { style: { width: `${Math.round(opts.progress * 100)}%` } })));
    if (opts.watched) card.append(h('div', { class: 'check-badge', title: 'Assistido' }, icon('check')));
    card.addEventListener('click', () => App.openDetail(item.id));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') App.openDetail(item.id); });
    return card;
  }

  // Cartão largo para "Continuar assistindo".
  function wideCard(entry) {
    const { art, titleOf } = App;
    const item = entry.item;
    const a = art(item);
    const title = titleOf(item);
    const card = h('div', { class: 'card card-wide', tabindex: '0' });
    const em = entry.episode ? (item.episodeMeta || {})[`${entry.episode.season}x${entry.episode.episode}`] : null;
    const still = em && em.still ? App.remoteImg(em.still) : null;
    const thumb = entry.path ? App.thumbImg(entry.path, 30) : null;
    const src = still || a.backdrop || thumb || a.poster;
    const fallback = () => {
      const alt = thumb && src !== thumb ? thumb : null;
      if (alt) card.prepend(App.lazyImg(alt, 'card-img', () => card.prepend(h('div', { class: 'card-fallback' }, h('span', null, title)))));
      else card.prepend(h('div', { class: 'card-fallback' }, h('span', null, title)));
    };
    card.append(App.lazyImg(src, 'card-img', fallback));
    card.append(h('div', { class: 'card-shade' }));
    card.append(h('div', { class: 'card-play' }, icon('play')));
    let sub = entry.label || '';
    card.append(h('div', { class: 'card-info' }, h('div', { class: 't' }, title), h('div', { class: 's' }, sub)));
    if (entry.badge) card.append(h('div', { class: 'card-badge' }, entry.badge));
    if (entry.progress > 0) card.append(h('div', { class: 'card-progress' }, h('i', { style: { width: `${Math.max(3, Math.round(entry.progress * 100))}%` } })));
    const play = () => App.play({ itemId: item.id, episodeId: entry.episode ? entry.episode.id : undefined, file: entry.path });
    card.addEventListener('click', play);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') play(); });
    card.addEventListener('contextmenu', (e) => { e.preventDefault(); App.openDetail(item.id); });
    return card;
  }

  // Fileira horizontal com setas.
  function row(title, cards, opts = {}) {
    if (!cards.length) return null;
    const track = h('div', { class: 'row-track' }, cards);
    const left = h('button', { class: 'row-arrow left', disabled: true, onclick: () => track.scrollBy({ left: -track.clientWidth * 0.85 }) }, icon('left'));
    const right = h('button', { class: 'row-arrow right', onclick: () => track.scrollBy({ left: track.clientWidth * 0.85 }) }, icon('right'));
    const upd = () => {
      left.disabled = track.scrollLeft < 10;
      right.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 10;
    };
    track.addEventListener('scroll', App.debounce(upd, 50));
    setTimeout(upd, 60);
    return h('section', { class: 'row' },
      h('div', { class: 'row-head' }, h('h2', { class: 'row-title' }, title), opts.more ? h('button', { class: 'row-more', onclick: opts.more }, 'Ver tudo ›') : null),
      h('div', { class: 'row-wrap' }, left, track, right));
  }

  function switchEl(checked, onchange) {
    const input = h('input', { type: 'checkbox' });
    input.checked = !!checked;
    input.addEventListener('change', () => onchange(input.checked));
    return h('label', { class: 'switch' }, input, h('i'));
  }

  function toggleRow(label, desc, checked, onchange) {
    const sw = switchEl(checked, onchange);
    const el = h('div', { class: 'toggle' }, h('div', null, h('div', { class: 'tl' }, label), desc ? h('div', { class: 'td' }, desc) : null), sw);
    el.addEventListener('click', (e) => { if (!sw.contains(e.target)) { const i = sw.querySelector('input'); i.checked = !i.checked; i.dispatchEvent(new Event('change')); } });
    return el;
  }

  function seg(options, value, onchange) {
    const el = h('div', { class: 'seg' });
    for (const [v, label] of options) {
      el.append(h('button', { class: v === value ? 'on' : '', onclick: () => { el.querySelectorAll('button').forEach((b) => b.classList.remove('on')); el.querySelector(`[data-v="${CSS.escape(String(v))}"]`).classList.add('on'); onchange(v); }, 'data-v': String(v) }, label));
    }
    return el;
  }

  Object.assign(App, { toast, modal, confirm, prompt, menu, closeMenu, posterCard, wideCard, row, switchEl, toggleRow, seg, topModal });
})(window.App);
