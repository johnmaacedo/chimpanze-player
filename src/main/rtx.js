'use strict';
// Motor RTX: interpolação RIFE com TensorRT para RTX (Tensor Cores), via vs-mlrt.
// O runtime da NVIDIA (TensorRT-RTX) é baixado sob demanda direto da NVIDIA no PC do usuário.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { net } = require('electron');
const { IS_WIN, resourcesDir, asciiWorkDir, ensureDir, vsRuntime } = require('./paths');

// TensorRT completo (o mesmo que o SVP usa), empacotado pelo projeto vs-mlrt no GitHub (sem login).
const TRT_PARTS = [
  'https://github.com/AmusementClub/vs-mlrt/releases/download/v15.16/vsmlrt-cuda.v15.16.7z.001',
  'https://github.com/AmusementClub/vs-mlrt/releases/download/v15.16/vsmlrt-cuda.v15.16.7z.002',
];
const TRT_RTX_URL = 'https://github.com/AmusementClub/vs-mlrt/releases/tag/v15.16';
// Só o necessário para TensorRT (≈2 GB descompactado) — o pacote completo tem CUDA/cuDNN que não usamos.
const TRT_FILES = [
  'nvinfer_10.dll', 'nvinfer_plugin_10.dll', 'nvonnxparser_10.dll', 'nvinfer_builder_resource_*.dll',
  'cudart64_13.dll', 'nvrtc64_130_0.dll', 'nvrtc-builtins64_132.dll',
  'msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll',
];
const BUNDLE_VERSION = 2;
const TRT_PART_SIZES = [2147483647, 464467988];

// Chave interna -> nome do modelo no vs-mlrt
const MODELS = { fast: 'v4_22_lite', balanced: 'v4_25_lite', quality: 'v4_26' };
const PAD = { fast: 32, balanced: 32, quality: 64 };

function bundleDir() { return path.join(resourcesDir(), 'vs', 'rtx'); }
function baseDir() { return path.join(asciiWorkDir(), 'rtx'); }
function cudaDir() { return path.join(baseDir(), 'vsmlrt-cuda'); }
function stateFile() { return path.join(baseDir(), 'state.json'); }

class RtxEngine extends EventEmitter {
  constructor() {
    super();
    this.busy = null; // 'install' | 'build'
    this.builds = new Map(); // model -> Promise
    this.state = this._loadState();
  }

