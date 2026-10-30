'use strict';
// Integração com o qBittorrent via Web API (v2).
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const { IS_WIN } = require('./paths');

const VIDEO_RE = /\.(mkv|mp4|avi|m4v|mov|wmv|webm|ts|m2ts|flv|mpg|mpeg)$/i;

const STATE_PT = {
  error: 'Erro', missingFiles: 'Arquivos ausentes', uploading: 'Semeando', pausedUP: 'Concluído', stoppedUP: 'Concluído',
  queuedUP: 'Na fila (semear)', stalledUP: 'Semeando', checkingUP: 'Verificando', forcedUP: 'Semeando (forçado)',
  allocating: 'Alocando', downloading: 'Baixando', metaDL: 'Obtendo metadados', forcedMetaDL: 'Obtendo metadados', pausedDL: 'Pausado', stoppedDL: 'Pausado',
  queuedDL: 'Na fila', stalledDL: 'Aguardando fontes', checkingDL: 'Verificando', forcedDL: 'Baixando (forçado)',
  checkingResumeData: 'Verificando', moving: 'Movendo', unknown: 'Desconhecido',
};

class QbitClient extends EventEmitter {
  constructor(getSettings) {
    super();
    this.getSettings = getSettings;
    this.sid = null;
    this.version = null;
    this.apiVersion = null;
    this.known = new Map(); // hash -> progress (para detectar conclusão)
    this.pollTimer = null;
    this.launching = null;
  }

  cfg() {
    const t = this.getSettings().torrent || {};
    const base = String(t.url || 'http://127.0.0.1:8080').replace(/\/+$/, '');
    return { base, username: t.username || '', password: t.password || '' };
  }

  async _raw(method, endpoint, body, { retry = true } = {}) {
    const { base } = this.cfg();
    const headers = { Referer: base, Origin: base };
    if (this.sid) headers.Cookie = this.sid;
    let res;
    try {
      res = await fetch(base + '/api/v2' + endpoint, { method, headers, body, signal: AbortSignal.timeout(10000) });
    } catch (e) {
      const err = new Error('qBittorrent não está acessível em ' + base);
      err.code = 'OFFLINE';
      throw err;
    }
    if (res.status === 403 && retry) {
      await this.login();
      return this._raw(method, endpoint, body, { retry: false });
    }
    if (res.status === 403) {
      const e = new Error('O qBittorrent pediu login. Use "Configurar automaticamente" ou informe usuário e senha da interface Web.');
      e.code = 'AUTH';
      throw e;
    }
    if (res.status === 404) { const e = new Error('Endpoint não encontrado: ' + endpoint); e.code = 404; throw e; }
    if (!res.ok) throw new Error(`qBittorrent respondeu ${res.status}`);
    return res;
  }

  async login() {
    const { username, password, base } = this.cfg();
    if (!username) { this.sid = null; return true; } // localhost sem autenticação
    const body = new URLSearchParams({ username, password });
    let res;
    try {
      res = await fetch(base + '/api/v2/auth/login', { method: 'POST', headers: { Referer: base, Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10000) });
    } catch (_) {
      const err = new Error('qBittorrent não está acessível em ' + base);
      err.code = 'OFFLINE';
      throw err;
    }
    const txt = await res.text();
    if (!res.ok || txt.trim() !== 'Ok.') {
      const e = new Error(res.status === 403 ? 'IP bloqueado pelo qBittorrent após muitas tentativas.' : 'Usuário ou senha do qBittorrent incorretos.');
      e.code = 'AUTH';
      throw e;
    }
    // qBittorrent 4 usa o cookie "SID"; o 5 usa "QBT_SID_<porta>". Guardamos o par nome=valor recebido.
    const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
    const pair = cookies.map((c) => String(c).split(';')[0].trim()).find((c) => /SID/i.test(c) && c.includes('='));
    this.sid = pair || null;
    return true;
  }

  async get(endpoint) { return (await this._raw('GET', endpoint)).json(); }
  async getText(endpoint) { return (await this._raw('GET', endpoint)).text(); }
  async post(endpoint, params) {
    const body = params instanceof FormData ? params : new URLSearchParams(params || {});
    return (await this._raw('POST', endpoint, body)).text();
  }

