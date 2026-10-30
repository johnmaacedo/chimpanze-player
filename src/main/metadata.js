'use strict';
// Busca de metadados (capas, fundos, sinopses, episódios).
// Provedores: IMDb (principal, pt-BR), TMDB (opcional, com chave), AniList (anime), TVmaze (séries) e iTunes (filmes).
const { normalizeTitle } = require('./parser');

const UA = 'ChimpanzePlayer/1.0 (+local media player)';

// ---------- utilidades HTTP com fila, timeout e retry ----------
const hostState = new Map(); // host -> { last, gap }
const HOST_GAP = {
  'api.tvmaze.com': 550,
  'graphql.anilist.co': 900,
  'itunes.apple.com': 400,
  'api.themoviedb.org': 60,
  'caching.graphql.imdb.com': 120,
  'translate.googleapis.com': 300,
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function throttle(host) {
  const gap = HOST_GAP[host] || 100;
  const st = hostState.get(host) || { next: 0 };
  const now = Date.now();
  const wait = Math.max(0, st.next - now);
  st.next = Math.max(now, st.next) + gap;
  hostState.set(host, st);
  if (wait) await sleep(wait);
}

async function httpJson(url, opts = {}, attempt = 0) {
  const host = new URL(url).host;
  await throttle(host);
  let res;
  try {
    res = await fetch(url, {
      ...opts,
      headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    if (attempt < 2) { await sleep(800 * (attempt + 1)); return httpJson(url, opts, attempt + 1); }
    throw err;
  }
  if (res.status === 429 && attempt < 4) {
    const ra = Number(res.headers.get('retry-after')) || 2 + attempt * 2;
    await sleep(Math.min(ra, 30) * 1000);
    return httpJson(url, opts, attempt + 1);
  }
  if (res.status >= 500 && attempt < 2) { await sleep(1000); return httpJson(url, opts, attempt + 1); }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${host}`);
  return res.json();
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\(Source:[^)]*\)/gi, '')
    .replace(/\[Written by[^\]]*\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Similaridade simples entre títulos (0..1) usando bigramas.
function similarity(a, b) {
  a = normalizeTitle(a); b = normalizeTitle(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (s) => { const g = new Map(); const t = ` ${s} `; for (let i = 0; i < t.length - 1; i++) { const k = t.slice(i, i + 2); g.set(k, (g.get(k) || 0) + 1); } return g; };
  const ga = grams(a), gb = grams(b);
  let inter = 0, total = 0;
  for (const [k, v] of ga) { inter += Math.min(v, gb.get(k) || 0); total += v; }
  for (const v of gb.values()) total += v;
  let score = (2 * inter) / total;
  if (a.startsWith(b) || b.startsWith(a)) score = Math.max(score, 0.85);
  return score;
}

function pickBest(candidates, title, year, getTitles, getYear) {
  let best = null, bestScore = 0;
  for (const c of candidates) {
    const titles = getTitles(c).filter(Boolean);
    let s = Math.max(0, ...titles.map((t) => similarity(t, title)));
    const cy = getYear(c);
    // Ano muito diferente quase sempre é outro título (ex.: Supergirl 2026 x anime de 2021).
    if (year && cy) s += cy === year ? 0.25 : (Math.abs(cy - year) <= 1 ? 0.1 : (Math.abs(cy - year) <= 3 ? -0.2 : -0.6));
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return bestScore >= 0.55 ? best : null;
}

// ---------- TMDB ----------
function tmdbFetch(key, pathAndQuery, lang) {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const bearer = key && key.length > 40;
  let url = `https://api.themoviedb.org/3${pathAndQuery}${sep}language=${encodeURIComponent(lang || 'pt-BR')}`;
  const headers = {};
  if (bearer) headers.Authorization = `Bearer ${key}`;
  else url += `&api_key=${encodeURIComponent(key)}`;
  return httpJson(url, { headers });
}
const TMDB_IMG = 'https://image.tmdb.org/t/p/';

function tmdbPickLogo(images) {
  const logos = (images && images.logos) || [];
  const pref = ['pt', 'en', null];
  for (const l of pref) {
    const found = logos.filter((x) => (x.iso_639_1 || null) === l && !String(x.file_path).endsWith('.svg'));
    if (found.length) return TMDB_IMG + 'w500' + found[0].file_path;
  }
  return null;
}

async function tmdbSearch(key, lang, kind, title, year) {
  const isMovie = kind === 'movie';
  const q = encodeURIComponent(title);
  const yearParam = year ? (isMovie ? `&year=${year}` : `&first_air_date_year=${year}`) : '';
  let data = await tmdbFetch(key, `/search/${isMovie ? 'movie' : 'tv'}?query=${q}${yearParam}&include_adult=false`, lang);
  let results = (data && data.results) || [];
  if (!results.length && year) {
    data = await tmdbFetch(key, `/search/${isMovie ? 'movie' : 'tv'}?query=${q}&include_adult=false`, lang);
    results = (data && data.results) || [];
  }
  return results.map((r) => ({
    provider: 'tmdb',
    id: r.id,
    kind: isMovie ? 'movie' : 'tv',
    title: isMovie ? r.title : r.name,
    originalTitle: isMovie ? r.original_title : r.original_name,
    year: Number(String(isMovie ? r.release_date : r.first_air_date || '').slice(0, 4)) || null,
    poster: r.poster_path ? TMDB_IMG + 'w500' + r.poster_path : null,
    overview: r.overview || '',
    popularity: r.popularity || 0,
    raw: r,
  }));
}

async function tmdbDetails(key, lang, cand) {
  const isMovie = cand.kind === 'movie';
  const d = await tmdbFetch(key, `/${isMovie ? 'movie' : 'tv'}/${cand.id}?append_to_response=images&include_image_language=pt,en,null`, lang);
  if (!d) return null;
  const genres = (d.genres || []).map((g) => g.name);
  const isAnime = (d.genres || []).some((g) => g.id === 16) && ((d.original_language === 'ja') || (d.origin_country || []).includes('JP'));
  let overview = d.overview;
  if (!overview && lang !== 'en-US') {
    const en = await tmdbFetch(key, `/${isMovie ? 'movie' : 'tv'}/${cand.id}`, 'en-US');
    if (en) overview = en.overview;
  }
  return {
    provider: 'tmdb',
    providerId: String(d.id),
    title: isMovie ? d.title : d.name,
    originalTitle: isMovie ? d.original_title : d.original_name,
    year: Number(String(isMovie ? d.release_date : d.first_air_date || '').slice(0, 4)) || null,
    overview: overview || '',
    poster: d.poster_path ? TMDB_IMG + 'w500' + d.poster_path : null,
    backdrop: d.backdrop_path ? TMDB_IMG + 'w1280' + d.backdrop_path : null,
    logo: tmdbPickLogo(d.images),
    genres,
    rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
    runtime: isMovie ? d.runtime : ((d.episode_run_time || [])[0] || null),
    isAnime,
    seasonsInfo: isMovie ? null : (d.seasons || []).map((s) => ({ season: s.season_number, name: s.name, episodes: s.episode_count, poster: s.poster_path ? TMDB_IMG + 'w342' + s.poster_path : null })),
  };
}

async function tmdbEpisodes(key, lang, providerId, seasons) {
  const out = {};
  for (const sn of seasons) {
    const d = await tmdbFetch(key, `/tv/${providerId}/season/${sn}`, lang);
    if (!d || !d.episodes) continue;
    for (const e of d.episodes) {
      out[`${sn}x${e.episode_number}`] = {
        title: e.name || '',
        overview: e.overview || '',
        still: e.still_path ? TMDB_IMG + 'w400' + e.still_path : null,
        runtime: e.runtime || null,
        airDate: e.air_date || null,
      };
    }
  }
  return out;
}

// ---------- AniList ----------
const ANILIST_QUERY = `query ($search: String, $id: Int) {
  Page(perPage: 8) {
    media(search: $search, id: $id, type: ANIME, sort: [SEARCH_MATCH, POPULARITY_DESC]) {
      id format episodes seasonYear startDate { year }
      title { romaji english native userPreferred }
      synonyms
      description(asHtml: false)
      coverImage { extraLarge large color }
      bannerImage
      genres averageScore duration
      streamingEpisodes { title thumbnail }
    }
  }
}`;

async function anilistQuery(variables) {
  const d = await httpJson('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: ANILIST_QUERY, variables }),
  });
  return (d && d.data && d.data.Page && d.data.Page.media) || [];
}

function anilistToCandidate(m) {
  return {
    provider: 'anilist', id: m.id, kind: m.format === 'MOVIE' ? 'movie' : 'tv',
    title: m.title.english || m.title.romaji || m.title.userPreferred,
    originalTitle: m.title.native || m.title.romaji,
    altTitles: [m.title.romaji, m.title.english, m.title.userPreferred, ...(m.synonyms || [])],
    year: m.seasonYear || (m.startDate && m.startDate.year) || null,
    poster: m.coverImage && (m.coverImage.extraLarge || m.coverImage.large),
    overview: stripHtml(m.description),
    raw: m,
  };
}

async function anilistSearch(title) {
  const media = await anilistQuery({ search: title });
  return media.map(anilistToCandidate);
}

function anilistDetails(cand) {
  const m = cand.raw;
  const eps = {};
  (m.streamingEpisodes || []).forEach((se, idx) => {
    const mm = String(se.title || '').match(/(?:Episode|Ep\.?|Epis[oó]dio)\s*(\d+)\s*[-–:]?\s*(.*)$/i);
    const n = mm ? Number(mm[1]) : idx + 1;
    eps[`1x${n}`] = { title: mm ? mm[2] : (se.title || ''), overview: '', still: se.thumbnail || null };
  });
  return {
    provider: 'anilist',
    providerId: String(m.id),
    title: m.title.english || m.title.romaji,
    originalTitle: m.title.native || m.title.romaji,
    year: cand.year,
    overview: stripHtml(m.description),
    poster: m.coverImage && (m.coverImage.extraLarge || m.coverImage.large),
    backdrop: m.bannerImage || null,
    logo: null,
    genres: m.genres || [],
    rating: m.averageScore ? Math.round(m.averageScore) / 10 : null,
    runtime: m.duration || null,
    isAnime: true,
    color: m.coverImage && m.coverImage.color,
    episodesMeta: eps,
    totalEpisodes: m.episodes || null,
  };
}

// ---------- TVmaze ----------
async function tvmazeSearch(title) {
  const d = await httpJson(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(title)}`);
  return (d || []).map((r) => ({
    provider: 'tvmaze', id: r.show.id, kind: 'tv',
    title: r.show.name,
    year: Number(String(r.show.premiered || '').slice(0, 4)) || null,
    poster: r.show.image ? (r.show.image.original || r.show.image.medium) : null,
    overview: stripHtml(r.show.summary),
    raw: r.show,
  }));
}

async function tvmazeDetails(cand) {
  const s = cand.raw;
  let backdrop = null, logo = null;
  try {
    const imgs = await httpJson(`https://api.tvmaze.com/shows/${s.id}/images`);
    const pick = (type) => {
      const list = (imgs || []).filter((i) => i.type === type);
      const main = list.find((i) => i.main) || list[0];
      if (!main) return null;
      const r = main.resolutions || {};
      return (r.original && r.original.url) || (r.medium && r.medium.url) || null;
    };
    backdrop = pick('background') || pick('banner');
    logo = null; // "typography" do TVmaze nem sempre tem fundo transparente
  } catch (_) { /* opcional */ }
  const eps = {};
  try {
    const list = await httpJson(`https://api.tvmaze.com/shows/${s.id}/episodes?specials=1`);
    for (const e of list || []) {
      const num = e.number == null ? null : e.number;
      if (num == null) continue;
      eps[`${e.season}x${num}`] = {
        title: e.name || '',
        overview: stripHtml(e.summary),
        still: e.image ? (e.image.original || e.image.medium) : null,
        runtime: e.runtime || null,
        airDate: e.airdate || null,
      };
    }
  } catch (_) { /* opcional */ }
  const genres = s.genres || [];
  const isAnime = genres.includes('Anime') || (s.language === 'Japanese' && genres.includes('Anime'));
  return {
    provider: 'tvmaze',
    providerId: String(s.id),
    title: s.name,
    originalTitle: s.name,
    year: cand.year,
    overview: stripHtml(s.summary),
    poster: s.image ? (s.image.original || s.image.medium) : null,
    backdrop,
    logo,
    genres,
    rating: s.rating && s.rating.average ? s.rating.average : null,
    runtime: s.runtime || s.averageRuntime || null,
    isAnime,
    episodesMeta: eps,
  };
}

// ---------- iTunes (filmes) ----------
function itunesArt(url, w, h) {
  if (!url) return null;
  return url.replace(/\/\d+x\d+(bb)?(-\d+)?\.(jpg|png|webp)$/i, `/${w}x${h}bb.jpg`);
}

async function itunesSearch(title) {
  const run = async (country, lang) => {
    const d = await httpJson(`https://itunes.apple.com/search?term=${encodeURIComponent(title)}&media=movie&entity=movie&limit=15&country=${country}${lang ? '&lang=' + lang : ''}`);
    return (d && d.results) || [];
  };
  let results = await run('BR', 'pt_br');
  if (!results.length) results = await run('US', '');
  return results.map((r) => ({
    provider: 'itunes', id: r.trackId, kind: 'movie',
    title: r.trackName,
    year: Number(String(r.releaseDate || '').slice(0, 4)) || null,
    poster: itunesArt(r.artworkUrl100, 600, 900),
    overview: r.longDescription || r.shortDescription || '',
    raw: r,
  }));
}

function itunesDetails(cand) {
  const r = cand.raw;
  return {
    provider: 'itunes',
    providerId: String(r.trackId),
    title: r.trackName,
    originalTitle: r.trackName,
    year: cand.year,
    overview: r.longDescription || r.shortDescription || '',
    poster: itunesArt(r.artworkUrl100, 600, 900),
    backdrop: null,
    logo: null,
    genres: r.primaryGenreName ? [r.primaryGenreName] : [],
    rating: null,
    runtime: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 60000) : null,
    isAnime: false,
    contentRating: r.contentAdvisoryRating || null,
  };
}


