// Content script: bridges the page-level injected script and the extension popup/storage.
// Runs in an isolated world but can communicate with the page via CustomEvents
// and with the popup via chrome.runtime messages.

(() => {
if (window.__NSD_CONTENT_SCRIPT_LOADED__) return;
window.__NSD_CONTENT_SCRIPT_LOADED__ = true;

const WEBVTT = 'webvtt-lssdh-ios8';
const DFXP = 'dfxp-ls-sdh';
const SIMPLE = 'simplesdh';
const IMSC1_1 = 'imsc1.1';
const ALL_FORMATS = [IMSC1_1, DFXP, WEBVTT, SIMPLE];
const ALL_FORMATS_PREFER_VTT = [WEBVTT, IMSC1_1, DFXP, SIMPLE];

const EXTENSIONS = {};
EXTENSIONS[WEBVTT] = 'vtt';
EXTENSIONS[DFXP] = 'dfxp';
EXTENSIONS[SIMPLE] = 'xml';
EXTENSIONS[IMSC1_1] = 'xml';

const SUB_TYPES = {
  'subtitles': '',
  'closedcaptions': '[cc]'
};

const STOP = 'NSD_STOP';

let subCache = {};
let titleCache = {};
let idOverrides = {};
let coverCandidates = [];

let batchAll = null;
let batchSeason = null;
let batchToEnd = null;
let batch = null;
let currentVideoType = 'unknown';

// --- Settings (loaded from chrome.storage) ---
let settings = {
  epTitleInFilename: false,
  forceSubs: true,
  prefLocale: '',
  langs: '',
  subFormat: WEBVTT,
  batchDelay: 0,
  epubMainLang: '',
  epubSubLang: ''
};

chrome.storage.local.get(settings, stored => {
  Object.assign(settings, stored);
  try {
    localStorage.setItem('NSD_force-all-lang', settings.forceSubs);
    localStorage.setItem('NSD_pref-locale', settings.prefLocale || '');
  } catch (_) {}
});

chrome.storage.onChanged.addListener((changes) => {
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key in settings) settings[key] = newValue;
    if (key === 'forceSubs') {
      try { localStorage.setItem('NSD_force-all-lang', newValue); } catch (_) {}
    }
    if (key === 'prefLocale') {
      try { localStorage.setItem('NSD_pref-locale', newValue || ''); } catch (_) {}
    }
  }
});

// --- Inject page-level script (fallback if not injected by manifest) ---
try {
  if (!window.__NSD_INJECTED__) {
    const sc = document.createElement('script');
    sc.src = chrome.runtime.getURL('inject.js');
    sc.onload = () => sc.remove();
    (document.head || document.documentElement).appendChild(sc);
  }
} catch (_) {}

// --- UI: download menu ---
const MENU_HTML = `
<ol>
  <li class="nsd-header">Netflix Subtitle Downloader</li>
  <li class="nsd-action nsd-download">Download subs for this <span class="nsd-series">episode</span><span class="nsd-not-series">movie</span></li>
  <li class="nsd-action nsd-download-dual">Download Dual Subs (.srt)</li>
  <li class="nsd-action nsd-download-to-end nsd-series-only">Download subs from this ep to end</li>
  <li class="nsd-action nsd-download-season nsd-series-only">Download subs for this season</li>
  <li class="nsd-action nsd-download-all nsd-series-only">Download subs for all seasons</li>
  <li class="nsd-action nsd-epub-movie nsd-movie-only">Download as EPUB...</li>
  <li class="nsd-action nsd-epub-season nsd-series-only">Download EPUB for this season...</li>
  <li class="nsd-action nsd-epub-all nsd-series-only">Download EPUB for all seasons...</li>
</ol>
`;

const MENU_CSS = `
#nsd-menu {
  position: absolute;
  display: none;
  width: 320px;
  top: 0;
  left: calc(50% - 160px);
  z-index: 99999998;
  font-family: Netflix Sans, Helvetica Neue, Segoe UI, sans-serif;
}
#nsd-menu ol {
  list-style: none;
  padding: 0;
  margin: 0;
  background: #222;
  border-radius: 0 0 8px 8px;
  overflow: hidden;
}
body:hover #nsd-menu { display: block; }
#nsd-menu li { padding: 12px 16px; color: #fff; font-size: 13px; }
#nsd-menu .nsd-header { font-weight: bold; font-size: 14px; background: #e50914; }
#nsd-menu .nsd-action { cursor: pointer; display: none; }
#nsd-menu .nsd-action:hover { background: #444; }
#nsd-menu:hover .nsd-action { display: block; }
#nsd-menu:not(.nsd-is-series) .nsd-series { display: none !important; }
#nsd-menu.nsd-is-series .nsd-series { display: inline !important; }
#nsd-menu.nsd-is-series .nsd-not-series { display: none !important; }
#nsd-menu:not(.nsd-is-series) .nsd-not-series { display: inline !important; }
#nsd-menu:not(.nsd-is-series) .nsd-series-only { display: none !important; }
#nsd-menu.nsd-is-series .nsd-movie-only { display: none !important; }

#nsd-progress-bars {
  position: fixed;
  top: 0; left: 0; width: 100%;
  z-index: 99999999;
}
.nsd-progress {
  height: 4px;
  width: 100%;
  background: transparent;
  cursor: pointer;
}

#nsd-epub-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.7);
  z-index: 99999999;
  display: flex;
  align-items: center;
  justify-content: center;
}
#nsd-epub-modal {
  background: #222;
  color: #fff;
  border-radius: 12px;
  padding: 24px;
  width: 340px;
  font-family: Netflix Sans, Helvetica Neue, Segoe UI, sans-serif;
  font-size: 14px;
}
#nsd-epub-modal h2 {
  margin: 0 0 16px;
  font-size: 18px;
  color: #e50914;
}
#nsd-epub-modal label {
  display: block;
  margin-bottom: 6px;
  font-size: 13px;
  color: #aaa;
}
#nsd-epub-modal select {
  width: 100%;
  padding: 8px 10px;
  margin-bottom: 16px;
  background: #333;
  color: #fff;
  border: 1px solid #555;
  border-radius: 6px;
  font-size: 14px;
  appearance: auto;
}
#nsd-epub-modal .nsd-btn-row {
  display: flex;
  gap: 10px;
  margin-top: 8px;
}
#nsd-epub-modal button {
  flex: 1;
  padding: 10px;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  font-weight: bold;
  cursor: pointer;
}
#nsd-epub-modal .nsd-btn-primary {
  background: #e50914;
  color: #fff;
}
#nsd-epub-modal .nsd-btn-primary:hover { background: #f6121d; }
#nsd-epub-modal .nsd-btn-secondary {
  background: #444;
  color: #fff;
}
#nsd-epub-modal .nsd-btn-secondary:hover { background: #555; }
#nsd-epub-modal .nsd-status {
  margin-top: 12px;
  font-size: 12px;
  color: #aaa;
  text-align: center;
  min-height: 18px;
}
#nsd-cover-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
  max-height: 220px;
  overflow-y: auto;
}
.nsd-cover-tile {
  width: 72px;
  height: 104px;
  flex: 0 0 auto;
  border: 2px solid transparent;
  border-radius: 4px;
  overflow: hidden;
  cursor: pointer;
  background: #333;
  display: flex;
  align-items: center;
  justify-content: center;
}
.nsd-cover-tile img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.nsd-cover-tile.nsd-cover-selected {
  border-color: #e50914;
}
.nsd-cover-none,
.nsd-cover-upload {
  font-size: 11px;
  color: #aaa;
  text-align: center;
  border-style: dashed;
  border-color: #555;
}
.nsd-cover-upload:hover,
.nsd-cover-none:hover {
  color: #fff;
  border-color: #888;
}
`;

