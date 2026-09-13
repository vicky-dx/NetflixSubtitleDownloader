// This script runs in the PAGE context (not content script) so it can
// intercept JSON.parse / JSON.stringify / fetch / XHR used by Netflix.

(function (ALL_FORMATS) {
  if (window.__NSD_INJECTED__) return;
  window.__NSD_INJECTED__ = true;

  console.log('[NSD] Netflix Subtitle Downloader injector active');

  const MANIFEST_PATTERN = /manifest|licensedManifest/;

  const getStorage = (key, fallback) => {
    try { return localStorage.getItem(key); } catch (_) { return fallback; }
  };
  const forceSubs = getStorage('NSD_force-all-lang', null) !== 'false';
  const prefLocale = getStorage('NSD_pref-locale', '') || '';

  // When navigating away from /watch, tell the content script to hide menu
  window.addEventListener('popstate', () => {
    window.dispatchEvent(new CustomEvent('netflix_sub_downloader_data', {
      detail: { type: 'popstate', data: document.location.pathname }
    }));
  });

  function inspectCandidate(data, source) {
    if (!data || typeof data !== 'object') return;

    // Check for subtitle manifest tracks
    const candidates = [data, data.result, data.data, data.value].filter(Boolean);
    for (const c of candidates) {
      if (typeof c !== 'object') continue;
      const tracks = c.timedtexttracks || c.textTracks || c.timedTextTracks;
      if (tracks && (Array.isArray(tracks) || typeof tracks === 'object')) {
        const trackList = Array.isArray(tracks) ? tracks : Object.values(tracks);
        const hasDownloadables = trackList.some(t => t && (t.ttDownloadables || t.downloadables));
        if (!hasDownloadables) continue;

        const urlId = (window.location.pathname.match(/\/watch\/(\d+)/) || [])[1];
        if (!c.movieId && urlId) {
          c.movieId = parseInt(urlId, 10);
        }
        console.log('[NSD] Intercepted valid subtitles from:', source, 'track count:', trackList.length);
        window.dispatchEvent(new CustomEvent('netflix_sub_downloader_data', {
          detail: { type: 'subs', data: c }
        }));
        break;
      }
    }

    // Check for metadata
    if (data.video && (data.video.type === 'show' || data.video.type === 'movie' || data.video.seasons)) {
      console.log('[NSD] Intercepted metadata from:', source, data.video.title);
      window.dispatchEvent(new CustomEvent('netflix_sub_downloader_data', {
        detail: { type: 'metadata', data }
      }));
    }
  }

  // Hijack JSON.parse, JSON.stringify, Response.prototype.json, fetch, and XHR
  const origParse = JSON.parse;
  const origStringify = JSON.stringify;
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origFetch = window.fetch;

  JSON.parse = function (text) {
    const data = origParse(text);
    try { inspectCandidate(data, 'JSON.parse'); } catch (_) {}
    return data;
  };

  if (window.Response && Response.prototype.json) {
    const origResponseJson = Response.prototype.json;
    Response.prototype.json = async function () {
      const data = await origResponseJson.apply(this, arguments);
      try { inspectCandidate(data, 'Response.json'); } catch (_) {}
      return data;
    };
  }

  JSON.stringify = function (data) {
    if (data && typeof data.url === 'string' && data.url.search(MANIFEST_PATTERN) > -1) {
      for (const v of Object.values(data)) {
        try {
          if (v.profiles) {
            for (const profile of ALL_FORMATS) {
              if (!v.profiles.includes(profile)) {
                v.profiles.unshift(profile);
              }
            }
          }
          if (v.showAllSubDubTracks != null && forceSubs)
            v.showAllSubDubTracks = true;
          if (prefLocale !== '')
            v.preferredTextLocale = prefLocale;
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
        }
      }
    }
    if (data && (typeof data.movieId === 'number' || typeof data.movieId === 'string')) {
      try {
        const videoId = data.params?.sessionParams?.uiplaycontext?.video_id;
        if (videoId && videoId !== data.movieId)
          window.dispatchEvent(new CustomEvent('netflix_sub_downloader_data', {
            detail: { type: 'id_override', data: [videoId, data.movieId] }
          }));
      } catch (_) {}
    }
    return origStringify(data);
  };

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__nsd_url = typeof url === 'string' ? url : '';
    origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      try {
        let d = this.response;
        if (typeof d === 'string') {
          try { d = origParse(d); } catch (_) {}
        }
        inspectCandidate(d, 'XHR');
      } catch (_) {}
    }, false);
    origSend.apply(this, arguments);
  };

  window.fetch = async (...args) => {
    const response = origFetch(...args);
    try {
      const rawUrl = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      if (rawUrl.includes('/metadata?') || rawUrl.includes('manifest') || rawUrl.includes('licensedManifest')) {
        const copied = (await response).clone();
        copied.json().then(data => {
          inspectCandidate(data, 'fetch');
        }).catch(() => {});
      }
    } catch (_) {}
    return response;
  };

  // Extract boxart URL from Falcor cache (portrait poster for book covers)
  const extractBoxart = () => {
    try {
      const m = window.location.pathname.match(/\/watch\/(\d+)/);
      const videoId = m ? m[1] : window.location.pathname.split('/').filter(Boolean).pop();
      const cache = window.netflix && window.netflix.falcorCache;
      if (!cache || !cache.videos || !cache.videos[videoId]) return;
      const video = cache.videos[videoId];
      const boxartKeys = Object.keys(video).filter(k => k.startsWith('boxart'));
      for (const key of boxartKeys) {
        const entries = video[key];
        if (!entries) continue;
        for (const sizeKey of Object.keys(entries)) {
          const val = entries[sizeKey];
          if (val && val.value && val.value.url) {
            window.dispatchEvent(new CustomEvent('netflix_sub_downloader_data', {
              detail: { type: 'boxart', data: val.value.url }
            }));
            return;
          }
        }
      }
    } catch (_) {}
  };
  setTimeout(extractBoxart, 3000);
  setTimeout(extractBoxart, 8000);

  // Scroll fix for language selector
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        try {
          (node.parentNode || node).querySelector('.watch-video--selector-audio-subtitle')
            .parentNode.style.overflowY = 'scroll';
        } catch (_) {}
      }
    }
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
})(["imsc1.1", "dfxp-ls-sdh", "webvtt-lssdh-ios8", "simplesdh"]);
