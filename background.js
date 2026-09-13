// Background service worker: handles file downloads via chrome.downloads API.
// This guarantees that files are saved with their proper filename and extension (e.g. .epub, .zip, .srt),
// bypassing Chrome's restrictions on synthetic DOM anchor downloads in content scripts.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'downloadFile') {
    const filename = msg.filename || 'download';
    chrome.downloads.download({
      url: msg.url,
      filename: filename,
      saveAs: false
    }, downloadId => {
      if (chrome.runtime.lastError) {
        console.warn('[NSD Background] chrome.downloads error:', chrome.runtime.lastError.message);
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        console.log('[NSD Background] Download started successfully. ID:', downloadId, 'Filename:', filename);
        sendResponse({ ok: true, downloadId });
      }
    });
    return true; // Keep message channel open for async response
  }
});
