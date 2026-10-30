'use strict';
// Protocolo chimp-img:// — cache local de imagens remotas, arte local e miniaturas de vídeo.
//   chimp-img://r/<base64url(url)>      imagem remota (baixa uma vez e guarda em cache)
//   chimp-img://l/<base64url(path)>     imagem local (poster.jpg da pasta)
//   chimp-img://t/<base64url(path)>?p=0.25  miniatura gerada a partir do vídeo
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { protocol, net } = require('electron');
const { pathToFileURL } = require('url');
const { userDir, ensureDir, mpvBinary } = require('./paths');

const SCHEME = 'chimp-img';

function registerSchemePrivileges() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  ]);
}

const b64d = (s) => Buffer.from(s, 'base64url').toString('utf8');
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

const inflight = new Map();
let thumbRunning = 0;
const thumbQueue = [];

function mimeOf(file) {
  const e = path.extname(file).toLowerCase();
  return e === '.png' ? 'image/png' : e === '.webp' ? 'image/webp' : e === '.gif' ? 'image/gif' : 'image/jpeg';
}

function fileResponse(file) {
  const data = fs.readFileSync(file);
  return new Response(data, { headers: { 'Content-Type': mimeOf(file), 'Cache-Control': 'max-age=31536000' } });
}

async function fetchRemote(url) {
  const dir = ensureDir(userDir('cache', 'img'));
  const base = path.join(dir, sha(url));
  for (const ext of ['.jpg', '.png', '.webp']) {
    if (fs.existsSync(base + ext)) return base + ext;
  }
  if (inflight.has(url)) return inflight.get(url);
  const p = (async () => {
    const res = await net.fetch(url, { headers: { 'User-Agent': 'ChimpanzePlayer/1.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const ct = res.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) throw new Error('não é imagem');
    const ext = ct.includes('png') ? '.png' : ct.includes('webp') ? '.webp' : '.jpg';
    const buf = Buffer.from(await res.arrayBuffer());
    const file = base + ext;
    fs.writeFileSync(file + '.tmp', buf);
    fs.renameSync(file + '.tmp', file);
    return file;
  })().finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

function runThumb(job) {
  return new Promise((resolve, reject) => {
    const exec = () => {
      thumbRunning++;
      const outDir = fs.mkdtempSync(path.join(ensureDir(userDir('cache', 'tmp')), 't-'));
      const args = [
        '--no-config', '--msg-level=all=no', '--ao=null', '--no-audio', '--no-sub', '--hwdec=no',
        `--start=${job.percent}%`, '--frames=1', '--vo=image', '--vo-image-format=jpg', '--vo-image-jpeg-quality=85',
        `--vo-image-outdir=${outDir}`, '--vf=scale=w=480:h=-2', '--', job.file,
      ];
      let done = false;
      const child = spawn(mpvBinary(), args, { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* ok */ } }, 20000);
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        thumbRunning--;
        try {
          const produced = fs.readdirSync(outDir).find((n) => n.endsWith('.jpg'));
          if (!err && produced) {
            fs.renameSync(path.join(outDir, produced), job.target);
            resolve(job.target);
          } else reject(err || new Error('sem imagem'));
        } catch (e) { reject(e); }
        try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) { /* ok */ }
        const next = thumbQueue.shift();
        if (next) next();
      };
      child.on('error', finish);
      child.on('exit', () => finish(null));
    };
    if (thumbRunning < 2) exec(); else thumbQueue.push(exec);
  });
}

async function makeThumb(file, percent) {
  const dir = ensureDir(userDir('cache', 'thumbs'));
  let st;
  try { st = fs.statSync(file); } catch (_) { throw new Error('arquivo ausente'); }
  const target = path.join(dir, sha(`${file}|${st.size}|${percent}`) + '.jpg');
  if (fs.existsSync(target)) return target;
  const key = 'thumb:' + target;
  if (inflight.has(key)) return inflight.get(key);
  const p = runThumb({ file, percent, target }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function registerProtocol() {
  protocol.handle(SCHEME, async (request) => {
    try {
      const u = new URL(request.url);
      const kind = u.hostname;
      const payload = b64d(u.pathname.replace(/^\//, ''));
      if (kind === 'r') {
        if (!/^https?:\/\//i.test(payload)) return new Response('bad', { status: 400 });
        const file = await fetchRemote(payload);
        return fileResponse(file);
      }
      if (kind === 'l') {
        if (!/\.(jpe?g|png|webp)$/i.test(payload) || !fs.existsSync(payload)) return new Response('nf', { status: 404 });
        return net.fetch(pathToFileURL(payload).toString());
      }
      if (kind === 't') {
        const pct = Math.min(90, Math.max(1, Number(u.searchParams.get('p')) || 25));
        const file = await makeThumb(payload, pct);
        return fileResponse(file);
      }
      return new Response('nf', { status: 404 });
    } catch (err) {
      return new Response(String(err && err.message || err), { status: 404 });
    }
  });
}

function cacheSize() {
  let total = 0;
  const walkDir = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walkDir(f); else { try { total += fs.statSync(f).size; } catch (_) { /* ok */ } }
    }
  };
  walkDir(userDir('cache'));
  return total;
}

function clearCache() {
  try { fs.rmSync(userDir('cache'), { recursive: true, force: true }); } catch (_) { /* ok */ }
}

module.exports = { registerSchemePrivileges, registerProtocol, SCHEME, cacheSize, clearCache };