// ---------- IMDb (principal: título e sinopse em pt-BR, capa e fundo) ----------
const IMDB_GQL = 'https://caching.graphql.imdb.com/';
const IMDB_HEADERS = {
  'Content-Type': 'application/json',
  'x-imdb-user-country': 'BR',
  'x-imdb-user-language': 'pt-BR',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
};

async function imdbQuery(query, variables) {
  const d = await httpJson(IMDB_GQL, { method: 'POST', headers: IMDB_HEADERS, body: JSON.stringify({ query, variables }) });
  if (d && d.errors && !d.data) throw new Error('IMDb: ' + (d.errors[0] && d.errors[0].message));
  return d && d.data;
}

// Redimensiona imagens do IMDb (CDN da Amazon) pela URL.
function imdbImg(url, width) {
  if (!url) return null;
  return url.replace(/\._V1_.*?\.(jpg|png|webp)$/i, `._V1_QL85_UX${width}_.$1`);
}

const IMDB_SEARCH = `query($t:String!){ mainSearch(first:12, options:{searchTerm:$t, type:TITLE, includeAdult:false}){ edges{ node{ entity{ ... on Title {
  id titleText{text} originalTitleText{text} releaseYear{year} titleType{id isSeries} primaryImage{url} plot{plotText{plainText}}
} } } } } }`;