  _loadState() {
    let st;
    try { st = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (_) { st = { engines: {} }; }
    // Motores de versões anteriores (TensorRT-RTX) não servem mais.
    if (st.bundleVersion !== BUNDLE_VERSION) st = { engines: {} };
    if (!st.engines) st.engines = {};
    return st;
  }

  _saveState() {
    try { ensureDir(baseDir()); fs.writeFileSync(stateFile(), JSON.stringify(this.state, null, 1)); } catch (_) { /* ok */ }
  }

  bundled() { return fs.existsSync(path.join(bundleDir(), 'vstrt.dll')); }

  runtimeInstalled() {
    try {
      const f = fs.readdirSync(cudaDir()); return f.includes('nvinfer_10.dll') && f.includes('trtexec.exe') && f.some((x) => /^nvinfer_builder_resource_/i.test(x));
    } catch (_) { return false; }
  }

  installed() {
    return IS_WIN && this.bundled() && this.runtimeInstalled() && this.state.verified === true && this.state.bundleVersion === BUNDLE_VERSION;
  }

  engineReady(key) {
    const e = this.state.engines && this.state.engines[key];
    return !!(e && e.ok);
  }

  status() {
    return {
      supported: IS_WIN && this.bundled(),
      installed: this.installed(),
      runtimeDownloaded: this.runtimeInstalled(),
      busy: this.busy,
      device: this.state.device || null,
      engines: this.state.engines || {},
      lastError: this.state.lastError || null,
    };
  }

  dirs() {
    return { base: baseDir(), cuda: cudaDir(), engines: path.join(baseDir(), 'engines'), dll: path.join(baseDir(), 'vstrt.dll') };
  }

  // ---------- instalação ----------
  async install({ manualZip } = {}) {
    if (this.busy) throw new Error('O motor RTX já está sendo preparado.');
    if (!IS_WIN) throw new Error('O motor RTX funciona apenas no Windows.');
    this.busy = 'install';
    this._progress('Preparando…', 0);
    try {
      // 1) arquivos embutidos (plugin, modelos, script)
      this._copyBundle();
      // 2) TensorRT completo (download do GitHub; ~2,5 GB, uma vez só)
      const dl = ensureDir(path.join(baseDir(), 'download'));
      if (!this.runtimeInstalled()) {
        const arc = path.join(dl, 'vsmlrt-cuda.7z');
        if (manualZip && /\.7z$/i.test(manualZip)) {
          fs.copyFileSync(manualZip, arc);
        } else if (manualZip && /\.001$/i.test(manualZip)) {
          // Partes baixadas pelo navegador: junta .001 + .002.
          const p2 = manualZip.replace(/\.001$/i, '.002');
          if (!fs.existsSync(p2)) throw new Error('Coloque o arquivo .002 na mesma pasta do .001.');
          this._progress('Juntando as partes…', 60);
          fs.copyFileSync(manualZip, arc);
          await new Promise((res, rej) => { const w = fs.createWriteStream(arc, { flags: 'a' }); fs.createReadStream(p2).on('error', rej).pipe(w).on('finish', res).on('error', rej); });
        } else {
          // Continua de onde parou (inclusive depois de fechar o app).
          const total = TRT_PART_SIZES[0] + TRT_PART_SIZES[1];
          let have = fs.existsSync(arc) ? fs.statSync(arc).size : 0;
          if (have > total) { fs.rmSync(arc, { force: true }); have = 0; }
          for (let i = 0; i < TRT_PARTS.length; i++) {
            const start = i === 0 ? 0 : TRT_PART_SIZES[0];
            const end = start + TRT_PART_SIZES[i];
            if (have >= end) continue;
            await this._resumable(TRT_PARTS[i], arc, have - start, TRT_PART_SIZES[i], `Baixando TensorRT (parte ${i + 1} de 2)`, start, total);
            have = fs.statSync(arc).size;
          }
          if (fs.statSync(arc).size !== total) throw new Error('Download incompleto. Clique em Instalar de novo para continuar.');
        }
        this._progress('Extraindo TensorRT (alguns minutos)…', 80);
        await this._extract7z(arc, cudaDir());
      }
      // 3) verificação
      this._progress('Verificando a placa de vídeo…', 85);
      const check = await this._runTool(['check'], 120000);
      if (!check.ok) throw new Error(check.error || 'Falha ao carregar o motor RTX.');
      this.state.device = check.device || null;
      this.state.verified = true;
      this.state.bundleVersion = BUNDLE_VERSION;
      this.state.lastError = null;
      this._saveState();
      try { fs.rmSync(dl, { recursive: true, force: true }); } catch (_) { /* ok */ }
      this._progress('Motor RTX instalado.', 90);
      this.busy = null;
      // 5) otimiza o modelo padrão já agora
      await this.ensureEngine('balanced');
      this._progress('Pronto!', 100, true);
      return this.status();
    } catch (err) {
      this.state.lastError = err.message;
      this._saveState();
      this.busy = null;
      this._progress('Erro: ' + err.message, -1, true);
      throw err;
    } finally {
      this.busy = null;
    }
  }

  _copyBundle() {
    const src = bundleDir();
    const dst = ensureDir(baseDir());
    ensureDir(path.join(dst, 'engines'));
    for (const f of ['vstrt.dll', 'vsmlrt.py', 'rtx_tool.py']) fs.copyFileSync(path.join(src, f), path.join(dst, f));
    for (const sub of ['rife', 'rife_v2']) {
      const from = path.join(src, 'models', sub);
      if (!fs.existsSync(from)) continue;
      const to = ensureDir(path.join(dst, 'models', sub));
      for (const f of fs.readdirSync(from)) {
        const t = path.join(to, f);
        if (!fs.existsSync(t) || fs.statSync(t).size !== fs.statSync(path.join(from, f)).size) fs.copyFileSync(path.join(from, f), t);
      }
    }
    ensureDir(cudaDir());
    fs.copyFileSync(path.join(src, 'trtexec.exe'), path.join(cudaDir(), 'trtexec.exe'));
  }

  // Download com retomada: se ficar lento ou parado, reconecta pedindo só o que falta (Range).
  async _resumable(url, file, offset, size, label, base, total) {
    let tries = 0;
    while (offset < size) {
      const ctrl = new AbortController();
      let lastData = Date.now();
      let winBytes = 0;
      let winStart = Date.now();
      let reason = '';
      const watchdog = setInterval(() => {
        const now = Date.now();
        if (now - lastData > 15000) { reason = 'parado'; ctrl.abort(); }
        else if (now - winStart > 20000) {
          if (winBytes / ((now - winStart) / 1000) < 300 * 1024) { reason = 'lento'; ctrl.abort(); }
          winBytes = 0; winStart = now;
        }
      }, 2000);
      try {
        const res = await net.fetch(url, { headers: { Range: `bytes=${offset}-` }, signal: ctrl.signal });
        if (res.status !== 206 && !(res.status === 200 && offset === 0)) throw new Error('HTTP ' + res.status);
        const out = fs.createWriteStream(file, { flags: 'a' });
        const reader = res.body.getReader();
        let last = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            lastData = Date.now();
            winBytes += value.length;
            offset += value.length;
            if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
            if (lastData - last > 400) {
              last = lastData;
              const got = base + offset;
              this._progress(`${label}… ${(got / 1048576).toFixed(0)} MB de ${(total / 1048576).toFixed(0)} MB`, 2 + 76 * (got / total));
            }
          }
        } finally {
          await new Promise((r) => out.end(r));
        }
        tries = 0;
      } catch (e) {
        offset = fs.statSync(file).size - base;
        if (++tries > 40) throw new Error('A conexão com o GitHub caiu muitas vezes. Tente de novo mais tarde (o download continua de onde parou).');
        this._progress(`${label}: conexão ${reason || 'instável'}, reconectando…`, 2 + 76 * ((base + offset) / total));
        await new Promise((r) => setTimeout(r, 1500));
      } finally {
        clearInterval(watchdog);
      }
    }
  }

  _extract7z(archive, outDir) {
    return new Promise((resolve, reject) => {
      const tmp = ensureDir(path.join(baseDir(), 'download', 'x'));
      const args = ['x', '-y', `-o${tmp}`, archive, '-r', ...TRT_FILES];
      execFile(path.join(bundleDir(), '7zr.exe'), args, { windowsHide: true, maxBuffer: 1 << 26 }, (err, _o, stderr) => {
        if (err) { reject(new Error('Falha ao extrair o TensorRT: ' + String(stderr || err.message).slice(0, 300))); return; }
        try {
          const from = path.join(tmp, 'vsmlrt-cuda');
          ensureDir(outDir);
          for (const f of fs.readdirSync(from)) fs.renameSync(path.join(from, f), path.join(outDir, f));
          fs.rmSync(tmp, { recursive: true, force: true });
          resolve();
        } catch (e) { reject(e); }
      });
    });
  }

  async _download(url, file, label, p0, p1, append = false) {
    const res = await net.fetch(url, { redirect: 'follow' });
    if (!res.ok) {
      const e = new Error(`O download falhou (HTTP ${res.status}). Verifique a internet e tente de novo.`);
      e.code = 'DOWNLOAD';
      throw e;
    }
    const ctype = String(res.headers.get('content-type') || '');
    if (/text\/html/i.test(ctype)) {
      const e = new Error('A NVIDIA pediu login/aceite para este download. Abra a página do TensorRT para RTX, baixe o arquivo .zip para Windows e use "Já baixei o arquivo da NVIDIA".');
      e.code = 'DOWNLOAD';
      throw e;
    }
    const total = Number(res.headers.get('content-length')) || 0;
    const tmp = append ? file : file + '.part';
    const out = fs.createWriteStream(tmp, { flags: append ? 'a' : 'w' });
    let got = 0;
    let last = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
        const now = Date.now();
        if (now - last > 300) {
          last = now;
          const frac = total ? got / total : 0;
          this._progress(`${label}… ${(got / 1048576).toFixed(0)} MB${total ? ' de ' + (total / 1048576).toFixed(0) + ' MB' : ''}`, p0 + (p1 - p0) * frac);
        }
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    if (total && got < total) { if (append) fs.rmSync(file, { force: true }); throw new Error('Download incompleto. Verifique a internet e tente novamente.'); }
    if (!append) fs.renameSync(tmp, file);
  }

  // ---------- motores (um por modelo; aceita qualquer resolução até 1920x1088) ----------
  ensureEngine(modelKey) {
    if (!MODELS[modelKey]) modelKey = 'balanced';
    if (this.engineReady(modelKey)) return Promise.resolve(this.state.engines[modelKey]);
    if (this.builds.has(modelKey)) return this.builds.get(modelKey);
    const p = (async () => {
      this.emit('build', { model: modelKey, phase: 'start' });
      this._progress(`Otimizando a IA para sua placa (${labelOf(modelKey)}) — só na primeira vez, leva de 3 a 8 minutos…`, 92);
      const r = await this._runTool(['build', MODELS[modelKey]], 25 * 60000);
      if (!r.ok) {
        this.state.engines[modelKey] = { ok: false, error: r.error, at: Date.now() };
        this.state.lastError = r.error;
        this._saveState();
        this.emit('build', { model: modelKey, phase: 'error', error: r.error });
        throw new Error(r.error || 'Falha ao otimizar a IA.');
      }
      this.state.engines[modelKey] = { ok: true, fp16: r.fp16, fps: r.fps, seconds: r.build_seconds, at: Date.now() };
      if (r.device) this.state.device = r.device;
      this._saveState();
      this.emit('build', { model: modelKey, phase: 'done', result: this.state.engines[modelKey] });
      return this.state.engines[modelKey];
    })().finally(() => this.builds.delete(modelKey));
    this.builds.set(modelKey, p);
    return p;
  }

  engineInfo(modelKey) { return (this.state.engines || {})[modelKey] || null; }

  _runTool(args, timeoutMs) {
    return new Promise((resolve) => {
      const rt = vsRuntime();
      const py = path.join(rt.python, 'python.exe');
      const env = {
        ...process.env,
        PATH: `${cudaDir()};${rt.python};${process.env.PATH || ''}`,
        PYTHONNOUSERSITE: '1',
        PYTHONIOENCODING: 'utf-8',
        CUDA_MODULE_LOADING: 'LAZY',
      };
      delete env.PYTHONHOME; delete env.PYTHONPATH;
      const child = spawn(py, [path.join(baseDir(), 'rtx_tool.py'), args[0], baseDir(), ...args.slice(1)], { windowsHide: true, env, cwd: baseDir() });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err = (err + d).slice(-8000); });
      const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* ok */ } }, timeoutMs);
      const finish = (code) => {
        clearTimeout(timer);
        const lines = out.trim().split(/\r?\n/).filter(Boolean);
        let j = null;
        for (let i = lines.length - 1; i >= 0 && !j; i--) { try { j = JSON.parse(lines[i]); } catch (_) { /* próxima */ } }
        if (!j) j = { ok: false, error: friendlyError(err) || `Processo terminou com código ${code}.` };
        else if (!j.ok) j.error = friendlyError(j.error + '\n' + err) || j.error;
        try { fs.writeFileSync(path.join(baseDir(), 'last-tool.log'), `${args.join(' ')}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`); } catch (_) { /* ok */ }
        resolve(j);
      };
      child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
      child.on('exit', finish);
    });
  }

  _progress(text, pct, done = false) {
    this.emit('progress', { text, pct, done, status: this.status() });
  }

  uninstall() {
    fs.rmSync(baseDir(), { recursive: true, force: true });
    this.state = { engines: {} };
    return this.status();
  }
}

