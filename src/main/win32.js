'use strict';
// Chamadas diretas à API do Windows (via koffi) para unir a janela do vídeo (mpv) e a dos controles
// numa janela só: os controles passam a ser "possuídos" pela janela do vídeo, então o Windows mantém
// as duas juntas na ordem das janelas, na barra de tarefas e no Alt+Tab.
const GWL_EXSTYLE = -20;
const GWLP_HWNDPARENT = -8;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOOWNERZORDER = 0x0200;
const SWP_ASYNCWINDOWPOS = 0x4000;
const SW_HIDE = 0;
const SW_SHOWNOACTIVATE = 4;

let api = null;

function load() {
  if (api !== null) return api;
  api = false;
  if (process.platform !== 'win32') return api;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const POINT = koffi.struct('CHIMP_POINT', { x: 'int', y: 'int' });
    const RECT = koffi.struct('CHIMP_RECT', { left: 'int', top: 'int', right: 'int', bottom: 'int' });
    const WINDOWPLACEMENT = koffi.struct('CHIMP_WINDOWPLACEMENT', {
      length: 'uint32_t', flags: 'uint32_t', showCmd: 'uint32_t', ptMinPosition: POINT, ptMaxPosition: POINT, rcNormalPosition: RECT,
    });
    api = {
      WINDOWPLACEMENT_SIZE: koffi.sizeof(WINDOWPLACEMENT),
      SetWindowPlacement: user32.func('bool __stdcall SetWindowPlacement(intptr_t hWnd, const CHIMP_WINDOWPLACEMENT *lpwndpl)'),
      IsIconic: user32.func('bool __stdcall IsIconic(intptr_t hWnd)'),
      GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hWnd, int nIndex)'),
      SetWindowLongPtrW: user32.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t hWnd, int nIndex, intptr_t dwNewLong)'),
      SetWindowPos: user32.func('bool __stdcall SetWindowPos(intptr_t hWnd, intptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)'),
      ShowWindowAsync: user32.func('bool __stdcall ShowWindowAsync(intptr_t hWnd, int nCmdShow)'),
      IsWindow: user32.func('bool __stdcall IsWindow(intptr_t hWnd)'),
    };
  } catch (e) {
    console.error('[win32] koffi indisponível:', e.message);
    api = false;
  }
  return api;
}

const available = () => !!load();

// HWND de uma BrowserWindow (o Electron entrega um Buffer com o ponteiro).
function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
}

function isWindow(hwnd) {
  const a = load();
  return !!(a && hwnd && a.IsWindow(hwnd));
}

function setExStyle(hwnd, add, remove) {
  const a = load();
  const cur = Number(a.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  const next = (cur | add) & ~remove;
  if (next !== cur) a.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
}

// Torna a janela do vídeo "dona" da janela dos controles. Resultado: os controles ficam sempre
// logo acima do vídeo, os dois sobem/descem juntos e só os controles aparecem na barra de tarefas.
function link(controlsHwnd, videoHwnd) {
  const a = load();
  if (!a || !isWindow(controlsHwnd) || !isWindow(videoHwnd)) return false;
  setExStyle(videoHwnd, WS_EX_TOOLWINDOW, WS_EX_APPWINDOW);
  // Janela possuída só ganha botão na barra de tarefas com WS_EX_APPWINDOW.
  setExStyle(controlsHwnd, WS_EX_APPWINDOW, 0);
  a.SetWindowLongPtrW(controlsHwnd, GWLP_HWNDPARENT, videoHwnd);
  return true;
}

// Desfaz a ligação (obrigatório antes de o mpv fechar, senão o Windows destrói os controles junto).
function unlink(controlsHwnd) {
  const a = load();
  if (!a || !isWindow(controlsHwnd)) return;
  a.SetWindowLongPtrW(controlsHwnd, GWLP_HWNDPARENT, 0);
}

// Move/redimensiona sem esperar o mpv responder (assíncrono: nunca trava a interface).
function moveWindow(hwnd, r) {
  const a = load();
  if (!a || !hwnd) return false;
  return !!a.SetWindowPos(hwnd, 0, Math.round(r.x), Math.round(r.y), Math.max(1, Math.round(r.width)), Math.max(1, Math.round(r.height)),
    SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_ASYNCWINDOWPOS);
}

function setVisible(hwnd, visible) {
  const a = load();
  if (a && hwnd) a.ShowWindowAsync(hwnd, visible ? SW_SHOWNOACTIVATE : SW_HIDE);
}

// Mostra a janela de novo exatamente no retângulo dado, mesmo que ela tenha sido minimizada
// (o mpv sozinho voltaria ao tamanho antigo). Não rouba o foco dos controles.
function restoreTo(hwnd, r) {
  const a = load();
  if (!a || !hwnd) return false;
  const x = Math.round(r.x), y = Math.round(r.y);
  // Janela "toolwindow" (a do mpv): coordenadas de tela.
  const ok = a.SetWindowPlacement(hwnd, {
    length: a.WINDOWPLACEMENT_SIZE, flags: 0, showCmd: SW_SHOWNOACTIVATE,
    ptMinPosition: { x: -1, y: -1 }, ptMaxPosition: { x: -1, y: -1 },
    rcNormalPosition: { left: x, top: y, right: x + Math.max(1, Math.round(r.width)), bottom: y + Math.max(1, Math.round(r.height)) },
  });
  if (!ok) setVisible(hwnd, true);
  return moveWindow(hwnd, r);
}

module.exports = { available, hwndOf, isWindow, link, unlink, moveWindow, setVisible, restoreTo };
