'use strict';
// Traduz as configurações de imagem/fluidez em opções e comandos do mpv.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { IS_WIN, shadersDir, vsRuntime, asciiWorkDir, ensureDir } = require('./paths');

const DEFAULT_VIDEO = Object.freeze({
  brightness: 0, contrast: 0, saturation: 0, gamma: 0, hue: 0,
  exposure: 0, temperature: 0, tint: 0, vibrance: 0,
  sharpness: 0,
  deband: true,
  upscaler: 'none',          // none | rtx | anime4k-a | anime4k-b | anime4k-c
  anime4kQuality: 'hq',      // hq | fast
  rtxHdr: false,
  motion: 'rife',            // off (original) | rife (60 FPS com IA)
  targetFps: 60,             // 60 | 90 | 120 | 144 | 0 (= taxa do monitor)
  rifeModel: 'balanced',     // fast | balanced | quality
  aiEngine: 'auto',          // auto | rtx | vulkan
  aiRes: 'auto',             // auto | native | 1080 | 720  (resolução em que a IA trabalha)
  aiAdaptive: true,          // reduz a carga automaticamente se houver travadas
});

const PRESETS = {
  padrao: { ...DEFAULT_VIDEO },
  cinema: { ...DEFAULT_VIDEO, contrast: 4, saturation: 2, gamma: -2, sharpness: 0.3, temperature: 0.05, deband: true },
  vivido: { ...DEFAULT_VIDEO, contrast: 8, saturation: 12, vibrance: 0.35, sharpness: 0.6, exposure: 0.1 },
  anime: { ...DEFAULT_VIDEO, saturation: 6, vibrance: 0.25, sharpness: 0.5, deband: true, upscaler: 'anime4k-a', anime4kQuality: 'hq' },
  fluido: { ...DEFAULT_VIDEO, motion: 'rife', targetFps: 60, rifeModel: 'balanced', sharpness: 0.3 },
};

// Motor Vulkan: o 4.22 lite é o mais leve dos modelos embutidos.
const RIFE_MODELS = {
  fast: 'rife-v4.22_lite_ensembleFalse',
  balanced: 'rife-v4.6_ensembleFalse',
  quality: 'rife-v4.26_ensembleFalse',
};

function sanitizeVideo(v) {
  const o = { ...DEFAULT_VIDEO, ...(v || {}) };
  const clamp = (x, a, b, d) => { x = Number(x); return Number.isFinite(x) ? Math.min(b, Math.max(a, x)) : d; };
  for (const k of ['brightness', 'contrast', 'saturation', 'gamma', 'hue']) o[k] = Math.round(clamp(o[k], -100, 100, 0));
  o.exposure = clamp(o.exposure, -3, 3, 0);
  o.temperature = clamp(o.temperature, -1, 1, 0);
  o.tint = clamp(o.tint, -1, 1, 0);
  o.vibrance = clamp(o.vibrance, -1, 1, 0);
  o.sharpness = clamp(o.sharpness, 0, 2, 0);
  o.deband = !!o.deband;
  o.rtxHdr = !!o.rtxHdr;
  if (!['none', 'rtx', 'anime4k-a', 'anime4k-b', 'anime4k-c'].includes(o.upscaler)) o.upscaler = 'none';
  if (!['hq', 'fast'].includes(o.anime4kQuality)) o.anime4kQuality = 'hq';
  // Foco em 60 FPS: só "Original" ou "60 FPS com IA". O antigo modo Suave vira IA.
  if (o.motion === 'smooth') o.motion = 'rife';
  if (!['off', 'rife'].includes(o.motion)) o.motion = 'rife';
  o.targetFps = 60;
  if (!RIFE_MODELS[o.rifeModel]) o.rifeModel = 'balanced';
  if (!['auto', 'rtx', 'vulkan'].includes(o.aiEngine)) o.aiEngine = 'auto';
  if (!['auto', 'native', '1080', '720'].includes(String(o.aiRes))) o.aiRes = 'auto';
  o.aiRes = String(o.aiRes);
  o.aiAdaptive = o.aiAdaptive !== false;
  return o;
}