function ensureMenu() {
  let menu = document.getElementById('nsd-menu');
  if (!menu) {
    const style = document.createElement('style');
    style.textContent = MENU_CSS;
    document.head.appendChild(style);

    menu = document.createElement('div');
    menu.id = 'nsd-menu';
    menu.innerHTML = MENU_HTML;
    document.body.appendChild(menu);

    menu.querySelector('.nsd-download').addEventListener('click', downloadThis);
    const dualLi = menu.querySelector('.nsd-download-dual');
    if (dualLi) {
      dualLi.addEventListener('click', () => {
        downloadDualThis(settings.epubMainLang || 'de', settings.epubSubLang || 'en');
      });
    }
    menu.querySelector('.nsd-download-to-end').addEventListener('click', () => downloadBatchFrom(batchToEnd));
    menu.querySelector('.nsd-download-season').addEventListener('click', () => downloadBatchFrom(batchSeason));
    menu.querySelector('.nsd-download-all').addEventListener('click', () => downloadBatchFrom(batchAll));
    menu.querySelector('.nsd-epub-movie').addEventListener('click', () => showEpubModal('movie'));
    menu.querySelector('.nsd-epub-season').addEventListener('click', () => showEpubModal('season'));
    menu.querySelector('.nsd-epub-all').addEventListener('click', () => showEpubModal('all'));
  }
  return menu;
}

// --- Progress bar ---
class ProgressBar {
  constructor(max) {
    this.current = 0;
    this.max = max;

    let container = document.getElementById('nsd-progress-bars');
    if (!container) {
      container = document.createElement('div');
      container.id = 'nsd-progress-bars';
      document.body.appendChild(container);
    }

    this.el = document.createElement('div');
    this.el.className = 'nsd-progress';
    this.el.title = 'Click to stop download';
    this.stop = new Promise(resolve => {
      this.el.addEventListener('click', () => resolve(STOP));
    });
    container.appendChild(this.el);
  }

  increment() {
    this.current++;
    const p = Math.min(100, this.current / this.max * 100);
    this.el.style.background = `linear-gradient(to right, #e50914 ${p}%, transparent ${p}%)`;
  }

  destroy() {
    this.el.remove();
  }
}

// --- Process intercepted data ---
function processSubInfo(result) {
  const tracks = result.timedtexttracks || result.textTracks || result.timedTextTracks;
  if (!tracks) return;
  const subs = {};
  for (const track of tracks) {
    if (track.isNoneTrack) continue;

    let type = SUB_TYPES[track.rawTrackType];
    if (typeof type === 'undefined') type = `[${track.rawTrackType}]`;
    const variant = track.trackVariant ? `-${track.trackVariant}` : '';
    const langCode = track.language || track.bcp47 || 'und';
    const lang = langCode + type + variant + (track.isForcedNarrative ? '-forced' : '');

    const formats = {};
    for (const format of ALL_FORMATS) {
      const downloadables = (track.ttDownloadables || track.downloadables || {})[format];
      if (!downloadables) continue;
      let urls;
      if (downloadables.downloadUrls) urls = Object.values(downloadables.downloadUrls);
      else if (downloadables.urls) urls = downloadables.urls.map(u => (typeof u === 'string' ? u : u.url));
      else continue;
      formats[format] = [urls, EXTENSIONS[format]];
    }

    if (Object.keys(formats).length > 0) {
      for (let i = 0; ; i++) {
        const key = lang + (i === 0 ? '' : `-${i}`);
        if (!subs[key]) { subs[key] = formats; break; }
      }
    }
  }

  const validCount = Object.keys(subs).length;
  if (validCount === 0) {
    console.debug('[NSD] Candidate had no downloadable URLs, skipping.');
    return;
  }

    if (result.movieId) {
      subCache[result.movieId] = subs;
    }
    const currentId = getVideoId();
    if (currentId) {
      subCache[currentId] = subs;
    }
    subCache['latest'] = subs;
    console.log('[NSD] Subtitles processed successfully. Available tracks:', validCount);
}

