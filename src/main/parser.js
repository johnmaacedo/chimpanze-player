'use strict';
// Interpretação de nomes de arquivos de vídeo (filmes, séries e animes).
// Inspirado no guessit, cobrindo os padrões mais comuns de lançamentos.

const VIDEO_EXT = new Set(['mkv', 'mp4', 'avi', 'm4v', 'mov', 'wmv', 'webm', 'ts', 'm2ts', 'mts', 'flv', 'mpg', 'mpeg', 'vob', '3gp', 'ogv', 'rmvb', 'divx', 'f4v']);

// Termos que marcam o fim do título (qualidade, codecs, grupos etc.).
const STOP_WORDS = [
  '2160p', '1080p', '1080i', '720p', '576p', '480p', '360p', '4k', 'uhd', 'fhd', 'hd', 'sd',
  'x264', 'x265', 'h264', 'h 264', 'h265', 'h 265', 'hevc', 'avc', 'av1', 'xvid', 'divx', 'vp9',
  'bluray', 'blu ray', 'bdrip', 'brrip', 'bdremux', 'remux', 'web', 'webdl', 'web dl', 'webrip', 'hdrip', 'dvdrip', 'dvd', 'hdtv', 'pdtv', 'hdcam', 'cam', 'ts', 'telesync',
  'dual', 'dual audio', 'dublado', 'legendado', 'leg', 'nacional', 'dub', 'sub', 'subbed', 'dubbed', 'multi', 'multisub',
  'aac', 'aac2', 'ac3', 'eac3', 'ddp', 'ddp5', 'dd5', 'dts', 'dtshd', 'truehd', 'atmos', 'flac', 'opus', 'mp3',
  'hdr', 'hdr10', 'dv', 'dolby vision', 'sdr', '10bit', '10 bit', '8bit', 'hi10p',
  'proper', 'repack', 'extended', 'unrated', 'remastered', 'directors cut', 'imax', 'complete', 'completo', 'internal', 'limited',
  'amzn', 'nf', 'dsnp', 'hmax', 'max', 'atvp', 'pcok', 'hulu', 'cr', 'crunchyroll', 'funi', 'globoplay'
];
const STOP_RE = new RegExp('(?:^|\\s)(' + STOP_WORDS.map(escapeRe).sort((a, b) => b.length - a.length).join('|') + ')(?=\\s|$)', 'i');

const ANIME_HINT_DIRS = /(^|[\s_\-])(animes?|anime series)([\s_\-]|$)/i;
const SEASON_DIR_RE = /^(?:season|temporada|temp|staffel|saison|s)[\s._-]*(\d{1,2})$/i;
const SPECIALS_DIR_RE = /^(specials?|especiais?|extras?|ova|ovas|featurettes?|bonus)$/i;
const SKIP_DIR_RE = /^(sample|samples|extras|featurettes|behind the scenes|deleted scenes|trailers?|\$recycle\.bin|system volume information|\.trash.*|@eadir)$/i;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

function isVideoFile(name) {
  return VIDEO_EXT.has(extOf(name));
}

function stripExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 && VIDEO_EXT.has(name.slice(i + 1).toLowerCase()) ? name.slice(0, i) : name;
}