function anime4kShaders(mode, quality) {
  const dir = path.join(shadersDir(), 'anime4k');
  const f = (n) => path.join(dir, `Anime4K_${n}.glsl`);
  const hq = quality === 'hq';
  const big = hq ? 'VL' : 'M';
  const small = hq ? 'M' : 'S';
  const tail = [f('AutoDownscalePre_x2'), f('AutoDownscalePre_x4'), f(`Upscale_CNN_x2_${small}`)];
  if (mode === 'anime4k-a') return [f('Clamp_Highlights'), f(`Restore_CNN_${big}`), f(`Upscale_CNN_x2_${big}`), ...tail];
  if (mode === 'anime4k-b') return [f('Clamp_Highlights'), f(`Restore_CNN_Soft_${big}`), f(`Upscale_CNN_x2_${big}`), ...tail];
  if (mode === 'anime4k-c') return [f('Clamp_Highlights'), f(`Upscale_Denoise_CNN_x2_${big}`), ...tail];
  return [];
}

function shaderList(v) {
  const list = [];
  if (v.upscaler.startsWith('anime4k')) list.push(...anime4kShaders(v.upscaler, v.anime4kQuality));
  const colorActive = v.exposure !== 0 || v.temperature !== 0 || v.tint !== 0 || v.vibrance !== 0;
  if (colorActive) list.push(path.join(shadersDir(), 'chimp', 'chimp-color.glsl'));
  if (v.sharpness > 0) list.push(path.join(shadersDir(), 'chimp', 'chimp-sharpen.glsl'));
  return list.filter((p) => fs.existsSync(p));
}

function shaderOpts(v) {
  return {
    chimp_exposure: v.exposure.toFixed(3),
    chimp_temperature: v.temperature.toFixed(3),
    chimp_tint: v.tint.toFixed(3),
    chimp_vibrance: v.vibrance.toFixed(3),
    chimp_sharpness: v.sharpness.toFixed(3),
  };
}

// Escapa um valor de sub-opção de filtro do mpv: %N%valor (N = bytes UTF-8).
function mpvQuote(value) {
  return `%${Buffer.byteLength(value, 'utf8')}%${value}`;
}

function rifeAvailable() {
  const rt = vsRuntime();
  return fs.existsSync(rt.vsscript) && fs.existsSync(rt.rifeDll);
}

function pyStr(s) {
  // String Python segura (raw não aceita barra no final; usamos escape normal).
  return JSON.stringify(String(s));
}

// Gera o script VapourSynth de interpolação por IA.
// opts: { engine: 'rtx' | 'vulkan', dims: {w,h}|null, rtx: { dir, dll, engines, cuda, model, fp16 } }
function writeRifeScript(v, statusFile, opts = {}) {
  const rt = vsRuntime();
  const engine = opts.engine === 'rtx' ? 'rtx' : 'vulkan';
  const dims = opts.dims || null;
  const r = opts.rtx || {};
  const modelPath = path.join(rt.rifeModels, RIFE_MODELS[v.rifeModel]);
  const dir = ensureDir(path.join(asciiWorkDir(), 'vs'));
  const body = `# Gerado pelo Chimpanze Player
import sys
import vapoursynth as vs
from fractions import Fraction
core = vs.core
STATUS = ${pyStr(statusFile)}
ENGINE = ${pyStr(engine)}
PW = ${dims ? Math.round(dims.w) : 0}
PH = ${dims ? Math.round(dims.h) : 0}

def status(msg):
    try:
        with open(STATUS, "w", encoding="utf-8") as fh:
            fh.write(msg)
    except Exception:
        pass

def valid(x):
    try:
        return x == x and x is not None and float(x) > 1.0
    except Exception:
        return False

out = video_in
try:
    src = float(container_fps) if valid(container_fps) else 23.976
    target = float(${Number(v.targetFps) || 0})
    if target <= 0:
        target = float(display_fps) if valid(display_fps) else 60.0
    srcf = Fraction(src).limit_denominator(1001)
    tgtf = Fraction(target).limit_denominator(1001)
    if tgtf <= srcf * Fraction(101, 100):
        status("passthrough|O vídeo já tem %.3g fps (alvo %.3g fps)." % (float(srcf), float(tgtf)))
    else:
        clip = core.std.AssumeFPS(video_in, fpsnum=srcf.numerator, fpsden=srcf.denominator)
        fmt = clip.format
        # Motor RTX trabalha em meia precisão (metade dos dados por quadro); o Vulkan exige 32 bits.
        RGBFMT = vs.RGBH if ENGINE == "rtx" else vs.RGBS
        matrix = "709" if clip.height >= 600 else "170m"
        if PW > 0 and PH > 0 and (PW != clip.width or PH != clip.height):
            rgb = core.resize.Bicubic(clip, width=PW, height=PH, format=RGBFMT, matrix_in_s=matrix)
        else:
            rgb = core.resize.Bicubic(clip, format=RGBFMT, matrix_in_s=matrix)
        if ENGINE == "rtx":
            RTX = ${pyStr(r.dir || '')}
            if not hasattr(core, "trt"):
                core.std.LoadPlugin(path=${pyStr(r.dll || '')})
            if RTX not in sys.path:
                sys.path.insert(0, RTX)
            import vsmlrt
            # Mesmo caminho usado pelo SVP: TensorRT completo, RIFE v2 (a rede calcula a grade e o
            # preenchimento internamente) e FP16 de ponta a ponta.
            backend = vsmlrt.Backend.TRT(
                fp16=True, output_format=1, device_id=0, num_streams=3, use_cuda_graph=True,
                static_shape=False, min_shapes=(64, 64), opt_shapes=(1920, 1080), max_shapes=(1920, 1088),
                engine_folder=${pyStr(r.engines || '')})
            rgb = vsmlrt.RIFE(rgb, multi=tgtf / srcf, model=vsmlrt.RIFEModel.${r.model || 'v4_22_lite'}, backend=backend, video_player=True, _implementation=2)
            label = "RTX (Tensor Cores)"
        else:
            if not hasattr(core, "rife"):
                core.std.LoadPlugin(path=${pyStr(rt.rifeDll)})
            rgb = core.rife.RIFE(rgb, model_path=${pyStr(modelPath)}, fps_num=tgtf.numerator, fps_den=tgtf.denominator, gpu_thread=3, uhd=(rgb.height > 1440))
            label = "Vulkan"
        res = core.resize.Bicubic(rgb, format=fmt.id, matrix_s=matrix)
        out = core.std.AssumeFPS(res, fpsnum=tgtf.numerator, fpsden=tgtf.denominator)
        status("ok|%s · %.3g → %.3g fps%s" % (label, float(srcf), float(tgtf), (" · IA em %dp" % rgb.height) if (PH and PH != clip.height) else ""))
except Exception as e:
    status("erro|" + str(e)[:400])
    out = video_in

out.set_output()
`;
  const hash = crypto.createHash('sha1').update(body).digest('hex').slice(0, 10);
  const file = path.join(dir, `rife-${hash}.vpy`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, body, 'utf8');
  return file;
}

