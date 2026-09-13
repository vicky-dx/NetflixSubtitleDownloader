const $ = id => document.getElementById(id);

const DEFAULTS = {
  epTitleInFilename: false,
  forceSubs: true,
  prefLocale: '',
  langs: '',
  subFormat: 'webvtt-lssdh-ios8',
  batchDelay: 0,
  epubMainLang: '',
  epubSubLang: ''
};

let savedMainLang = '';
let savedSubLang = '';

// Load settings
chrome.storage.local.get(DEFAULTS, s => {
  $('opt-ep-title').checked = s.epTitleInFilename;
  $('opt-force-subs').checked = s.forceSubs;
  $('opt-locale').value = s.prefLocale;
  $('opt-langs').value = s.langs;
  $('opt-format').value = s.subFormat;
  $('opt-delay').value = s.batchDelay;
  savedMainLang = s.epubMainLang || '';
  savedSubLang = s.epubSubLang || '';
});

// Save on change
const save = (key, val) => chrome.storage.local.set({ [key]: val });

$('opt-ep-title').addEventListener('change', e => save('epTitleInFilename', e.target.checked));
$('opt-force-subs').addEventListener('change', e => save('forceSubs', e.target.checked));
$('opt-locale').addEventListener('change', e => save('prefLocale', e.target.value.trim()));
$('opt-langs').addEventListener('change', e => save('langs', e.target.value.trim()));
$('opt-format').addEventListener('change', e => save('subFormat', e.target.value));
$('opt-delay').addEventListener('change', e => save('batchDelay', parseFloat(e.target.value) || 0));
$('opt-epub-main').addEventListener('change', e => {
  savedMainLang = e.target.value;
  save('epubMainLang', e.target.value);
});
$('opt-epub-sub').addEventListener('change', e => {
  savedSubLang = e.target.value;
  save('epubSubLang', e.target.value);
});

function setButtonsEnabled({ download, series }) {
  const isSeries = !!series;
  $('btn-download').disabled = !download;
  $('btn-download').textContent = isSeries ? 'Download subs for this episode' : 'Download subs for this movie';

  $('btn-dual').disabled = !download;

  const btnEpubSingle = $('btn-epub-single');
  if (btnEpubSingle) {
    btnEpubSingle.disabled = !download;
    btnEpubSingle.textContent = isSeries ? 'Download EPUB (this episode)...' : 'Download EPUB (this movie)...';
  }

  const seriesActions = $('series-actions');
  if (seriesActions) {
    seriesActions.style.display = isSeries ? 'block' : 'none';
  }

  $('btn-season').disabled = !(download && isSeries);
  $('btn-all').disabled = !(download && isSeries);
  $('btn-epub-season').disabled = !(download && isSeries);
  $('btn-epub-all').disabled = !(download && isSeries);
}

function showReloadButton(tabId) {
  const btn = $('btn-reload');
  if (btn) {
    btn.style.display = 'block';
    btn.onclick = () => {
      chrome.tabs.reload(tabId);
      window.close();
    };
  }
}

// Action buttons
function sendToTab(action, extra = {}) {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (!tabs || !tabs[0] || !tabs[0].id) {
      $('status').textContent = 'No active Netflix tab found.';
      return;
    }
    chrome.tabs.sendMessage(tabs[0].id, { action, ...extra }, () => {
      if (chrome.runtime.lastError) {
        $('status').textContent = 'Connection failed. Please reload the Netflix tab.';
        $('status').style.color = '#e50914';
        setButtonsEnabled({ download: false, series: false });
        showReloadButton(tabs[0].id);
        return;
      }
      $('status').textContent = action === 'downloadDual' ? 'Dual subs download started!' : 'Download started!';
      $('status').style.color = '#46d369';
    });
  });
}

$('btn-download').addEventListener('click', () => sendToTab('download'));
$('btn-season').addEventListener('click', () => sendToTab('downloadSeason'));
$('btn-all').addEventListener('click', () => sendToTab('downloadAll'));
$('btn-dual').addEventListener('click', () => {
  const mainLang = $('opt-epub-main').value;
  const subLang = $('opt-epub-sub').value;
  if (!subLang) {
    alert('Please select a Second language for Dual Subtitles.');
    return;
  }
  sendToTab('downloadDual', { mainLang, subLang });
});
const btnEpubSingle = $('btn-epub-single');
if (btnEpubSingle) {
  btnEpubSingle.addEventListener('click', () => {
    sendToTab('downloadEpubSingle');
    window.close();
  });
}
$('btn-epub-season').addEventListener('click', () => {
  sendToTab('downloadEpubSeason');
  window.close();
});
$('btn-epub-all').addEventListener('click', () => {
  sendToTab('downloadEpubAll');
  window.close();
});

const stopBatchBtn = $('btn-stop-batch');
if (stopBatchBtn) {
  stopBatchBtn.addEventListener('click', () => {
    sendToTab('clearBatch');
    stopBatchBtn.style.display = 'none';
    $('status').textContent = 'Batch stopped.';
    $('status').style.color = '#999';
  });
}

function formatTrackLabel(key) {
  let display = key;
  if (key.endsWith('-STRIPPED_SDH')) {
    const base = key.replace('-STRIPPED_SDH', '');
    display = `${base} (Clean dialogue)`;
  } else if (key.includes('[cc]')) {
    const base = key.replace('[cc]', '');
    display = `${base} [CC] (with sounds)`;
  } else if (key.endsWith('-DUBTITLE')) {
    const base = key.replace('-DUBTITLE', '');
    display = `${base} (Dubbed audio)`;
  } else if (key.endsWith('-forced')) {
    const base = key.replace('-forced', '');
    display = `${base} [Forced]`;
  } else {
    display = `${key} (Standard)`;
  }
  return display;
}

