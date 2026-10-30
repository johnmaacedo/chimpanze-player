'use strict';
const META_VER = 2; // 2 = IMDb como provedor principal
// Biblioteca: varredura de pastas, agrupamento em filmes/séries/animes e identificação.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { isVideoFile, parseMediaName, normalizeTitle, shouldSkipDir, isSampleFile } = require('./parser');

const ART_NAMES = {
  poster: ['poster', 'folder', 'cover', 'capa'],
  backdrop: ['fanart', 'backdrop', 'background', 'fundo'],
  logo: ['logo', 'clearlogo'],
};
const IMG_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

function hashId(s) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16); }

function findLocalArt(dir) {
  const out = {};
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return out; }
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  for (const [kind, bases] of Object.entries(ART_NAMES)) {
    for (const b of bases) {
      for (const e of IMG_EXT) {
        const hit = lower.get(b + e);
        if (hit) { out[kind] = path.join(dir, hit); break; }
      }
      if (out[kind]) break;
    }
  }
  return out;
}

async function walk(root, onFile, state) {
  const stack = [{ dir: root, rel: [] }];
  while (stack.length) {
    const { dir, rel } = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (shouldSkipDir(ent.name)) continue;
        if (rel.length > 12) continue;
        stack.push({ dir: full, rel: [...rel, ent.name] });
      } else if (ent.isFile() && isVideoFile(ent.name)) {
        let st;
        try { st = await fs.promises.stat(full); } catch (_) { continue; }
        if (isSampleFile(ent.name, st.size)) continue;
        if (st.size < 5 * 1024 * 1024) continue; // ignora arquivos minúsculos (trailers quebrados etc.)
        onFile({ path: full, name: ent.name, rel, size: st.size, mtime: Math.floor(st.mtimeMs) });
        state.count++;
      }
    }
  }
}

class Library extends EventEmitter {
  constructor(store, metadata, getSettings) {
    super();
    this.store = store; // JsonStore
    this.metadata = metadata;
    this.getSettings = getSettings;
    this.queue = [];
    this.running = 0;
    this.scanning = false;
    this._emitTimer = null;
    this.offline = false;
  }

  get data() { return this.store.get(); }

  folders() { return this.data.folders; }

  addFolder(dir) {
    const norm = path.resolve(dir);
    if (!this.data.folders.some((f) => path.resolve(f).toLowerCase() === norm.toLowerCase())) {
      this.data.folders.push(norm);
      this.store.save(0);
    }
  }

  removeFolder(dir) {
    const norm = path.resolve(dir).toLowerCase();
    this.data.folders = this.data.folders.filter((f) => path.resolve(f).toLowerCase() !== norm);
    this.store.save(0);
  }

  snapshot() {
    return { folders: this.data.folders, items: Object.values(this.data.items), scanning: this.scanning, pending: this.queue.length + this.running, offline: this.offline };
  }

  emitUpdated(immediate = false) {
    if (immediate) { clearTimeout(this._emitTimer); this._emitTimer = null; this.emit('updated'); return; }
    if (this._emitTimer) return;
    this._emitTimer = setTimeout(() => { this._emitTimer = null; this.emit('updated'); }, 700);
  }

  async scan() {
    if (this.scanning) return this._scanPromise;
    this.scanning = true;
    this.emit('progress', { phase: 'scan', count: 0 });
    this._scanPromise = this._doScan().finally(() => {
      this.scanning = false;
      this.emit('progress', { phase: 'done' });
      this.emitUpdated(true);
    });
    return this._scanPromise;
  }