/**
 * Calcula a cadeia de filtros (vf) e o hwdec necessários.
 * ctx: { videoH, displayH, rife: { engine, dims, rtx } | null }
 */
function buildFilters(v, ctx, statusFile) {
  const parts = [];
  let hwdec = IS_WIN ? 'd3d11va' : 'auto-safe';
  const notes = [];
  if (v.motion === 'rife') {
    if (rifeAvailable() || (ctx.rife && ctx.rife.engine === 'rtx')) {
      const script = writeRifeScript(v, statusFile, ctx.rife || {});
      parts.push(`vapoursynth=file=${mpvQuote(script)}:buffered-frames=8:concurrent-frames=${ctx.rife && ctx.rife.engine === 'rtx' ? 8 : 4}`);
      hwdec = IS_WIN ? 'd3d11va-copy' : 'auto-copy-safe';
    } else {
      notes.push('Motor de interpolação por IA não encontrado nesta instalação.');
    }
  }
  if (IS_WIN && (v.upscaler === 'rtx' || v.rtxHdr)) {
    const opts = [];
    if (v.upscaler === 'rtx' && ctx.videoH && ctx.displayH) {
      const scale = Math.min(4, ctx.displayH / ctx.videoH);
      if (scale >= 1.1) opts.push(`scale=${scale.toFixed(3)}`, 'scaling-mode=nvidia');
    }
    if (v.rtxHdr) opts.push('nvidia-true-hdr');
    if (opts.length) parts.push(`d3d11vpp=${opts.join(':')}`);
  }
  return { vf: parts.join(','), hwdec, notes };
}

function motionProps(v) {
  if (v.motion === 'smooth') return { 'video-sync': 'display-resample', interpolation: true, tscale: 'oversample' };
  if (v.motion === 'rife') return { 'video-sync': 'display-resample', interpolation: false };
  return { 'video-sync': 'audio', interpolation: false };
}

module.exports = {
  DEFAULT_VIDEO, PRESETS, RIFE_MODELS, sanitizeVideo, shaderList, shaderOpts, buildFilters, motionProps,
  mpvQuote, rifeAvailable, anime4kShaders, writeRifeScript,
};