function labelOf(k) { return { fast: 'modelo rápido', balanced: 'modelo equilibrado', quality: 'modelo de qualidade' }[k] || k; }

function friendlyError(text) {
  const t = String(text || '');
  if (/driver too old|CUDA driver version is insufficient|cudaErrorInsufficientDriver/i.test(t)) return 'O driver da NVIDIA está desatualizado para o TensorRT. Atualize o driver pelo app da NVIDIA e tente de novo.';
  if (/no CUDA-capable|cudaErrorNoDevice|invalid device/i.test(t)) return 'Nenhuma placa NVIDIA compatível foi encontrada.';
  if (/Failed to load|cannot load|LoadLibrary|126/i.test(t)) return 'Não foi possível carregar as bibliotecas do TensorRT para RTX. Reinstale o motor RTX.';
  if (/out of memory|OOM/i.test(t)) return 'Memória de vídeo insuficiente para otimizar a IA. Feche outros programas e tente de novo.';
  const m = t.match(/(RuntimeError|Error|vapoursynth\.Error)[:\s]+([^\n]{5,200})/);
  return m ? m[2] : '';
}

/**
 * Dimensões de processamento para a IA.
 * res: 'auto' | 'native' | '1080' | '720'
 * Para o motor RTX o limite é 1920x1080 (o motor é otimizado até 1920x1088).
 */
function processDims(w, h, res, engine) {
  if (!w || !h) return null;
  let limitH = Infinity;
  if (res === '1080') limitH = 1080;
  if (res === '720') limitH = 720;
  if (res === 'auto' && h > 1080) limitH = 1080;
  let s = Math.min(1, limitH / h);
  if (engine === 'rtx') s = Math.min(s, 1920 / w, 1080 / h);
  if (s >= 0.999) return { w, h, scaled: false };
  const nw = Math.max(64, Math.round((w * s) / 2) * 2);
  const nh = Math.max(64, Math.round((h * s) / 2) * 2);
  return { w: nw, h: nh, scaled: true };
}

module.exports = { RtxEngine, MODELS, PAD, processDims, TRT_RTX_URL, friendlyError };