  async status() {
    try {
      this.version = await this.getText('/app/version');
      this.apiVersion = await this.getText('/app/webapiVersion');
      let defaultSave = null;
      try { const prefs = await this.get('/app/preferences'); defaultSave = prefs.save_path; } catch (_) { /* ok */ }
      return { ok: true, version: this.version, apiVersion: this.apiVersion, defaultSave };
    } catch (e) {
      const exe = findQbitExe(this.getSettings());
      let error = e.message;
      if (e.code === 'OFFLINE' && IS_WIN) {
        const d = diagnoseIni();
        if (d.found && !d.enabled) error = 'A interface Web do qBittorrent está desligada. Use "Configurar automaticamente".';
        else if (d.found && !d.hasCreds) error = 'O qBittorrent não liga a interface Web sem usuário e senha. Use "Configurar automaticamente".';
        else if (d.found && d.port !== Number(new URL(this.cfg().base).port || 80)) error = `O qBittorrent está configurado na porta ${d.port}, mas o app usa outra. Use "Configurar automaticamente".`;
      }
      return { ok: false, code: e.code || 'ERR', error, exe };
    }
  }

  async ensureRunning() {
    const st = await this.status();
    if (st.ok) return st;
    if (st.code !== 'OFFLINE') return st;
    const exe = findQbitExe(this.getSettings());
    if (!exe) return st;
    if (!this.launching) {
      this.launching = (async () => {
        try {
          const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
          child.unref();
        } catch (_) { /* ok */ }
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const s2 = await this.status();
          if (s2.ok) return s2;
        }
        return await this.status();
      })().finally(() => { this.launching = null; });
    }
    return this.launching;
  }

  async addMagnet(magnetOrUrl, { savePath, sequential = true, category = '', paused = false } = {}) {
    const fd = new FormData();
    fd.append('urls', magnetOrUrl);
    if (savePath) fd.append('savepath', savePath);
    if (category) fd.append('category', category);
    fd.append('tags', 'chimpanze');
    if (sequential) { fd.append('sequentialDownload', 'true'); fd.append('firstLastPiecePrio', 'true'); }
    if (paused) { fd.append('paused', 'true'); fd.append('stopped', 'true'); }
    const txt = await this.post('/torrents/add', fd);
    if (/fail/i.test(txt)) throw new Error('O qBittorrent recusou o torrent (talvez já esteja na lista).');
    return true;
  }

  async addTorrentFile(file, opts = {}) {
    const fd = new FormData();
    const data = fs.readFileSync(file);
    fd.append('torrents', new Blob([data], { type: 'application/x-bittorrent' }), path.basename(file));
    if (opts.savePath) fd.append('savepath', opts.savePath);
    fd.append('tags', 'chimpanze');
    if (opts.sequential !== false) { fd.append('sequentialDownload', 'true'); fd.append('firstLastPiecePrio', 'true'); }
    const txt = await this.post('/torrents/add', fd);
    if (/fail/i.test(txt)) throw new Error('O qBittorrent recusou o arquivo .torrent.');
    return true;
  }

  async list(onlyOurs = false) {
    const q = onlyOurs ? '?tag=chimpanze&sort=added_on&reverse=true' : '?sort=added_on&reverse=true';
    const arr = await this.get('/torrents/info' + q);
    return arr.map((t) => ({
      hash: t.hash, name: t.name, size: t.size || t.total_size, progress: t.progress, state: t.state,
      stateLabel: STATE_PT[t.state] || t.state, dlspeed: t.dlspeed, upspeed: t.upspeed, eta: t.eta,
      seeds: t.num_seeds, peers: t.num_leechs, savePath: t.save_path, contentPath: t.content_path,
      sequential: !!t.seq_dl, addedOn: t.added_on, completionOn: t.completion_on, ratio: t.ratio,
      tags: t.tags, category: t.category,
      paused: /^(paused|stopped)/.test(t.state),
      done: t.progress >= 1,
    }));
  }

  async files(hash) {
    const arr = await this.get('/torrents/files?hash=' + encodeURIComponent(hash));
    return arr.map((f) => ({ index: f.index, name: f.name, size: f.size, progress: f.progress, priority: f.priority, isVideo: VIDEO_RE.test(f.name) }));
  }

  async _either(newEp, oldEp, params) {
    try { return await this.post(newEp, params); } catch (e) {
      if (e.code === 404) return this.post(oldEp, params);
      throw e;
    }
  }

  pause(hashes) { return this._either('/torrents/stop', '/torrents/pause', { hashes: [].concat(hashes).join('|') }); }
  resume(hashes) { return this._either('/torrents/start', '/torrents/resume', { hashes: [].concat(hashes).join('|') }); }
  remove(hashes, deleteFiles) { return this.post('/torrents/delete', { hashes: [].concat(hashes).join('|'), deleteFiles: deleteFiles ? 'true' : 'false' }); }
  toggleSequential(hash) { return this.post('/torrents/toggleSequentialDownload', { hashes: hash }); }
  setFilePriority(hash, ids, priority) { return this.post('/torrents/filePrio', { hash, id: [].concat(ids).join('|'), priority: String(priority) }); }

  // Monitora conclusão para disparar nova varredura da biblioteca.
  startPolling(intervalMs = 8000) {
    clearInterval(this.pollTimer);
    this.pollStartedAt = Date.now() - 5000;
    this.pollTimer = setInterval(async () => {
      try {
        const list = await this.list(false);
        if (!this.pollStartedAt) this.pollStartedAt = Date.now() - 5000;
        if (!this.notified) this.notified = new Set();
        for (const t of list) {
          const prev = this.known.get(t.hash);
          const finishedNow = prev !== undefined && prev < 1 && t.progress >= 1;
          // Também pega torrents que terminaram entre duas verificações (ou que já vieram completos).
          const finishedSinceStart = prev === undefined && t.progress >= 1 && t.completionOn && t.completionOn * 1000 >= this.pollStartedAt;
          if ((finishedNow || finishedSinceStart) && !this.notified.has(t.hash)) {
            this.notified.add(t.hash);
            this.emit('completed', t);
          }
          this.known.set(t.hash, t.progress);
        }
      } catch (_) { /* qBittorrent fechado: ignora */ }
    }, intervalMs);
  }

  stopPolling() { clearInterval(this.pollTimer); }
}