function processMetadata(data) {
  const menu = ensureMenu();
  menu.style.display = document.location.pathname.startsWith('/watch') ? '' : 'none';
  menu.classList.remove('nsd-is-series');

  const result = data.video;
  const { type, title } = result;

  if (type === 'show') {
    currentVideoType = 'show';
    batchAll = [];
    batchSeason = [];
    batchToEnd = [];
    const allEps = [];
    let currentSeason = 0;
    menu.classList.add('nsd-is-series');

    for (const season of result.seasons) {
      for (const ep of season.episodes) {
        if (ep.id === result.currentEpisode) currentSeason = season.seq;
        allEps.push([season.seq, ep.seq, ep.id]);
        titleCache[ep.id] = {
          type, title,
          season: season.seq,
          episode: ep.seq,
          subtitle: ep.title,
          hiddenNumber: ep.hiddenEpisodeNumbers
        };
      }
    }

    allEps.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let toEnd = false;
    for (const [season, _ep, id] of allEps) {
      batchAll.push(id);
      if (season === currentSeason) batchSeason.push(id);
      if (id === result.currentEpisode) toEnd = true;
      if (toEnd) batchToEnd.push(id);
    }
  } else if (type === 'movie' || type === 'supplemental') {
    currentVideoType = 'movie';
    batchAll = null;
    batchSeason = null;
    batchToEnd = null;
    menu.classList.remove('nsd-is-series');
    if (result.id) titleCache[result.id] = { type, title };
    const curVid = getVideoId();
    if (curVid) titleCache[curVid] = { type, title };
    titleCache['latest'] = { type, title };
  } else {
    return;
  }

  // Collect cover-image candidates for the user to pick from in the EPUB modal.
  // Order: portrait (book-cover ratio) first, then landscape; largest within each group.
  coverCandidates = [];
  try {
    const sources = [result.boxart, result.artwork, result.storyart].filter(Boolean);
    const all = [];
    for (const artList of sources) {
      if (!artList) continue;
      for (const a of artList) {
        if (a && a.url) all.push(a);
      }
    }
    all.sort((a, b) => {
      const aPortrait = (a.h || 0) > (a.w || 0) ? 0 : 1;
      const bPortrait = (b.h || 0) > (b.w || 0) ? 0 : 1;
      if (aPortrait !== bPortrait) return aPortrait - bPortrait;
      return (b.w || 0) * (b.h || 0) - (a.w || 0) * (a.h || 0);
    });
    for (const a of all) addCoverCandidate(a.url);
  } catch (_) {}
  // Fallback: og:image meta tag
  try {
    const ogImg = document.querySelector('meta[property="og:image"]');
    if (ogImg) addCoverCandidate(ogImg.content);
  } catch (_) {}

  // Wait for sub cache to populate, then show menu
  const waitForSubs = async () => {
    while (getSubsFromCache(true) === null) await sleep(0.2);
    if (document.location.pathname.startsWith('/watch'))
      menu.style.display = '';

    // Only resume ZIP batch if explicitly active
    if (sessionStorage.getItem('NSD_batch_active') === 'true' && batch && batch.length > 0) {
      downloadBatch(true);
    }

    // Resume EPUB batch if active
    if (sessionStorage.getItem('NSD_epub_batch')) {
      processEpubBatchStep();
    }
  };
  waitForSubs();
}

// --- Helpers ---
const sleep = (sec, val) => new Promise(r => setTimeout(r, sec * 1000, val));

const getVideoId = () => {
  const m = window.location.pathname.match(/\/watch\/(\d+)/);
  if (m) return m[1];
  return window.location.pathname.split('/').filter(Boolean).pop() || '';
};

const addCoverCandidate = url => {
  if (url && !coverCandidates.includes(url)) coverCandidates.push(url);
};

function getFromCache(cache, name, silent) {
  const id = getVideoId();
  if (id && cache[id] && Object.keys(cache[id]).length > 0) return cache[id];

  const overrideId = idOverrides[id];
  if (overrideId && cache[overrideId] && Object.keys(cache[overrideId]).length > 0) return cache[overrideId];

  if (name === 'subtitles') {
    if (cache['latest'] && Object.keys(cache['latest']).length > 0) return cache['latest'];
    for (const k of Object.keys(cache)) {
      if (cache[k] && Object.keys(cache[k]).length > 0) return cache[k];
    }
  }

  if (silent) return null;
  if (name === 'title') {
    return { title: getCleanDocumentTitle(), type: currentVideoType === 'show' ? 'show' : 'movie' };
  }
  return null;
}

const getSubsFromCache = silent => getFromCache(subCache, 'subtitles', silent);

