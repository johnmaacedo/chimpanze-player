'use strict';
// Cliente JSON-IPC do mpv (named pipe no Windows, socket Unix nos demais).
const net = require('net');
const { EventEmitter } = require('events');

class MpvIpc extends EventEmitter {
  constructor(socketPath) {
    super();
    this.socketPath = socketPath;
    this.sock = null;
    this.buf = '';
    this.reqId = 1;
    this.pending = new Map();
    this.observers = new Map(); // id -> name
    this.connected = false;
    this.closed = false;
  }

  async connect(timeoutMs = 15000, isAlive = () => true) {
    const start = Date.now();
    let lastErr = null;
    while (Date.now() - start < timeoutMs && !this.closed) {
      if (!isAlive()) throw new Error('O mpv encerrou durante a inicialização.');
      try {
        await this._tryConnect();
        return;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 120));
      }
    }
    throw lastErr || new Error('Não foi possível conectar ao mpv');
  }

  _tryConnect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect(this.socketPath);
      const onErr = (e) => { sock.destroy(); reject(e); };
      sock.once('error', onErr);
      sock.once('connect', () => {
        sock.removeListener('error', onErr);
        this.sock = sock;
        this.connected = true;
        sock.setEncoding('utf8');
        sock.on('data', (d) => this._onData(d));
        sock.on('error', (e) => this.emit('error', e));
        sock.on('close', () => {
          this.connected = false;
          for (const { reject: rj } of this.pending.values()) rj(new Error('mpv encerrado'));
          this.pending.clear();
          this.emit('close');
        });
        resolve();
      });
    });
  }

  _onData(d) {
    this.buf += d;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg.request_id && this.pending.has(msg.request_id)) {
        const { resolve, reject } = this.pending.get(msg.request_id);
        this.pending.delete(msg.request_id);
        if (msg.error && msg.error !== 'success') reject(Object.assign(new Error(msg.error), { mpv: true }));
        else resolve(msg.data);
      } else if (msg.event === 'property-change') {
        this.emit('property', msg.name, msg.data);
      } else if (msg.event) {
        this.emit('event', msg.event, msg);
      }
    }
  }

  command(...args) {
    if (!this.connected) return Promise.reject(new Error('mpv não conectado'));
    const id = this.reqId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.sock.write(JSON.stringify({ command: args, request_id: id }) + '\n');
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout: ' + args[0])); }
      }, 15000);
    });
  }

  get(name) { return this.command('get_property', name); }
  set(name, value) { return this.command('set_property', name, value); }

  // Versão que não lança erro (para comandos de interface).
  safe(...args) { return this.command(...args).catch((e) => { this.emit('cmd-error', args, e); return undefined; }); }

  observe(name) {
    const id = this.observers.size + 1;
    this.observers.set(id, name);
    return this.safe('observe_property', id, name);
  }

  close() {
    this.closed = true;
    try { if (this.sock) this.sock.destroy(); } catch (_) { /* ok */ }
  }
}

module.exports = { MpvIpc };