async function imdbSearch(title) {
  const d = await imdbQuery(IMDB_SEARCH, { t: title });
  const edges = (d && d.mainSearch && d.mainSearch.edges) || [];
  return edges.map((e) => e.node && e.node.entity).filter((t) => t && t.id).map((t) => ({
    provider: 'imdb', id: t.id,
    kind: t.titleType && t.titleType.isSeries ? 'tv' : 'movie',
    typeId: t.titleType && t.titleType.id,
    title: t.titleText && t.titleText.text,
    originalTitle: t.originalTitleText && t.originalTitleText.text,
    year: (t.releaseYear && t.releaseYear.year) || null,
    poster: imdbImg(t.primaryImage && t.primaryImage.url, 600),
    overview: (t.plot && t.plot.plotText && t.plot.plotText.plainText) || '',
  }));
}

const IMDB_DETAILS = `query($id:ID!){ title(id:$id){
  id titleText{text} originalTitleText{text} releaseYear{year} titleType{id isSeries}
  plot{plotText{plainText} language{id}}
  plots(first:6){edges{node{plotText{plainText} language{id}}}}
  genres{genres{text}} ratingsSummary{aggregateRating} runtime{seconds}
  countriesOfOrigin{countries{id}}
  primaryImage{url width height}
  images(first:40){edges{node{url width height type}}}
  episodes{ seasons{number} }
} }`;