function updateLanguageDropdowns(langList) {
  const mainSel = $('opt-epub-main');
  const subSel = $('opt-epub-sub');
  if (!mainSel || !subSel || !langList || langList.length === 0) return;

  const nonForced = langList.filter(k => !k.endsWith('-forced')).sort();
  const forced = langList.filter(k => k.endsWith('-forced')).sort();
  const sorted = [...nonForced, ...forced];

  const buildOptions = (isSub) => {
    let opts = isSub ? '<option value="">-- None --</option>' : '';
    if (nonForced.length > 0) {
      opts += '<optgroup label="Main Tracks">';
      for (const k of nonForced) {
        opts += `<option value="${k}">${formatTrackLabel(k)}</option>`;
      }
      opts += '</optgroup>';
    }
    if (forced.length > 0) {
      opts += '<optgroup label="Forced Narrative Tracks">';
      for (const k of forced) {
        opts += `<option value="${k}">${formatTrackLabel(k)}</option>`;
      }
      opts += '</optgroup>';
    }
    return opts;
  };

  const curMain = mainSel.value || savedMainLang;
  const curSub = subSel.value || savedSubLang;

  mainSel.innerHTML = buildOptions(false);
  subSel.innerHTML = buildOptions(true);

  // Restore or pick smart default for main
  const matchMain = sorted.find(k => k === curMain) ||
                    sorted.find(k => curMain && (k.startsWith(curMain) || k.toLowerCase().startsWith(curMain.toLowerCase()))) ||
                    sorted.find(k => k.startsWith('en')) ||
                    sorted[0];
  if (matchMain) mainSel.value = matchMain;

  // Restore or pick smart default for sub
  const matchSub = sorted.find(k => k === curSub) ||
                   sorted.find(k => curSub && (k.startsWith(curSub) || k.toLowerCase().startsWith(curSub.toLowerCase()))) ||
                   sorted.find(k => k.startsWith('de')) ||
                   (sorted.length > 1 ? sorted[1] : '');
  if (matchSub) subSel.value = matchSub;
}

let pollTimer = null;

function applyStatus(response, tabId) {
  const stopBtn = $('btn-stop-batch');
  if (stopBtn) {
    stopBtn.style.display = response.isBatchActive ? 'block' : 'none';
  }

  if (!response.onWatchPage) {
    $('status').textContent = 'Play a show or movie to download subs.';
    $('status').style.color = '#999';
    setButtonsEnabled({ download: false, series: false });
  } else if (!response.langList || response.langList.length === 0) {
    $('status').textContent = 'Waiting for subtitle data... (play video or reload)';
    $('status').style.color = '#e5a00d';
    setButtonsEnabled({ download: false, series: false });
    showReloadButton(tabId);
    if (!pollTimer) {
      pollTimer = setInterval(() => {
        chrome.tabs.sendMessage(tabId, { action: 'getStatus' }, resp => {
          if (!chrome.runtime.lastError && resp && resp.langList && resp.langList.length > 0) {
            clearInterval(pollTimer);
            pollTimer = null;
            applyStatus(resp, tabId);
          }
        });
      }, 1000);
    }
  } else {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    const sample = response.langList.slice(0, 6).join(', ') + (response.langList.length > 6 ? '...' : '');
    $('status').textContent = `${response.langList.length} tracks available (${sample})`;
    $('status').title = response.langList.join(', ');
    $('status').style.color = '#46d369';
    const reloadBtn = $('btn-reload');
    if (reloadBtn) reloadBtn.style.display = 'none';
    setButtonsEnabled({ download: true, series: !!response.isSeries });
    updateLanguageDropdowns(response.langList);
  }
}

function showReloadRequired(tabId) {
  $('status').textContent = 'Reload the Netflix page to activate.';
  $('status').style.color = '#e50914';
  setButtonsEnabled({ download: false, series: false });
  showReloadButton(tabId);
}

function handleStatus(tab) {
  chrome.tabs.sendMessage(tab.id, { action: 'getStatus' }, response => {
    if (chrome.runtime.lastError || !response) {
      // Try programmatic injection if content script was not already in page
      if (chrome.scripting && chrome.scripting.executeScript) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['lib/jszip.min.js', 'lib/FileSaver.min.js', 'epub.js', 'content.js']
        }).then(() => {
          chrome.tabs.sendMessage(tab.id, { action: 'getStatus' }, retryResp => {
            if (chrome.runtime.lastError || !retryResp) {
              showReloadRequired(tab.id);
            } else {
              applyStatus(retryResp, tab.id);
            }
          });
        }).catch(() => {
          showReloadRequired(tab.id);
        });
      } else {
        showReloadRequired(tab.id);
      }
      return;
    }

    applyStatus(response, tab.id);
  });
}

chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
  if (!tabs || !tabs[0] || !tabs[0].url || !tabs[0].url.includes('netflix.com')) {
    $('status').textContent = 'Navigate to Netflix to use this extension.';
    $('status').style.color = '#999';
    setButtonsEnabled({ download: false, series: false });
    return;
  }
  handleStatus(tabs[0]);
});