const pad = (n, l) => `${l}${n.toString().padStart(2, '0')}`;
const safeTitle = t => (t || 'Netflix').trim().replace(/[:*?"<>|\\\/]+/g, '_').replace(/ /g, '.');

function getCleanDocumentTitle() {
  let raw = document.title || '';
  raw = raw.replace(/\s*[-|]\s*Netflix\s*$/i, '')
           .replace(/^Watch\s+/i, '')
           .trim();
  return raw || 'Netflix_Video';
}

function getTitleFromCache() {
  const t = getFromCache(titleCache, 'title', true) || {
    title: getCleanDocumentTitle(),
    type: currentVideoType === 'show' ? 'show' : 'movie'
  };
  const parts = [t.title];
  if (t.type === 'show') {
    const s = pad(t.season || 1, 'S');
    if (t.hiddenNumber) {
      if (t.subtitle) parts.push(s, t.subtitle);
    } else {
      parts.push(s + pad(t.episode || 1, 'E'));
      if (settings.epTitleInFilename && t.subtitle) parts.push(t.subtitle);
    }
  }
  return [safeTitle(parts.join('.')), safeTitle(t.title), t.title];
}

function pickFormat(formats) {
  if (!formats || typeof formats !== 'object') return null;
  const order = settings.subFormat === DFXP ? ALL_FORMATS : ALL_FORMATS_PREFER_VTT;
  for (const f of order) {
    if (formats[f] && formats[f][0] && formats[f][0].length > 0) return formats[f];
  }
  for (const f of Object.keys(formats)) {
    if (formats[f] && formats[f][0] && formats[f][0].length > 0) return formats[f];
  }
  return null;
}

function popRandom(arr) {
  return arr.splice(Math.random() * arr.length | 0, 1)[0];
}

// --- Language aliases & matching ---
const RAW_ALIASES = [
  ['de', 'ger', 'german', 'deutsch'],
  ['en', 'eng', 'english'],
  ['es', 'spa', 'spanish', 'español', 'espanol'],
  ['fr', 'fre', 'fra', 'french', 'français', 'francais'],
  ['it', 'ita', 'italian', 'italiano'],
  ['ja', 'jpn', 'japanese', 'nihongo'],
  ['ko', 'kor', 'korean'],
  ['hi', 'hin', 'hindi'],
  ['pt', 'por', 'portuguese'],
  ['ru', 'rus', 'russian'],
  ['zh', 'chi', 'zho', 'chinese'],
  ['nl', 'dut', 'nla', 'dutch'],
  ['pl', 'pol', 'polish'],
  ['tr', 'tur', 'turkish'],
  ['ar', 'ara', 'arabic'],
  ['sv', 'swe', 'swedish'],
  ['da', 'dan', 'danish'],
  ['fi', 'fin', 'finnish'],
  ['nb', 'nor', 'norwegian'],
  ['no', 'nor', 'norwegian']
];

const ALIAS_LOOKUP = {};
for (const group of RAW_ALIASES) {
  for (const name of group) {
    ALIAS_LOOKUP[name.toLowerCase()] = group;
  }
}

function findTrackKey(subs, query) {
  if (!subs || !query) return null;
  const q = query.trim().toLowerCase();
  const keys = Object.keys(subs);
  if (keys.length === 0) return null;

  if (subs[query]) return query;

  const aliases = ALIAS_LOOKUP[q] || [q];

  // 1. Check non-forced tracks with prefix/exact match
  const nonForced = keys.filter(k => !k.endsWith('-forced'));
  for (const alias of aliases) {
    const match = nonForced.find(k => {
      const lower = k.toLowerCase();
      return lower === alias || lower.startsWith(alias + '[') || lower.startsWith(alias + '-') || lower.startsWith(alias);
    });
    if (match) return match;
  }

  // 2. Substring in non-forced
  for (const alias of aliases) {
    const match = nonForced.find(k => k.toLowerCase().includes(alias));
    if (match) return match;
  }

  // 3. Check all tracks including forced
  for (const alias of aliases) {
    const match = keys.find(k => {
      const lower = k.toLowerCase();
      return lower === alias || lower.startsWith(alias + '[') || lower.startsWith(alias + '-') || lower.startsWith(alias);
    });
    if (match) return match;
  }

  return null;
}

// --- Dual Subtitle Generator (.srt) ---
function formatSRTTimestamp(ms) {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const millis = ms % 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function captionsToSRT(captions) {
  let srt = '';
  let index = 1;
  for (const c of captions) {
    if (!c.text) continue;
    srt += `${index}\n`;
    srt += `${formatSRTTimestamp(c.start)} --> ${formatSRTTimestamp(c.end)}\n`;
    srt += `${c.text}\n\n`;
    index++;
  }
  return srt;
}

function clearActiveBatch(clearEpub = false) {
  batch = null;
  try {
    sessionStorage.removeItem('NSD_batch');
    sessionStorage.removeItem('NSD_batch_active');
    sessionStorage.removeItem('NSD_zip');
    if (clearEpub) sessionStorage.removeItem('NSD_epub_batch');
  } catch (_) {}
}

function generateDualSRT(mainVttText, subVttText, color = '#ffff55') {
  const mainCaps = typeof parseVTT === 'function' ? parseVTT(mainVttText) : [];
  const subCaps = typeof parseVTT === 'function' ? parseVTT(subVttText) : [];

  if (!mainCaps.length && !subCaps.length) return '';
  if (!mainCaps.length) return captionsToSRT(subCaps);
  if (!subCaps.length) return captionsToSRT(mainCaps);

  const items = typeof alignCaptions === 'function' ? alignCaptions(mainCaps, subCaps) : [];

  let srt = '';
  let index = 1;
  for (const item of items) {
    const lines = [];
    if (item.mainText) lines.push(item.mainText);
    if (item.subTexts && item.subTexts.length > 0) {
      lines.push(`<font color="${color}">${item.subTexts.join('\n')}</font>`);
    }
    if (lines.length === 0) continue;

    srt += `${index}\n`;
    srt += `${formatSRTTimestamp(item.start)} --> ${formatSRTTimestamp(item.end)}\n`;
    srt += `${lines.join('\n')}\n\n`;
    index++;
  }
  return srt;
}

async function downloadDualThis(mainLangReq, subLangReq) {
  clearActiveBatch();

  const subs = getSubsFromCache(true);
  if (!subs || typeof subs !== 'object' || Object.keys(subs).length === 0) {
    alert('Subtitles are not yet ready. Please make sure the video is playing in Netflix, then try again.');
    return;
  }
  const [title] = getTitleFromCache();
  const availableLangs = Object.keys(subs);

  const mainTrackKey = findTrackKey(subs, mainLangReq);
  const subTrackKey = findTrackKey(subs, subLangReq);

  if (!mainTrackKey && !subTrackKey) {
    alert(`Neither "${mainLangReq}" nor "${subLangReq}" found in available subtitle tracks.\n\nAvailable tracks:\n${availableLangs.join(', ')}`);
    return;
  }
  if (!mainTrackKey) {
    alert(`Main language "${mainLangReq}" not found in available subtitle tracks.\n\nAvailable tracks:\n${availableLangs.join(', ')}`);
    return;
  }
  if (!subTrackKey) {
    alert(`Second language "${subLangReq}" not found in available subtitle tracks.\n\nAvailable tracks:\n${availableLangs.join(', ')}`);
    return;
  }

  const progress = new ProgressBar(2);
  try {
    const mainVtt = await fetchVttForLang(subs, mainTrackKey);
    progress.increment();
    const subVtt = await fetchVttForLang(subs, subTrackKey);
    progress.increment();

    if (!mainVtt || !subVtt) {
      alert('Failed to download subtitle content for one or both languages.');
      return;
    }

    const dualSrt = generateDualSRT(mainVtt, subVtt, '#ffff55');
    if (!dualSrt || !dualSrt.trim()) {
      alert('Could not parse subtitles to generate dual SRT.');
      return;
    }

    const blob = new Blob([dualSrt], { type: 'text/plain;charset=utf-8' });
    const filename = `${title}.WEBRip.Netflix.Dual.${mainTrackKey}+${subTrackKey}.srt`;
    saveAs(blob, filename);
  } catch (err) {
    console.error('[NSD] Dual subtitle download failed:', err);
    alert('Dual subtitle download failed: ' + err.message);
  } finally {
    progress.destroy();
  }
}

// --- Download logic ---
async function downloadSubs(zip) {
  const subs = getSubsFromCache();
  const [title, seriesTitle] = getTitleFromCache();

  let filteredLangs;
  if (!settings.langs || !settings.langs.trim()) {
    filteredLangs = Object.keys(subs);
  } else {
    const tokens = settings.langs.split(/[\s,;]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
    if (tokens.length === 0) {
      filteredLangs = Object.keys(subs);
    } else {
      const matched = new Set();
      for (const token of tokens) {
        const track = findTrackKey(subs, token);
        if (track) matched.add(track);
        const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp('^' + escaped, 'i');
        for (const k of Object.keys(subs)) {
          if (re.test(k)) matched.add(k);
        }
      }
      filteredLangs = Array.from(matched);
      if (filteredLangs.length === 0) {
        console.info('[NSD] Filter "' + settings.langs + '" had no direct match. Using all available tracks:', Object.keys(subs));
        filteredLangs = Object.keys(subs);
      }
    }
  }

  const progress = new ProgressBar(filteredLangs.length);
  let stop = false;

  for (const lang of filteredLangs) {
    const formatInfo = pickFormat(subs[lang]);
    if (!formatInfo) continue;
    const [rawUrls, ext] = formatInfo;
    const urls = Array.isArray(rawUrls) ? [...rawUrls] : [];

    while (urls.length > 0) {
      const url = popRandom(urls);
      let resp = null;
      try {
        const raceRes = await Promise.race([
          fetch(url, { mode: 'cors' }),
          progress.stop,
          sleep(20, 'TIMEOUT')
        ]);
        if (raceRes === STOP) {
          stop = true;
          break;
        }
        if (raceRes instanceof Response && raceRes.ok) {
          resp = raceRes;
        }
      } catch (err) {
        console.debug('[NSD] Mirror fetch failed, trying next mirror:', err);
      }

      if (resp) {
        try {
          const data = await resp.text();
          if (data && data.length > 10) {
            zip.file(`${title}.WEBRip.Netflix.${lang}.${ext}`, data);
            progress.increment();
            break;
          }
        } catch (_) {}
      }
    }
    if (stop) break;
  }

  progress.destroy();
  return [seriesTitle, stop];
}

function sanitizeFilename(name) {
  if (!name) return 'Netflix_Video';
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '') || 'Netflix_Video';
}

function fallbackDomDownload(blob, filename) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(() => {
      try { a.remove(); } catch (_) {}
      try { URL.revokeObjectURL(url); } catch (_) {}
    }, 2000);
  } catch (err) {
    console.error('[NSD] DOM download fallback failed:', err);
    if (typeof window.saveAs === 'function' && window.saveAs !== saveAs) {
      window.saveAs(blob, filename);
    }
  }
}

function saveAs(blob, rawFilename) {
  let filename = rawFilename || 'download';
  const isEpub = (blob && blob.type === 'application/epub+zip') || filename.toLowerCase().endsWith('.epub');
  const isZip = (blob && blob.type === 'application/zip') || filename.toLowerCase().endsWith('.zip');
  const isSrt = filename.toLowerCase().endsWith('.srt');

  if (isEpub) {
    const base = filename.replace(/\.epub$/i, '');
    filename = sanitizeFilename(base) + '.epub';
  } else if (isZip) {
    const base = filename.replace(/\.zip$/i, '');
    filename = sanitizeFilename(base) + '.zip';
  } else if (isSrt) {
    const base = filename.replace(/\.srt$/i, '');
    filename = sanitizeFilename(base) + '.srt';
  } else {
    filename = sanitizeFilename(filename);
  }

  // 1. Primary: Use background service worker via chrome.downloads API.
  // This bypasses all page CSP / synthetic click limitations and guarantees
  // Chrome saves the file with its exact filename and extension.
  try {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result;
      chrome.runtime.sendMessage({
        action: 'downloadFile',
        url: dataUrl,
        filename: filename
      }, resp => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          fallbackDomDownload(blob, filename);
        }
      });
    };
    reader.onerror = () => {
      fallbackDomDownload(blob, filename);
    };
    reader.readAsDataURL(blob);
  } catch (_) {
    fallbackDomDownload(blob, filename);
  }
}