// Normaliza para comparação/agrupamento.
function normalizeTitle(t) {
  return String(t || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|o|os|as)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanSeparators(s) {
  return s
    .replace(/[._]+/g, ' ')
    .replace(/\s+-\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tidyTitle(t) {
  t = cleanSeparators(t)
    .replace(/[\s\-–—:,;]+$/, '')
    .replace(/^[\s\-–—:,;]+/, '')
    .trim();
  // Remove palavras de qualidade remanescentes no final.
  const m = STOP_RE.exec(' ' + t + ' ');
  if (m && m.index > 0) t = t.slice(0, m.index).trim();
  t = t.replace(/[\s\-–—:,;(]+$/, '').trim();
  // Título totalmente minúsculo ou com pontos -> Title Case suave.
  if (t && t === t.toLowerCase()) {
    t = t.replace(/\b([a-zà-ú])/g, (c) => c.toUpperCase());
  }
  return t;
}

function cleanFolderName(name) {
  let s = String(name || '');
  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/\{[^}]*\}/g, ' ');
  let year = null;
  const ym = s.match(/\((19\d{2}|20\d{2})\)/);
  if (ym) year = Number(ym[1]);
  s = s.replace(/\([^)]*\)/g, ' ');
  s = cleanSeparators(s);
  // Remove marcações de temporada/qualidade do nome da pasta.
  s = s.replace(/\b(?:S\d{1,2}(?:\s*-\s*S?\d{1,2})?|Season\s*\d+(?:\s*-\s*\d+)?|Temporada\s*\d+|Seasons?\s*\d+\s*-\s*\d+)\b.*$/i, '').trim();
  const yr = s.match(/\b(19\d{2}|20\d{2})\b/);
  if (yr && yr.index > 0) {
    if (!year) year = Number(yr[1]);
    s = s.slice(0, yr.index);
  }
  return { title: tidyTitle(s), year };
}

/**
 * Analisa um arquivo de vídeo.
 * @param {string} fileName nome do arquivo (com extensão)
 * @param {string[]} dirParts pastas entre a raiz da biblioteca e o arquivo
 */
function parseMediaName(fileName, dirParts = []) {
  const base = stripExt(fileName);
  const result = {
    title: '', year: null, season: null, episode: null, episodeEnd: null,
    type: 'movie', animeHint: false, special: false, absolute: false,
  };

  // Dicas a partir das pastas.
  const dirs = dirParts.filter(Boolean);
  if (dirs.some((d) => ANIME_HINT_DIRS.test(d))) result.animeHint = true;
  let dirSeason = null;
  for (const d of dirs) {
    const m = d.trim().match(SEASON_DIR_RE);
    if (m) dirSeason = Number(m[1]);
    if (SPECIALS_DIR_RE.test(d.trim())) { dirSeason = 0; result.special = true; }
  }

  let s = base;
  // Grupo no início: [SubsPlease] Nome - 01 -> forte indício de anime.
  if (/^\s*\[[^\]]+\]/.test(s)) result.animeHint = true;
  // Hash CRC [ABCD1234] também é típico de anime.
  if (/\[[0-9A-F]{8}\]/i.test(s)) result.animeHint = true;

  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/\{[^}]*\}/g, ' ');
  // Ano entre parênteses.
  const yParen = s.match(/\((19\d{2}|20\d{2})\)/);
  if (yParen) result.year = Number(yParen[1]);
  s = s.replace(/\(([^)]*)\)/g, (all, inner) => (/^(19|20)\d{2}$/.test(inner.trim()) ? ' ' + inner.trim() + ' ' : ' '));
  const work = s.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();

  const patterns = [
    // S01E02, S01E02-E03, S01E02E03, S01 E02, S1.E2
    { re: /\bS(\d{1,2})\s*[-.]?\s*E(\d{1,4})(?:\s*-?\s*E?(\d{1,4}))?\b/i, kind: 'se' },
    // 1x02
    { re: /\b(\d{1,2})x(\d{2,3})\b/i, kind: 'se' },
    // Temporada 1 Episódio 2 / Season 1 Episode 2
    { re: /\b(?:season|temporada)\s*(\d{1,2})\s*[-,]?\s*(?:episode|epis[oó]dio|ep)\s*(\d{1,4})\b/i, kind: 'se' },
    // Episódio 5 / Episode 05 / Ep 05 / EP05 / E05
    { re: /(?:^|\s)(?:(?:episode|epis[oó]dio|ep\.?)\s*|e)(\d{1,4})(?:v\d)?\b/i, kind: 'e' },
    // Anime: "Nome - 05", "Nome - 05v2", "Nome - 1001"
    { re: /\s[-–]\s(\d{1,4})(?:v\d)?(?=\s|$)/i, kind: 'abs' },
    // Arquivo nomeado só com o número: "03.mkv"
    { re: /^(\d{1,4})(?:v\d)?$/i, kind: 'bare' },
    // "Nome 05" no final (apenas quando há pasta da série ou indício de anime)
    { re: /\s(\d{1,3})(?:v\d)?$/i, kind: 'tail' },
  ];

  let match = null;
  for (const p of patterns) {
    const m = work.match(p.re);
    if (!m) continue;
    if (p.kind === 'tail') {
      const n = Number(m[1]);
      const looksYear = n >= 1900;
      if (looksYear) continue;
      if (!(result.animeHint || dirSeason !== null)) {
        // Só considera "Nome 05" como episódio se estiver dentro da pasta da própria série.
        const sd = pickShowDir(dirs);
        const before = tidyTitle(work.slice(0, m.index));
        if (!sd || !before || normalizeTitle(cleanFolderName(sd).title) !== normalizeTitle(before)) continue;
      }
    }
    if (p.kind === 'bare') {
      const n = Number(m[1]);
      if (n >= 1900 && n <= 2100) continue;
      if (dirSeason === null && !pickShowDir(dirs)) continue;
    }
    if (p.kind === 'abs') {
      const n = Number(m[1]);
      if (n >= 1900 && n <= 2100) continue; // provavelmente um ano
    }
    match = { m, kind: p.kind };
    break;
  }

  if (match) {
    const { m, kind } = match;
    result.type = 'episode';
    if (kind === 'se') {
      result.season = Number(m[1]);
      result.episode = Number(m[2]);
      if (m[3]) {
        const end = Number(m[3]);
        if (end > result.episode && end - result.episode < 10) result.episodeEnd = end;
      }
    } else {
      result.episode = Number(m[1]);
      result.season = dirSeason !== null ? dirSeason : 1;
      if (kind === 'abs' || kind === 'tail') result.absolute = dirSeason === null;
      // Anime com "S2 - 05" no nome
      const sm = work.slice(0, m.index).match(/\b(?:S|Season\s*|Temporada\s*)(\d{1,2})\s*$/i);
      if (sm) result.season = Number(sm[1]);
    }
    let title = work.slice(0, m.index);
    title = title.replace(/\b(?:S|Season\s*|Temporada\s*)\d{1,2}\s*$/i, '');
    const yr = title.match(/\b(19\d{2}|20\d{2})\b\s*$/);
    if (yr && yr.index > 0) {
      if (!result.year) result.year = Number(yr[1]);
      title = title.slice(0, yr.index);
    }
    result.title = tidyTitle(title);
  } else {
    // Filme: título até o ano ou até termos de qualidade.
    let title = work;
    let yearIdx = -1;
    const re = /\b(19\d{2}|20\d{2})\b/g;
    let ym;
    while ((ym = re.exec(work))) {
      if (ym.index > 0) { yearIdx = ym.index; result.year = Number(ym[1]); }
    }
    if (yearIdx > 0) title = work.slice(0, yearIdx);
    result.title = tidyTitle(title);
    if (dirSeason !== null) {
      // Arquivo sem número dentro de pasta de temporada: trata como episódio especial.
      result.type = 'episode';
      result.season = dirSeason;
    }
  }

  // Título vazio ou genérico -> usa a pasta.
  const showDir = pickShowDir(dirs);
  const folder = showDir ? cleanFolderName(showDir) : null;
  if (result.type === 'episode') {
    if (folder && folder.title) {
      // Prefere o nome da pasta quando o título do arquivo está vazio ou é apenas "Episode".
      if (!result.title || /^(episode|epis[oó]dio|ep|e)$/i.test(result.title)) {
        result.title = folder.title;
        if (!result.year && folder.year) result.year = folder.year;
      }
    }
  } else if (!result.title && folder && folder.title) {
    result.title = folder.title;
    if (!result.year && folder.year) result.year = folder.year;
  }
  if (!result.title) result.title = tidyTitle(base) || base;
  result.folderTitle = folder ? folder.title : null;
  result.folderYear = folder ? folder.year : null;
  return result;
}

// Escolhe a pasta que provavelmente é o nome da série (ignorando "Season 1" etc).
function pickShowDir(dirs) {
  for (let i = dirs.length - 1; i >= 0; i--) {
    const d = dirs[i].trim();
    if (SEASON_DIR_RE.test(d) || SPECIALS_DIR_RE.test(d)) continue;
    if (/^(animes?|series|séries|filmes|movies|tv|tv shows|downloads?|videos?|vídeos)$/i.test(d)) continue;
    return d;
  }
  return null;
}

function shouldSkipDir(name) {
  return name.startsWith('.') || SKIP_DIR_RE.test(name);
}

function isSampleFile(name, size) {
  return /(^|[\s._-])sample([\s._-]|$)/i.test(name) && size < 300 * 1024 * 1024;
}

module.exports = {
  VIDEO_EXT, isVideoFile, parseMediaName, normalizeTitle, cleanFolderName, tidyTitle,
  shouldSkipDir, isSampleFile, pickShowDir,
};
