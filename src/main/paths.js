'use strict';
// Resolução de caminhos (recursos empacotados, dados do usuário, cache).
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');

const IS_WIN = process.platform === 'win32';

function resourcesDir() {
  // Em produção os recursos ficam em process.resourcesPath (extraResources).
  if (app.isPackaged) return process.resourcesPath;
  return path.join(__dirname, '..', '..', 'resources');
}

function userDir(...p) {
  const dir = path.join(app.getPath('userData'), ...p);
  return dir;
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignora */ }
  return dir;
}

function isAscii(str) {
  return /^[\x20-\x7E]*$/.test(str);
}

// Pasta de trabalho "segura" (somente ASCII) para arquivos que serão lidos por
// componentes nativos antigos (scripts VapourSynth).
function asciiWorkDir() {
  const preferred = userDir('runtime');
  if (isAscii(preferred)) return ensureDir(preferred);
  const candidates = [];
  if (IS_WIN) {
    if (process.env.ProgramData) candidates.push(path.join(process.env.ProgramData, 'ChimpanzePlayer'));
    if (process.env.PUBLIC) candidates.push(path.join(process.env.PUBLIC, 'ChimpanzePlayer'));
    candidates.push('C:\\ChimpanzePlayerTemp');
  } else {
    candidates.push(path.join(os.tmpdir(), 'chimpanze-player'));
  }
  for (const c of candidates) {
    if (!isAscii(c)) continue;
    try {
      fs.mkdirSync(c, { recursive: true });
      fs.accessSync(c, fs.constants.W_OK);
      return c;
    } catch (_) { /* tenta o próximo */ }
  }
  return ensureDir(preferred);
}

function mpvBinary() {
  if (IS_WIN) return path.join(resourcesDir(), 'mpv', 'mpv.exe');
  // Desenvolvimento em Linux/macOS: usa o mpv do sistema.
  const local = path.join(resourcesDir(), 'mpv', 'mpv');
  return fs.existsSync(local) ? local : 'mpv';
}

function shadersDir() { return path.join(resourcesDir(), 'shaders'); }

function vsRuntime() {
  const root = path.join(resourcesDir(), 'vs');
  const python = path.join(root, 'python');
  return {
    root,
    python,
    vsscript: path.join(python, 'Lib', 'site-packages', 'vapoursynth', IS_WIN ? 'vsscript.dll' : 'libvsscript.so'),
    rifeDll: path.join(root, 'rife', IS_WIN ? 'librife.dll' : 'librife.so'),
    rifeModels: path.join(root, 'rife', 'models'),
  };
}

module.exports = { IS_WIN, resourcesDir, userDir, ensureDir, isAscii, asciiWorkDir, mpvBinary, shadersDir, vsRuntime };