  async _doScan() {
    const files = [];
    const state = { count: 0 };
    let lastEmit = 0;
    for (const root of this.data.folders) {
      if (!fs.existsSync(root)) continue;
      await walk(root, (f) => {
        f.root = root;
        files.push(f);
        const now = Date.now();
        if (now - lastEmit > 250) { lastEmit = now; this.emit('progress', { phase: 'scan', count: state.count, current: f.name }); }
      }, state);
    }

    const prev = this.data.items;
    const next = {};
    const now = Date.now();

    for (const f of files) {
      const p = parseMediaName(f.name, f.rel);
      const isEpisode = p.type === 'episode';
      const type = isEpisode ? 'show' : 'movie';
      const normTitle = normalizeTitle(p.title) || normalizeTitle(f.name);
      const key = type === 'movie' ? `movie:${normTitle}:${p.year || ''}` : `show:${normTitle}`;
      let item = next[key];
      if (!item) {
        const old = prev[hashId(key)];
        const id = hashId(key);
        item = {
          id, key, type,
          kind: old ? old.kind : (p.animeHint ? 'anime' : (type === 'movie' ? 'movie' : 'series')),
          title: p.title,
          year: p.year || p.folderYear || null,
          animeHint: p.animeHint,
          addedAt: old ? old.addedAt : now,
          updatedAt: old ? old.updatedAt : now,
          files: [],
          episodes: [],
          meta: old ? old.meta : null,
          episodeMeta: old ? old.episodeMeta || {} : {},
          metaStatus: old ? old.metaStatus : 'pending',
          metaAt: old ? old.metaAt : 0, metaVer: old ? old.metaVer : 0,
          localArt: {},
          dir: path.dirname(f.path),
          root: f.root,
        };
        next[key] = item;
      }
      if (p.animeHint) item.animeHint = true;
      if (!item.year && (p.year || p.folderYear)) item.year = p.year || p.folderYear;
      const fileRec = { path: f.path, size: f.size, mtime: f.mtime, name: f.name };
      if (type === 'movie') {
        item.files.push(fileRec);
      } else {
        item.episodes.push({
          ...fileRec,
          id: hashId(f.path),
          season: p.season == null ? 1 : p.season,
          episode: p.episode,
          episodeEnd: p.episodeEnd,
          absolute: p.absolute,
        });
      }
      const newest = f.mtime;
      if (!prev[item.id] || newest > (item.updatedAt || 0)) item.updatedAt = Math.max(item.updatedAt || 0, Math.min(newest, now));
    }

    // Pós-processamento por item.
    const out = {};
    for (const item of Object.values(next)) {
      if (item.type === 'show') {
        // Ordena e numera episódios sem número.
        item.episodes.sort((a, b) => (a.season - b.season) || ((a.episode ?? 1e9) - (b.episode ?? 1e9)) || a.name.localeCompare(b.name, 'pt', { numeric: true }));
        const bySeason = new Map();
        for (const ep of item.episodes) {
          if (!bySeason.has(ep.season)) bySeason.set(ep.season, []);
          bySeason.get(ep.season).push(ep);
        }
        for (const list of bySeason.values()) {
          let n = 0;
          for (const ep of list) {
            if (ep.episode == null) ep.episode = n + 1;
            n = Math.max(n, ep.episodeEnd || ep.episode);
          }
        }
        // Diretório "da série": ancestral comum dos episódios.
        item.dir = commonDir(item.episodes.map((e) => path.dirname(e.path)));
      } else {
        item.files.sort((a, b) => b.size - a.size);
        item.dir = path.dirname(item.files[0].path);
      }
      // Arte local (pasta da série/filme ou um nível acima quando for pasta de temporada).
      const artDirs = [item.dir];
      if (item.root && item.dir !== item.root) artDirs.push(path.dirname(item.dir));
      for (const d of artDirs) {
        if (!d.toLowerCase().startsWith(String(item.root).toLowerCase()) || d === item.root) continue;
        const art = findLocalArt(d);
        for (const k of Object.keys(art)) if (!item.localArt[k]) item.localArt[k] = art[k];
      }
      // Override manual de identificação persiste entre varreduras.
      const ov = this.data.overrides[item.key];
      if (ov && ov.kind) item.kind = ov.kind;
      if (ov && ov.title) item.customTitle = ov.title;
      if (ov && ov.year) item.customYear = ov.year;
      if (ov && ov.confirmed) item.confirmed = true;
      // Capas escolhidas manualmente têm prioridade sobre tudo.
      if (ov && ov.art) for (const [k, f] of Object.entries(ov.art)) { if (f && fs.existsSync(f)) item.localArt[k] = f; }
      out[item.id] = item;
    }

    this.data.items = out;
    this.data.lastScan = now;
    this.store.save(0);
    this.emit('progress', { phase: 'scan', count: state.count, done: true });

    // Enfileira identificação do que falta.
    for (const item of Object.values(out)) {
      const ovx = this.data.overrides[item.key];
      const upgrade = (item.metaVer || 0) < META_VER && !(ovx && ovx.provider) &&
        (item.metaStatus !== 'ok' || (item.meta && item.meta.provider !== 'imdb'));
      const needs = upgrade || item.metaStatus === 'pending' || item.metaStatus === 'error' ||
        (item.metaStatus === 'notfound' && now - (item.metaAt || 0) > 3 * 24 * 3600e3) ||
        (item.type === 'show' && item.metaStatus === 'ok' && missingSeasons(item));
      if (needs) this.enqueue(item.id);
    }
    return out;
  }