function findQbitExe(settings) {
  const custom = settings && settings.torrent && settings.torrent.exePath;
  const candidates = [];
  if (custom) candidates.push(custom);
  if (IS_WIN) {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
      if (base) candidates.push(path.join(base, 'qBittorrent', 'qbittorrent.exe'));
    }
  } else {
    candidates.push('/usr/bin/qbittorrent', '/usr/local/bin/qbittorrent', '/Applications/qBittorrent.app/Contents/MacOS/qbittorrent');
  }
  return candidates.find((c) => { try { return fs.existsSync(c); } catch (_) { return false; } }) || null;
}

function qbitIniPath() {
  if (IS_WIN) return path.join(process.env.APPDATA || '', 'qBittorrent', 'qBittorrent.ini');
  return path.join(process.env.HOME || '', '.config', 'qBittorrent', 'qBittorrent.conf');
}

function isQbitRunning() {
  return new Promise((resolve) => {
    if (IS_WIN) {
      execFile('tasklist', ['/FI', 'IMAGENAME eq qbittorrent.exe', '/NH'], { windowsHide: true }, (err, out) => {
        resolve(!err && /qbittorrent\.exe/i.test(out || ''));
      });
    } else {
      execFile('pgrep', ['-x', 'qbittorrent'], (err) => resolve(!err));
    }
  });
}

function closeQbit(force = false) {
  return new Promise((resolve) => {
    if (IS_WIN) execFile('taskkill', force ? ['/F', '/IM', 'qbittorrent.exe'] : ['/IM', 'qbittorrent.exe'], { windowsHide: true }, () => resolve());
    else execFile('pkill', force ? ['-9', '-x', 'qbittorrent'] : ['-x', 'qbittorrent'], () => resolve());
  });
}

// Edita o .ini preservando o restante do arquivo.
function setIniValues(text, section, values) {
  const lines = text.split(/\r?\n/);
  let start = lines.findIndex((l) => l.trim() === `[${section}]`);
  if (start < 0) {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(`[${section}]`);
    start = lines.length - 1;
  }
  let end = lines.findIndex((l, i) => i > start && /^\[.*\]\s*$/.test(l.trim()));
  if (end < 0) end = lines.length;
  while (end - 1 > start && lines[end - 1].trim() === '') end--;
  for (const [k, v] of Object.entries(values)) {
    let found = false;
    for (let i = start + 1; i < end; i++) {
      const eq = lines[i].indexOf('=');
      if (eq > 0 && lines[i].slice(0, eq).trim() === k) { lines[i] = `${k}=${v}`; found = true; break; }
    }
    if (!found) { lines.splice(end, 0, `${k}=${v}`); end++; }
  }
  return lines.join('\r\n');
}