const IMDB_EPISODES = `query($id:ID!, $s:String!){ title(id:$id){ episodes{ episodes(first:250, filter:{includeSeasons:[$s]}){ edges{ node{
  titleText{text} plot{plotText{plainText}} primaryImage{url} runtime{seconds} releaseDate{year month day}
  series{displayableEpisodeNumber{displayableSeason{text} episodeNumber{text}}}
} } } } } }`;

async function translatePt(text) {
  if (!text) return text;
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=pt-BR&dt=t&q=${encodeURIComponent(text.slice(0, 4500))}`;
    const d = await httpJson(url);
    const out = (d && d[0] || []).map((x) => x && x[0]).filter(Boolean).join('');
    return out || text;
  } catch (_) { return text; }
}

function pickBackdrop(images) {
  const list = ((images && images.edges) || []).map((e) => e.node).filter((n) => n && n.url && n.width && n.height);
  const wide = list.filter((n) => n.width / n.height >= 1.5 && n.width >= 1200);
  const pref = wide.filter((n) => n.type === 'still_frame');
  const pick = (pref.length ? pref : wide).sort((a, b) => b.width - a.width)[0];
  return pick ? imdbImg(pick.url, 1920) : null;
}

async function imdbDetails(id) {
  const d = await imdbQuery(IMDB_DETAILS, { id });
  const t = d && d.title;
  if (!t) return null;
  let overview = t.plot && t.plot.plotText && t.plot.plotText.plainText || '';
  const lang = t.plot && t.plot.language && t.plot.language.id || '';
  if (!/^pt/i.test(lang)) {
    // Prefere uma sinopse em português; se não houver, traduz a mais completa curta.
    const plots = ((t.plots && t.plots.edges) || []).map((e) => e.node).filter(Boolean);
    const pt = plots.find((p) => /^pt/i.test(p.language && p.language.id || ''));
    if (pt) overview = pt.plotText.plainText;
    else if (overview) overview = await translatePt(overview);
  }
  const genres = ((t.genres && t.genres.genres) || []).map((g) => g.text);
  const countries = ((t.countriesOfOrigin && t.countriesOfOrigin.countries) || []).map((c) => c.id);
  const isSeries = !!(t.titleType && t.titleType.isSeries);
  const isAnime = genres.some((g) => /anima/i.test(g)) && countries.includes('JP');
  const seasons = ((t.episodes && t.episodes.seasons) || []).map((s) => Number(s.number)).filter((n) => Number.isFinite(n));
  return {
    provider: 'imdb',
    providerId: t.id,
    imdbId: t.id,
    title: t.titleText && t.titleText.text,
    originalTitle: t.originalTitleText && t.originalTitleText.text,
    year: (t.releaseYear && t.releaseYear.year) || null,
    overview,
    poster: imdbImg(t.primaryImage && t.primaryImage.url, 600),
    backdrop: pickBackdrop(t.images),
    logo: null,
    genres,
    rating: t.ratingsSummary && t.ratingsSummary.aggregateRating || null,
    runtime: t.runtime && t.runtime.seconds ? Math.round(t.runtime.seconds / 60) : null,
    isAnime,
    seasonsInfo: isSeries ? seasons.map((n) => ({ season: n, name: `Temporada ${n}`, episodes: null, poster: null })) : null,
  };
}

async function imdbEpisodes(id, seasons) {
  const out = {};
  for (const sn of seasons) {
    try {
      const d = await imdbQuery(IMDB_EPISODES, { id, s: String(sn) });
      const edges = (d && d.title && d.title.episodes && d.title.episodes.episodes && d.title.episodes.episodes.edges) || [];
      for (const { node: e } of edges) {
        const num = e && e.series && e.series.displayableEpisodeNumber;
        const s = Number(num && num.displayableSeason && num.displayableSeason.text);
        const n = Number(num && num.episodeNumber && num.episodeNumber.text);
        if (!Number.isFinite(s) || !Number.isFinite(n) || n <= 0) continue;
        const rd = e.releaseDate;
        out[`${s}x${n}`] = {
          title: (e.titleText && e.titleText.text) || '',
          overview: (e.plot && e.plot.plotText && e.plot.plotText.plainText) || '',
          still: imdbImg(e.primaryImage && e.primaryImage.url, 640),
          runtime: e.runtime && e.runtime.seconds ? Math.round(e.runtime.seconds / 60) : null,
          airDate: rd && rd.year ? `${rd.year}-${String(rd.month || 1).padStart(2, '0')}-${String(rd.day || 1).padStart(2, '0')}` : null,
        };
      }
    } catch (_) { /* temporada opcional */ }
  }
  return out;
}

async function imdbIdentify({ title, year, kind }) {
  const cands = await imdbSearch(title);
  const want = cands.filter((c) => (kind === 'movie' ? c.kind === 'movie' && c.typeId !== 'tvEpisode' : c.kind === 'tv'));
  const best = pickBest(want.length ? want : cands, title, year, (c) => [c.title, c.originalTitle], (c) => c.year);
  if (!best) return null;
  return best;
}

// ---------- Orquestração ----------
class MetadataService {
  constructor(getSettings) {
    this.getSettings = getSettings;
  }

  _tmdb() {
    const s = this.getSettings();
    const key = (s.metadata && s.metadata.tmdbKey || '').trim();
    return key ? { key, lang: (s.metadata && s.metadata.language) || 'pt-BR' } : null;
  }

  /**
   * Identifica uma mídia. kind: 'movie' | 'tv'; animeHint: boolean.
   * Retorna { meta, episodes } ou null.
   */
  async identify({ title, year, kind, animeHint, seasons = [1] }) {
    const tmdb = this._tmdb();
    const errors = [];
    try {
      const best = await imdbIdentify({ title, year, kind });
      if (best) {
        const meta = await imdbDetails(best.id);
        if (meta && (meta.poster || meta.overview)) {
          const eps = meta.seasonsInfo && seasons.length ? await imdbEpisodes(meta.providerId, seasons) : {};
          return { meta, episodes: eps };
        }
      }
    } catch (e) { errors.push(e); }
    if (tmdb) {
      try {
        const cands = await tmdbSearch(tmdb.key, tmdb.lang, kind, title, year);
        const best = pickBest(cands, title, year, (c) => [c.title, c.originalTitle], (c) => c.year);
        if (best) {
          const meta = await tmdbDetails(tmdb.key, tmdb.lang, best);
          if (meta) {
            let episodes = {};
            if (kind === 'tv') episodes = await tmdbEpisodes(tmdb.key, tmdb.lang, meta.providerId, seasons).catch(() => ({}));
            return { meta, episodes };
          }
        }
      } catch (e) { errors.push(e); }
    }
    const order = kind === 'movie'
      ? (animeHint ? ['anilist', 'itunes'] : ['itunes', 'anilist'])
      : (animeHint ? ['anilist', 'tvmaze'] : ['tvmaze', 'anilist']);
    for (const p of order) {
      try {
        const r = await this._identifyWith(p, { title, year, kind });
        if (r) return r;
      } catch (e) { errors.push(e); }
    }
    if (errors.length && errors.every((e) => /fetch|network|timeout|abort|ENOTFOUND|ECONN/i.test(String(e && (e.message || e))))) {
      const err = new Error('offline');
      err.offline = true;
      throw err;
    }
    return null;
  }

  async _identifyWith(provider, { title, year, kind }) {
    if (provider === 'anilist') {
      const cands = await anilistSearch(title);
      const filtered = cands.filter((c) => (kind === 'movie' ? c.kind === 'movie' : c.kind !== 'movie'));
      const best = pickBest(filtered.length ? filtered : cands, title, year, (c) => c.altTitles, (c) => c.year);
      if (!best) return null;
      const meta = anilistDetails(best);
      return { meta, episodes: meta.episodesMeta || {} };
    }
    if (provider === 'tvmaze') {
      const cands = await tvmazeSearch(title);
      const best = pickBest(cands, title, year, (c) => [c.title], (c) => c.year);
      if (!best) return null;
      const meta = await tvmazeDetails(best);
      return { meta, episodes: meta.episodesMeta || {} };
    }
    if (provider === 'itunes') {
      const cands = await itunesSearch(title);
      const best = pickBest(cands, title, year, (c) => [c.title], (c) => c.year);
      if (!best) return null;
      return { meta: itunesDetails(best), episodes: {} };
    }
    return null;
  }

  // Busca manual (tela "Corrigir identificação").
  async searchCandidates(query, kind) {
    const tmdb = this._tmdb();
    const out = [];
    const tasks = [];
    tasks.push(imdbSearch(query).then((l) => {
      const want = l.filter((c) => (kind === 'movie' ? c.kind === 'movie' : c.kind === 'tv'));
      return want.length ? want : l;
    }).catch(() => []));
    if (tmdb) tasks.push(tmdbSearch(tmdb.key, tmdb.lang, kind, query).catch(() => []));
    if (kind === 'movie') tasks.push(itunesSearch(query).catch(() => []));
    else tasks.push(tvmazeSearch(query).catch(() => []));
    tasks.push(anilistSearch(query).catch(() => []));
    const lists = await Promise.all(tasks);
    for (const l of lists) for (const c of l.slice(0, 8)) {
      out.push({ provider: c.provider, id: c.id, kind: c.kind, title: c.title, year: c.year, poster: c.poster, overview: (c.overview || '').slice(0, 300) });
    }
    return out;
  }

  // Aplica uma escolha manual (provider + id).
  async fetchById(provider, id, kind, seasons = [1]) {
    if (provider === 'imdb') {
      const meta = await imdbDetails(String(id));
      if (!meta) return null;
      const episodes = meta.seasonsInfo && seasons.length ? await imdbEpisodes(meta.providerId, seasons) : {};
      return { meta, episodes };
    }
    if (provider === 'tmdb') {
      const tmdb = this._tmdb();
      if (!tmdb) throw new Error('Chave do TMDB não configurada.');
      const meta = await tmdbDetails(tmdb.key, tmdb.lang, { id, kind });
      if (!meta) return null;
      const episodes = kind === 'movie' ? {} : await tmdbEpisodes(tmdb.key, tmdb.lang, meta.providerId, seasons).catch(() => ({}));
      return { meta, episodes };
    }
    if (provider === 'anilist') {
      const media = await anilistQuery({ id: Number(id) });
      if (!media[0]) return null;
      const meta = anilistDetails(anilistToCandidate(media[0]));
      return { meta, episodes: meta.episodesMeta || {} };
    }
    if (provider === 'tvmaze') {
      const show = await httpJson(`https://api.tvmaze.com/shows/${id}`);
      if (!show) return null;
      const meta = await tvmazeDetails({ raw: show, year: Number(String(show.premiered || '').slice(0, 4)) || null });
      return { meta, episodes: meta.episodesMeta || {} };
    }
    if (provider === 'itunes') {
      const d = await httpJson(`https://itunes.apple.com/lookup?id=${id}&country=BR&lang=pt_br`);
      const r = d && d.results && d.results[0];
      if (!r) return null;
      return { meta: itunesDetails({ raw: r, year: Number(String(r.releaseDate || '').slice(0, 4)) || null }), episodes: {} };
    }
    return null;
  }
}

module.exports = { MetadataService, similarity, pickBest, stripHtml, itunesArt, httpJson };