  enqueue(id, front = false) {
    if (this.queue.includes(id)) return;
    if (front) this.queue.unshift(id); else this.queue.push(id);
    this._pump();
  }

  _pump() {
    while (this.running < 3 && this.queue.length) {
      const id = this.queue.shift();
      this.running++;
      this._identify(id)
        .catch((e) => console.error('[library] identificação falhou', e))
        .finally(() => { this.running--; this.emitUpdated(); this._pump(); });
    }
  }

  async _identify(id, forced) {
    const item = this.data.items[id];
    if (!item) return;
    const ov = forced || this.data.overrides[item.key];
    const seasons = item.type === 'show' ? [...new Set(item.episodes.map((e) => e.season))].sort((a, b) => a - b) : [];
    let result = null;
    try {
      if (ov && ov.provider && ov.id) {
        result = await this.metadata.fetchById(ov.provider, ov.id, ov.metaKind || (item.type === 'movie' ? 'movie' : 'tv'), seasons);
      } else {
        result = await this.metadata.identify({
          title: item.title, year: item.year,
          kind: item.type === 'movie' ? 'movie' : 'tv',
          animeHint: item.animeHint || item.kind === 'anime',
          seasons,
        });
        // Segunda tentativa com o nome da pasta, se diferente.
        if (!result && item.dir) {
          const folderName = path.basename(item.dir);
          const { cleanFolderName } = require('./parser');
          const alt = cleanFolderName(folderName);
          if (alt.title && normalizeTitle(alt.title) !== normalizeTitle(item.title)) {
            result = await this.metadata.identify({ title: alt.title, year: alt.year || item.year, kind: item.type === 'movie' ? 'movie' : 'tv', animeHint: item.animeHint, seasons });
          }
        }
      }
      this.offline = false;
    } catch (e) {
      if (e && e.offline) this.offline = true;
      const cur = this.data.items[id];
      if (cur) { cur.metaStatus = 'error'; cur.metaAt = Date.now(); }
      this.store.save();
      return;
    }
    const cur = this.data.items[id];
    if (!cur) return;
    if (result && result.meta) {
      const { episodesMeta, ...meta } = result.meta;
      cur.meta = meta;
      cur.episodeMeta = result.episodes || episodesMeta || {};
      cur.metaStatus = 'ok';
      if (!(ov && ov.kind)) {
        if (cur.type === 'movie') cur.kind = meta.isAnime ? 'anime' : 'movie';
        else cur.kind = meta.isAnime || meta.provider === 'anilist' ? 'anime' : 'series';
      }
      cur.metaSeasons = seasons;
    } else {
      cur.metaStatus = 'notfound';
    }
    cur.metaAt = Date.now();
    cur.metaVer = META_VER;
    this.store.save();
  }

  // Corrigir identificação manualmente.
  async applyMatch(id, choice) {
    const item = this.data.items[id];
    if (!item) throw new Error('Item não encontrado');
    const ov = { provider: choice.provider, id: choice.id, metaKind: choice.kind };
    if (choice.kindOverride) ov.kind = choice.kindOverride;
    this.data.overrides[item.key] = { ...(this.data.overrides[item.key] || {}), ...ov };
    if (choice.kindOverride) item.kind = choice.kindOverride;
    this.data.overrides[item.key].confirmed = true;
    item.confirmed = true;
    await this._identify(id, this.data.overrides[item.key]);
    this.emitUpdated(true);
    return this.data.items[id];
  }

  _ov(item) {
    if (!this.data.overrides[item.key]) this.data.overrides[item.key] = {};
    return this.data.overrides[item.key];
  }

