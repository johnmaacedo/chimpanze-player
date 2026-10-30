'use strict';
// Persistência simples em JSON com escrita atômica e debounce.
const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = null;
    this._timer = null;
    this._writing = false;
    this._pending = false;
    this.load();
  }

  load() {
    let loaded = null;
    for (const f of [this.file, this.file + '.bak']) {
      try {
        const raw = fs.readFileSync(f, 'utf8');
        loaded = JSON.parse(raw);
        break;
      } catch (_) { /* tenta o backup */ }
    }
    this.data = mergeDefaults(loaded, clone(this.defaults));
    return this.data;
  }

  get() { return this.data; }

  // Agenda gravação (agrupa várias alterações seguidas).
  save(delay = 400) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), delay);
  }

  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const json = JSON.stringify(this.data);
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, json, 'utf8');
      try { if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak'); } catch (_) { /* ok */ }
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] falha ao salvar', this.file, err);
    }
  }
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function mergeDefaults(value, defaults) {
  if (value === null || value === undefined) return defaults;
  if (Array.isArray(defaults)) return Array.isArray(value) ? value : defaults;
  if (typeof defaults === 'object' && defaults !== null) {
    if (typeof value !== 'object' || Array.isArray(value)) return defaults;
    const out = { ...value };
    for (const k of Object.keys(defaults)) {
      out[k] = mergeDefaults(value[k], defaults[k]);
    }
    return out;
  }
  return typeof value === typeof defaults ? value : defaults;
}

module.exports = { JsonStore, mergeDefaults };
