'use strict';
// Busca opcional em indexadores via Prowlarr (API v1) ou Jackett (Torznab simplificado).

async function prowlarrSearch(cfg, query) {
  const base = String(cfg.url || '').replace(/\/+$/, '');
  if (!base || !cfg.apiKey) throw new Error('Configure o endereço e a chave de API do Prowlarr em Configurações.');
  const url = `${base}/api/v1/search?query=${encodeURIComponent(query)}&type=search&limit=100`;
  let res;
  try {
    res = await fetch(url, { headers: { 'X-Api-Key': cfg.apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
  } catch (_) {
    throw new Error('Prowlarr não está acessível em ' + base);
  }
  if (res.status === 401) throw new Error('Chave de API do Prowlarr inválida.');
  if (!res.ok) throw new Error('Prowlarr respondeu ' + res.status);
  const arr = await res.json();
  return arr
    .map((r) => ({
      title: r.title,
      size: r.size || 0,
      seeders: r.seeders ?? null,
      leechers: r.leechers ?? null,
      indexer: r.indexer || '',
      date: r.publishDate || null,
      magnet: r.magnetUrl && /^magnet:/i.test(r.magnetUrl) ? r.magnetUrl : null,
      link: r.magnetUrl || r.downloadUrl || null,
      infoUrl: r.infoUrl || r.guid || null,
    }))
    .filter((r) => r.link)
    .sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
}

async function prowlarrTest(cfg) {
  const base = String(cfg.url || '').replace(/\/+$/, '');
  const res = await fetch(`${base}/api/v1/system/status`, { headers: { 'X-Api-Key': cfg.apiKey || '' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('Prowlarr respondeu ' + res.status);
  const j = await res.json();
  return { ok: true, version: j.version };
}

module.exports = { prowlarrSearch, prowlarrTest };