async function saveZip(zip, title) {
  const fileCount = Object.keys(zip.files).length;
  if (fileCount === 0) {
    alert('No subtitle tracks could be downloaded. The Netflix session or subtitle URLs may have expired. Please refresh the Netflix tab (F5) and play the video, then try downloading again.');
    return;
  }
  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/zip' });
  saveAs(blob, title + '.zip');
}

async function downloadThis() {
  try {
    clearActiveBatch();
    const zip = new JSZip();
    const [title] = await downloadSubs(zip);
    saveZip(zip, title);
  } catch (err) {
    console.error('NSD download failed:', err);
  }
}

async function downloadBatchFrom(ids) {
  if (!ids || ids.length === 0) return;
  sessionStorage.setItem('NSD_batch_active', 'true');
  batch = [...ids];
  sessionStorage.setItem('NSD_batch', JSON.stringify(batch));
  downloadBatch(false);
}

async function downloadBatch(isResume) {
  let zip;
  if (isResume) {
    // Try to restore zip from sessionStorage
    try {
      const saved = sessionStorage.getItem('NSD_zip');
      if (saved) {
        zip = await JSZip.loadAsync(saved, { base64: true });
      } else {
        zip = new JSZip();
      }
    } catch (_) {
      zip = new JSZip();
    }
  } else {
    zip = new JSZip();
  }

  let title, stop;
  try {
    [title, stop] = await downloadSubs(zip);
  } catch (_) {
    title = 'unknown';
    stop = true;
  }

  const id = parseInt(getVideoId());
  batch = batch.filter(x => x !== id);

  if (stop || batch.length === 0) {
    saveZip(zip, title);
    clearActiveBatch();
  } else {
    // Save zip to sessionStorage and navigate to next episode
    const b64 = await zip.generateAsync({ type: 'base64' });
    try {
      sessionStorage.setItem('NSD_zip', b64);
      sessionStorage.setItem('NSD_batch', JSON.stringify(batch));
      sessionStorage.setItem('NSD_batch_active', 'true');
    } catch (_) {
      // sessionStorage full — just save what we have
      saveZip(zip, title);
      clearActiveBatch();
      return;
    }
    await sleep(settings.batchDelay);
    window.location = window.location.origin + '/watch/' + batch[0];
  }
}

