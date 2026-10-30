'use strict';
// Injetado nas páginas das "Fontes": encontra links magnet e intercepta cliques neles.
const { ipcRenderer, contextBridge } = require('electron');

// O Electron não tem o objeto window.chrome que o Chrome expõe. Serviços anti-robô (Cloudflare
// Turnstile, hCaptcha) estranham a ausência e prendem a verificação em loop. Recria o essencial
// no contexto da página, antes de qualquer script do site.
try {
  contextBridge.executeInMainWorld({
    func: () => {
      try {
        const now = Date.now() / 1000;
        const shim = {
          app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }, getDetails() { return null; }, getIsInstalled() { return false; } },
          runtime: { OnInstalledReason: {}, OnRestartRequiredReason: {}, PlatformArch: {}, PlatformOs: {}, RequestUpdateCheckStatus: {} },
          loadTimes() { return { requestTime: now, startLoadTime: now, commitLoadTime: now, finishDocumentLoadTime: now, finishLoadTime: now, firstPaintTime: now, firstPaintAfterLoadTime: 0, navigationType: 'Other', wasFetchedViaSpdy: true, wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, connectionInfo: 'h2' }; },
          csi() { return { startE: Date.now(), onloadT: Date.now(), pageT: 1000, tran: 15 }; },
        };
        if (!window.chrome) {
          Object.defineProperty(window, 'chrome', { value: shim, writable: true, configurable: true, enumerable: true });
        } else {
          // O Electron cria um window.chrome incompleto: completa só o que falta.
          for (const k of Object.keys(shim)) { if (!(k in window.chrome)) { try { window.chrome[k] = shim[k]; } catch (_) { /* ok */ } } }
        }
      } catch (_) { /* ok */ }
    },
  });
} catch (_) { /* versões antigas do Electron */ }

const seen = new Set();

function describe(a) {
  const label = (a.getAttribute('title') || a.textContent || '').replace(/\s+/g, ' ').trim();
  let context = '';
  const row = a.closest('tr, li, article, .torrent, .card, div');
  if (row) context = (row.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return { label, context };
}

function scan() {
  try {
    const found = [];
    document.querySelectorAll('a[href^="magnet:"], a[href^="MAGNET:"]').forEach((a) => {
      const uri = a.getAttribute('href');
      if (!uri || seen.has(uri)) return;
      seen.add(uri);
      found.push({ uri, ...describe(a) });
    });
    // Alguns sites guardam o magnet em atributos data-*.
    document.querySelectorAll('[data-magnet], [data-href^="magnet:"], [data-url^="magnet:"]').forEach((el) => {
      const uri = el.getAttribute('data-magnet') || el.getAttribute('data-href') || el.getAttribute('data-url');
      if (!uri || !/^magnet:/i.test(uri) || seen.has(uri)) return;
      seen.add(uri);
      found.push({ uri, ...describe(el) });
    });
    if (found.length) ipcRenderer.send('fontes:magnets', found);
  } catch (_) { /* página sem DOM ainda */ }
}

let timer = null;
function schedule() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; scan(); }, 400);
}

window.addEventListener('DOMContentLoaded', () => {
  scan();
  try {
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  } catch (_) { /* ok */ }
});
window.addEventListener('load', scan);

// Clique em magnet: envia direto ao Chimpanzé Player (sem abrir programas externos).
document.addEventListener('click', (ev) => {
  const a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (/^magnet:/i.test(href)) {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    ipcRenderer.send('fontes:magnet-click', { uri: href, label: describe(a).label });
  }
}, true);
