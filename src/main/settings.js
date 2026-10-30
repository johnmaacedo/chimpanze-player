'use strict';
const { DEFAULT_VIDEO } = require('./video-profile');

const DEFAULT_SETTINGS = {
  firstRun: true,
  metadata: { tmdbKey: '', language: 'pt-BR' },
  player: {
    fullscreen: true,
    gpuApi: 'd3d11',
    forceNvidia: true,
    audioLang: '',
    subLang: 'pt-BR,pt,por,pob,ptb',
    autoNext: true,
    volume: 100,
    skipSeconds: 10,
    scaler: 'ewa_lanczossharp',
  },
  video: { ...DEFAULT_VIDEO },
  videoProfiles: {},
  torrent: {
    url: 'http://127.0.0.1:8080',
    username: '',
    password: '',
    autoStart: true,
    downloadDir: '',
    sequential: true,
    exePath: '',
    onlyOurs: false,
  },
  prowlarr: { url: 'http://127.0.0.1:9696', apiKey: '' },
  sources: {
    adblock: true,
    sites: [],
  },
  ui: { heroAutoplay: true },
};

// Mescla profunda apenas para objetos simples (arrays são substituídos).
function deepMerge(target, patch) {
  if (!patch || typeof patch !== 'object') return target;
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

module.exports = { DEFAULT_SETTINGS, deepMerge };