// ========== EPUB Modal + Download ==========

function getAvailableLangs() {
  const subs = getSubsFromCache(true);
  if (!subs) return [];
  return Object.keys(subs).filter(l => !l.endsWith('-forced')).sort();
}

// scope: 'movie' | 'season' | 'all'
function showEpubModal(scope) {
  // Remove existing modal
  const existing = document.getElementById('nsd-epub-modal-overlay');
  if (existing) existing.remove();

  const langs = getAvailableLangs();
  if (langs.length === 0) {
    alert('No subtitle tracks available yet. Wait for the player to load.');
    return;
  }

  const scopeLabel = scope === 'all' ? 'all seasons' : scope === 'season' ? 'this season' : scope === 'episode' ? 'this episode' : 'this movie';
  const langOptions = langs.map(l => `<option value="${l}">${l}</option>`).join('');

  const overlay = document.createElement('div');
  overlay.id = 'nsd-epub-modal-overlay';
  overlay.innerHTML = `
    <div id="nsd-epub-modal">
      <h2>Download EPUB — ${scopeLabel}</h2>
      <label for="nsd-main-lang">Main language</label>
      <select id="nsd-main-lang">${langOptions}</select>
      <label for="nsd-sub-lang">Second language (optional)</label>
      <select id="nsd-sub-lang"><option value="">— None —</option>${langOptions}</select>
      <label>Book cover</label>
      <div id="nsd-cover-grid"></div>
      <div class="nsd-btn-row">
        <button class="nsd-btn-secondary" id="nsd-epub-cancel">Cancel</button>
        <button class="nsd-btn-primary" id="nsd-epub-go">Download EPUB</button>
      </div>
      <div class="nsd-status" id="nsd-epub-status"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Pre-select default languages from settings
  const mainSelect = overlay.querySelector('#nsd-main-lang');
  const subSelect = overlay.querySelector('#nsd-sub-lang');
  if (settings.epubMainLang) {
    const match = langs.find(l => l.toLowerCase().startsWith(settings.epubMainLang.toLowerCase()));
    if (match) mainSelect.value = match;
  }
  if (settings.epubSubLang) {
    const match = langs.find(l => l.toLowerCase().startsWith(settings.epubSubLang.toLowerCase()));
    if (match) subSelect.value = match;
  }

  // Build the cover-image picker
  buildCoverGrid(overlay);

  // Close on overlay click (but not modal body)
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.remove();
  });

  document.getElementById('nsd-epub-cancel').addEventListener('click', () => overlay.remove());
  document.getElementById('nsd-epub-go').addEventListener('click', () => {
    const mainLang = document.getElementById('nsd-main-lang').value;
    const subLang = document.getElementById('nsd-sub-lang').value;
    const coverUrl = overlay._nsdCoverUrl || null;
    downloadAsEpub(mainLang, subLang || null, scope, overlay, coverUrl);
  });
}

// Populate the cover-image thumbnail picker. The chosen image URL (a Netflix
// art URL or an uploaded data: URL) is stored on overlay._nsdCoverUrl; '' means
// "No cover". The first (best) candidate is pre-selected to match the previous
// automatic behaviour. Selection is tracked by tile element so large uploaded
// data: URLs don't have to be stored as DOM attributes.
function buildCoverGrid(overlay) {
  const grid = overlay.querySelector('#nsd-cover-grid');
  if (!grid) return;

  const tiles = [];
  const select = (tile, url) => {
    overlay._nsdCoverUrl = url;
    tiles.forEach(t => t.classList.toggle('nsd-cover-selected', t === tile));
  };

  const addTile = (url, label) => {
    const tile = document.createElement('div');
    tile.className = 'nsd-cover-tile';
    const img = document.createElement('img');
    img.src = url;
    img.loading = 'lazy';
    img.alt = label;
    tile.appendChild(img);
    tile.addEventListener('click', () => select(tile, url));
    grid.appendChild(tile);
    tiles.push(tile);
    return tile;
  };

  coverCandidates.forEach((url, i) => addTile(url, 'Cover ' + (i + 1)));

  // Upload tile — lets the user supply their own cover image
  const uploadTile = document.createElement('div');
  uploadTile.className = 'nsd-cover-tile nsd-cover-upload';
  uploadTile.textContent = '+ Upload';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.style.display = 'none';
  uploadTile.appendChild(fileInput);
  uploadTile.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    try {
      const dataUrl = await readCoverFile(file);
      const tile = addTile(dataUrl, 'Custom cover');
      grid.insertBefore(tile, uploadTile); // keep upload/no-cover tiles last
      select(tile, dataUrl);
    } catch (_) {
      alert('Could not read that image.');
    }
    fileInput.value = ''; // allow re-selecting the same file
  });
  grid.appendChild(uploadTile);

  // "No cover" tile
  const none = document.createElement('div');
  none.className = 'nsd-cover-tile nsd-cover-none';
  none.textContent = 'No cover';
  none.addEventListener('click', () => select(none, ''));
  grid.appendChild(none);
  tiles.push(none);

  if (tiles.length > 1) select(tiles[0], coverCandidates[0]);
  else select(none, '');
}

// Read an uploaded image file into a data: URL, downscaling large images so the
// cover stays small enough to survive sessionStorage across batch navigation.
function readCoverFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => resolve(reader.result); // fall back to the raw data URL
      img.onload = () => {
        try {
          const maxSide = 1200;
          const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          if (scale === 1) { resolve(reader.result); return; }
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.9));
        } catch (_) {
          resolve(reader.result);
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Start EPUB batch: save config to sessionStorage, then process current episode
async function downloadAsEpub(mainLang, subLang, scope, overlay, coverUrl) {
  const statusEl = document.getElementById('nsd-epub-status');
  const goBtn = document.getElementById('nsd-epub-go');
  goBtn.disabled = true;
  goBtn.textContent = 'Starting...';

  try {
    const [titleWithEp, seriesTitle, rawDisplayTitle] = getTitleFromCache();
    const displayTitle = rawDisplayTitle || seriesTitle || titleWithEp;

    // Determine which episodes to include
    let episodeIds;
    if (scope === 'all' && batchAll) {
      episodeIds = [...batchAll];
    } else if (scope === 'season' && batchSeason) {
      episodeIds = [...batchSeason];
    } else {
      episodeIds = [parseInt(getVideoId())];
    }

    // Save EPUB batch state to sessionStorage
    const epubBatch = {
      remaining: episodeIds,
      chapters: [],
      mainLang,
      subLang: subLang || null,
      seriesTitle: displayTitle,
      fileBaseTitle: safeTitle(seriesTitle || titleWithEp),
      scope,
      coverUrl: coverUrl || null
    };
    sessionStorage.setItem('NSD_epub_batch', JSON.stringify(epubBatch));

    // Close modal and start processing
    overlay.remove();
    await processEpubBatchStep();

  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    goBtn.disabled = false;
    goBtn.textContent = 'Download EPUB';
  }
}

// Process current episode for EPUB batch, then navigate to next or finalize
async function processEpubBatchStep() {
  const raw = sessionStorage.getItem('NSD_epub_batch');
  if (!raw) return;
  const epubBatch = JSON.parse(raw);

  // Wait for current episode's subs to load
  while (getSubsFromCache(true) === null) {
    await sleep(0.5);
  }

  const currentId = parseInt(getVideoId());
  const epSubs = getSubsFromCache(true);
  const epTitle = titleCache[currentId] || titleCache[getVideoId()] || getFromCache(titleCache, 'title', true);

  // Build chapter title
  let chapterTitle;
  if (epTitle && epTitle.type === 'show') {
    chapterTitle = `Season ${epTitle.season} Episode ${epTitle.episode}`;
    if (epTitle.subtitle) chapterTitle += ` - ${epTitle.subtitle}`;
  } else if (epTitle && epTitle.type === 'movie') {
    chapterTitle = epTitle.title || epubBatch.seriesTitle || 'Movie';
  } else {
    chapterTitle = epubBatch.seriesTitle || (epubBatch.remaining && epubBatch.remaining.length > 1 ? `Chapter ${epubBatch.chapters.length + 1}` : 'Movie');
  }

  // Fetch and parse main language using track key resolution
  const mainTrackKey = epSubs ? findTrackKey(epSubs, epubBatch.mainLang) : null;
  if (epSubs && mainTrackKey) {
    const mainVtt = await fetchVttForLang(epSubs, mainTrackKey);
    if (mainVtt) {
      const mainCaptions = parseVTT(mainVtt);

      let subCaptions = null;
      const subTrackKey = epubBatch.subLang && epubBatch.subLang !== epubBatch.mainLang ? findTrackKey(epSubs, epubBatch.subLang) : null;
      if (subTrackKey) {
        const subVtt = await fetchVttForLang(epSubs, subTrackKey);
        if (subVtt) subCaptions = parseVTT(subVtt);
      }

      const html = mergeSubtitles(mainCaptions, subCaptions);
      epubBatch.chapters.push({ title: chapterTitle, html });
    }
  }

  // Remove current episode from remaining list
  epubBatch.remaining = epubBatch.remaining.filter(id => id !== currentId);

  if (epubBatch.remaining.length === 0) {
    // All episodes done — generate EPUB
    sessionStorage.removeItem('NSD_epub_batch');

    if (epubBatch.chapters.length === 0) {
      alert('No subtitles found for the selected language.');
      return;
    }

    // Fetch the cover image the user chose in the modal
    let coverData = null;
    const imgUrl = epubBatch.coverUrl;
    if (imgUrl) {
      try {
        const resp = await fetch(imgUrl, { mode: 'cors' });
        if (resp.ok) {
          const blob = await resp.blob();
          const arrayBuf = await blob.arrayBuffer();
          const isWebp = blob.type === 'image/webp';
          const isPng = blob.type === 'image/png';
          coverData = {
            data: new Uint8Array(arrayBuf),
            mediaType: isPng ? 'image/png' : 'image/jpeg',
            ext: isPng ? 'png' : 'jpg'
          };
          // Convert WebP to JPEG via canvas for broader EPUB reader support
          if (isWebp) {
            try {
              const bitmap = await createImageBitmap(blob);
              const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
              const ctx = canvas.getContext('2d');
              ctx.drawImage(bitmap, 0, 0);
              const jpegBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
              const jpegBuf = await jpegBlob.arrayBuffer();
              coverData = { data: new Uint8Array(jpegBuf), mediaType: 'image/jpeg', ext: 'jpg' };
            } catch (_) {} // keep original if conversion fails
          }
        }
      } catch (_) {}
    }

    const zip = generateEPUB(epubBatch.seriesTitle, epubBatch.chapters, coverData);
    const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
    const cleanBase = sanitizeFilename(epubBatch.fileBaseTitle || epubBatch.seriesTitle || 'Movie');
    const filename = cleanBase.endsWith('.epub') ? cleanBase : (cleanBase + '.epub');
    saveAs(blob, filename);
  } else {
    // Save state and navigate to next episode
    sessionStorage.setItem('NSD_epub_batch', JSON.stringify(epubBatch));
    await sleep(settings.batchDelay);
    window.location = window.location.origin + '/watch/' + epubBatch.remaining[0];
  }
}

async function fetchVttForLang(epSubs, lang) {
  const formats = epSubs[lang];
  if (!formats) return null;

  // Prefer WebVTT format
  const preferred = [WEBVTT, IMSC1_1, DFXP, SIMPLE];
  let urls = null;
  for (const fmt of preferred) {
    if (formats[fmt]) {
      urls = [...formats[fmt][0]]; // clone the URL array
      break;
    }
  }
  if (!urls || urls.length === 0) return null;

  while (urls.length > 0) {
    const url = urls.splice(Math.random() * urls.length | 0, 1)[0];
    try {
      const resp = await fetch(url, { mode: 'cors' });
      const text = await resp.text();
      if (text.length > 0) return text;
    } catch (_) {}
  }
  return null;
}

// Resume batch from sessionStorage on page load only if active
try {
  if (sessionStorage.getItem('NSD_batch_active') === 'true') {
    const saved = sessionStorage.getItem('NSD_batch');
    if (saved) batch = JSON.parse(saved);
  } else {
    clearActiveBatch();
  }
} catch (_) {}

// --- Listen for data from injected page script ---
window.addEventListener('netflix_sub_downloader_data', e => {
  const { type, data } = e.detail;
  if (type === 'subs') processSubInfo(data);
  else if (type === 'id_override') idOverrides[data[0]] = data[1];
  else if (type === 'metadata') processMetadata(data);
  else if (type === 'boxart') { if (data && !coverCandidates.includes(data)) coverCandidates.unshift(data); }
  else if (type === 'popstate') {
    const menu = document.getElementById('nsd-menu');
    if (menu) menu.style.display = data.startsWith('/watch') ? '' : 'none';
  }
});

// --- Listen for messages from popup ---
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const isSeries = currentVideoType === 'show' ||
    (currentVideoType !== 'movie' && (
      (batchSeason !== null && batchSeason.length > 0) ||
      (batchAll !== null && batchAll.length > 0) ||
      !!document.getElementById('nsd-menu')?.classList.contains('nsd-is-series')
    ));

  if (msg.action === 'getStatus') {
    const subs = getSubsFromCache(true);
    const langList = (subs && typeof subs === 'object') ? Object.keys(subs) : [];
    const isBatchActive = sessionStorage.getItem('NSD_batch_active') === 'true' && batch && batch.length > 0;
    sendResponse({
      onWatchPage: document.location.pathname.includes('/watch'),
      langList,
      isSeries: !!isSeries,
      isBatchActive
    });
  } else if (msg.action === 'download') {
    downloadThis();
    sendResponse({ ok: true });
  } else if (msg.action === 'downloadDual') {
    downloadDualThis(msg.mainLang || settings.epubMainLang || 'de', msg.subLang || settings.epubSubLang || 'en');
    sendResponse({ ok: true });
  } else if (msg.action === 'downloadEpubSingle' || msg.action === 'downloadEpubMovie') {
    showEpubModal(isSeries ? 'episode' : 'movie');
    sendResponse({ ok: true });
  } else if (msg.action === 'clearBatch') {
    clearActiveBatch(true);
    sendResponse({ ok: true });
  } else if (msg.action === 'downloadSeason') {
    if (batchSeason) downloadBatchFrom(batchSeason);
    sendResponse({ ok: true });
  } else if (msg.action === 'downloadAll') {
    if (batchAll) downloadBatchFrom(batchAll);
    sendResponse({ ok: true });
  } else if (msg.action === 'downloadEpubSeason') {
    showEpubModal('season');
    sendResponse({ ok: true });
  } else if (msg.action === 'downloadEpubAll') {
    showEpubModal('all');
    sendResponse({ ok: true });
  } else if (msg.action === 'getLangs') {
    sendResponse({ langs: getAvailableLangs() });
  }
});
})();