  // Capa/fundo/logo escolhidos pelo usuário (copiados para a pasta do app).
  setArt(id, kind, srcFile, coversDir) {
    const item = this.data.items[id];
    if (!item) throw new Error('Item não encontrado');
    if (!['poster', 'backdrop', 'logo'].includes(kind)) throw new Error('Tipo de imagem inválido');
    const ext = (path.extname(srcFile) || '.jpg').toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) throw new Error('Use uma imagem JPG, PNG ou WEBP.');
    fs.mkdirSync(coversDir, { recursive: true });
    const ov = this._ov(item);
    const old = ov.art && ov.art[kind];
    const dest = path.join(coversDir, `${item.id}-${kind}-${Date.now()}${ext}`);
    fs.copyFileSync(srcFile, dest);
    if (old && old !== dest && old.startsWith(coversDir)) { try { fs.rmSync(old, { force: true }); } catch (_) { /* ok */ } }
    ov.art = { ...(ov.art || {}), [kind]: dest };
    item.localArt = { ...(item.localArt || {}), [kind]: dest };
    this.store.save();
    this.emitUpdated(true);
    return item;
  }

  clearArt(id, kind) {
    const item = this.data.items[id];
    if (!item) return;
    const ov = this._ov(item);
    const f = ov.art && ov.art[kind];
    if (f) { try { fs.rmSync(f, { force: true }); } catch (_) { /* ok */ } delete ov.art[kind]; }
    if (item.localArt) delete item.localArt[kind];
    this.store.save();
    this.scan();
  }

  // Usuário confirmou que a identificação está correta.
  confirm(id, kind) {
    const item = this.data.items[id];
    if (!item) return;
    const ov = this._ov(item);
    ov.confirmed = true;
    item.confirmed = true;
    if (kind) { ov.kind = kind; item.kind = kind; }
    this.store.save();
    this.emitUpdated(true);
  }

  // Cadastro manual (quando nada foi encontrado na internet).
  setManual(id, { title, year, kind, overview }) {
    const item = this.data.items[id];
    if (!item) throw new Error('Item não encontrado');
    const ov = this._ov(item);
    if (title) { ov.title = title; item.customTitle = title; }
    if (year) { ov.year = Number(year) || null; item.customYear = ov.year; }
    if (kind) { ov.kind = kind; item.kind = kind; }
    if (overview != null) {
      ov.overview = overview;
      item.meta = { ...(item.meta || {}), overview, title: title || (item.meta && item.meta.title) || item.title, year: ov.year || (item.meta && item.meta.year) || item.year };
    }
    ov.confirmed = true;
    item.confirmed = true;
    if (item.metaStatus !== 'ok') item.metaStatus = 'manual';
    this.store.save();
    this.emitUpdated(true);
    return item;
  }

  // Itens cujos arquivos estão dentro de um caminho (ex.: download concluído).
  itemsUnderPath(p) {
    const low = String(p || '').toLowerCase().replace(/[\\/]+$/, '');
    if (!low) return [];
    const inside = (f) => { const l = f.toLowerCase(); return l === low || l.startsWith(low + path.sep) || l.startsWith(low + '/'); };
    return Object.values(this.data.items).filter((it) => (it.type === 'movie' ? it.files : it.episodes).some((f) => inside(f.path)));
  }

  async waitIdentified(id, timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const it = this.data.items[id];
      if (!it) return null;
      if (it.metaStatus && it.metaStatus !== 'pending' && !this.queue.includes(id)) return it;
      await new Promise((r) => setTimeout(r, 700));
    }
    return this.data.items[id] || null;
  }

  setKind(id, kind) {
    const item = this.data.items[id];
    if (!item) return;
    item.kind = kind;
    this.data.overrides[item.key] = { ...(this.data.overrides[item.key] || {}), kind };
    this.store.save();
    this.emitUpdated(true);
  }

  refreshMeta(id) {
    const item = this.data.items[id];
    if (!item) return;
    item.metaStatus = 'pending';
    this.enqueue(id, true);
  }

  refreshAllFailed() {
    for (const it of Object.values(this.data.items)) {
      if (it.metaStatus !== 'ok') { it.metaStatus = 'pending'; this.enqueue(it.id); }
    }
  }

  findByPath(p) {
    const low = String(p).toLowerCase();
    for (const it of Object.values(this.data.items)) {
      if (it.type === 'movie') {
        if (it.files.some((f) => f.path.toLowerCase() === low)) return { item: it };
      } else {
        const idx = it.episodes.findIndex((e) => e.path.toLowerCase() === low);
        if (idx >= 0) return { item: it, episode: it.episodes[idx], index: idx };
      }
    }
    return null;
  }
}

function missingSeasons(item) {
  if (!item.meta || item.meta.provider === 'itunes') return false;
  if (item.meta.provider !== 'tmdb' && item.meta.provider !== 'imdb') return false;
  const have = new Set(item.metaSeasons || []);
  return item.episodes.some((e) => !have.has(e.season));
}

function commonDir(dirs) {
  if (!dirs.length) return '';
  let parts = dirs[0].split(/[\\/]/);
  for (const d of dirs.slice(1)) {
    const p = d.split(/[\\/]/);
    let i = 0;
    while (i < parts.length && i < p.length && parts[i].toLowerCase() === p[i].toLowerCase()) i++;
    parts = parts.slice(0, i);
  }
  const joined = parts.join(path.sep);
  return joined || dirs[0];
}

module.exports = { Library, commonDir, hashId };