function getIniValue(text, section, key) {
  const lines = text.split(/\r?\n/);
  let inSec = false;
  for (const l of lines) {
    const t = l.trim();
    if (/^\[.*\]$/.test(t)) { inSec = t === `[${section}]`; continue; }
    if (!inSec) continue;
    const eq = l.indexOf('=');
    if (eq > 0 && l.slice(0, eq).trim() === key) return l.slice(eq + 1).trim();
  }
  return null;
}

// Formato usado pelo qBittorrent: PBKDF2-HMAC-SHA512, 100000 iterações, sal de 16 bytes, chave de 64 bytes.
function qbitPasswordHash(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, 100000, 64, 'sha512');
  return `"@ByteArray(${salt.toString('base64')}:${key.toString('base64')})"`;
}

function randomPassword() {
  return crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 20) + 'Aa1';
}

// Diagnóstico a partir do arquivo de configuração (quando a interface Web não responde).
function diagnoseIni() {
  let text = '';
  try { text = fs.readFileSync(qbitIniPath(), 'utf8'); } catch (_) { return { found: false }; }
  const enabled = String(getIniValue(text, 'Preferences', 'WebUI\\Enabled') || '').toLowerCase() === 'true';
  const hasCreds = !!getIniValue(text, 'Preferences', 'WebUI\\Password_PBKDF2') && !!getIniValue(text, 'Preferences', 'WebUI\\Username');
  const port = Number(getIniValue(text, 'Preferences', 'WebUI\\Port')) || 8080;
  return { found: true, enabled, hasCreds, port };
}

async function autoConfigure({ port = 8080, force = false } = {}) {
  const ini = qbitIniPath();
  if (await isQbitRunning()) {
    if (!force) return { ok: false, needsClose: true };
    await closeQbit();
    for (let i = 0; i < 16 && (await isQbitRunning()); i++) await new Promise((r) => setTimeout(r, 500));
    // Com "fechar para a bandeja" ativo, o pedido normal só esconde a janela: encerra à força.
    if (await isQbitRunning()) {
      await closeQbit(true);
      for (let i = 0; i < 20 && (await isQbitRunning()); i++) await new Promise((r) => setTimeout(r, 500));
    }
    if (await isQbitRunning()) {
      return { ok: false, error: 'O qBittorrent não fechou (talvez esteja pedindo confirmação). Feche-o manualmente e tente de novo.' };
    }
  }
  let text = '';
  try { text = fs.readFileSync(ini, 'utf8'); } catch (_) { /* novo */ }
  if (text) {
    try { fs.copyFileSync(ini, ini + '.bak-chimpanze'); } catch (_) { /* ok */ }
  }
  const existingPort = Number(getIniValue(text, 'Preferences', 'WebUI\\Port')) || port;
  // O qBittorrent 5 não liga a interface Web sem usuário e senha definidos.
  const username = 'chimpanze';
  const password = randomPassword();
  const values = {
    'WebUI\\Enabled': 'true',
    'WebUI\\Port': String(existingPort),
    'WebUI\\LocalHostAuth': 'false',
    'WebUI\\Username': username,
    'WebUI\\Password_PBKDF2': qbitPasswordHash(password),
    'WebUI\\HostHeaderValidation': 'false',
    'WebUI\\CSRFProtection': 'false',
  };
  if (getIniValue(text, 'Preferences', 'WebUI\\Address') == null) values['WebUI\\Address'] = '*';
  const out = setIniValues(text, 'Preferences', values);
  fs.mkdirSync(path.dirname(ini), { recursive: true });
  fs.writeFileSync(ini, out, 'utf8');
  return { ok: true, port: existingPort, ini, username, password };
}

module.exports = { QbitClient, findQbitExe, autoConfigure, qbitPasswordHash, diagnoseIni, isQbitRunning, setIniValues, getIniValue, STATE_PT, VIDEO_RE };
