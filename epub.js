// epub.js — WebVTT parser + dual-language merger + EPUB3 generator
// Ported from the Swift WebVTTConverter app.

// ========== WebVTT Parser ==========

function parseVTT(text) {
  // Strip BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const lines = text.split(/\r?\n/);
  if (!lines.length || !lines[0].startsWith('WEBVTT')) return [];

  const captions = [];
  let current = null;
  let foundTimeline = false;
  let skipHeader = true;

  for (const line of lines) {
    const trimmed = line.trim();

    if (skipHeader) {
      if (trimmed === '') skipHeader = false;
      continue;
    }

    if (trimmed.startsWith('NOTE') || trimmed.startsWith('STYLE')) {
      current = null;
      foundTimeline = false;
      continue;
    }

    if (trimmed.includes('-->')) {
      const parts = trimmed.split('-->');
      if (parts.length < 2) continue;
      const startStr = parts[0].trim();
      const endStr = parts[1].trim().split(/\s/)[0];
      const start = parseTimestamp(startStr);
      const end = parseTimestamp(endStr);
      if (start === null || end === null) continue;

      if (current && current.text) captions.push(current);
      current = { start, end, text: '' };
      foundTimeline = true;
    } else if (trimmed === '') {
      if (current && foundTimeline && current.text) {
        captions.push(current);
        current = null;
        foundTimeline = false;
      }
    } else if (foundTimeline && current) {
      // Strip WebVTT cue tags: <c.bg_transparent>, <i>, </c.traditionalchinese>, etc.
      const cleaned = trimmed.replace(/<[^>]*>/g, '');
      if (cleaned) {
        current.text += (current.text ? '\n' : '') + cleaned;
      }
    }
  }

  if (current && current.text) captions.push(current);
  return captions;
}

// Parse "HH:MM:SS.mmm" or "MM:SS.mmm" to milliseconds
function parseTimestamp(str) {
  const parts = str.split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1].replace(',', '.');
  const secParts = last.split('.');
  if (secParts.length !== 2) return null;
  const seconds = parseInt(secParts[0], 10);
  const millis = parseInt(secParts[1], 10);
  if (isNaN(seconds) || isNaN(millis)) return null;

  if (parts.length === 3) {
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    return (h * 3600 + m * 60 + seconds) * 1000 + millis;
  } else {
    const m = parseInt(parts[0], 10);
    return (m * 60 + seconds) * 1000 + millis;
  }
}

// ========== Shared Caption Alignment (Maximum Temporal Overlap) ==========

function calcOverlap(startA, endA, startB, endB) {
  const s = Math.max(startA, startB);
  const e = Math.min(endA, endB);
  return Math.max(0, e - s);
}

// Aligns secondary captions against primary captions based on maximum temporal overlap.
// Returns an array of items: [{ start, end, mainText, subTexts: string[] }]
function alignCaptions(mainCaptions, subCaptions) {
  if (!subCaptions || subCaptions.length === 0) {
    return mainCaptions.map(m => ({
      start: m.start,
      end: m.end,
      mainText: m.text,
      subTexts: []
    }));
  }

  const assigned = new Map();
  const standaloneSubs = [];

  for (const s of subCaptions) {
    let bestMainIdx = -1;
    let maxOverlap = 0;

    for (let i = 0; i < mainCaptions.length; i++) {
      const m = mainCaptions[i];
      const ov = calcOverlap(s.start, s.end, m.start, m.end);
      if (ov > maxOverlap) {
        maxOverlap = ov;
        bestMainIdx = i;
      }
    }

    const sDuration = Math.max(1, s.end - s.start);
    if (bestMainIdx !== -1 && (maxOverlap >= 150 || (maxOverlap / sDuration) >= 0.15)) {
      if (!assigned.has(bestMainIdx)) assigned.set(bestMainIdx, []);
      assigned.get(bestMainIdx).push(s);
    } else {
      standaloneSubs.push(s);
    }
  }

  const allItems = [];

  for (let i = 0; i < mainCaptions.length; i++) {
    const m = mainCaptions[i];
    const matching = assigned.get(i) || [];
    allItems.push({
      start: m.start,
      end: m.end,
      mainText: m.text,
      subTexts: matching.map(s => s.text)
    });
  }

  for (const s of standaloneSubs) {
    allItems.push({
      start: s.start,
      end: s.end,
      mainText: '',
      subTexts: [s.text]
    });
  }

  allItems.sort((a, b) => a.start - b.start || a.end - b.end);
  return allItems;
}

// ========== Dual-language EPUB HTML generator ==========

function cleanSubtitleText(str) {
  if (!str) return '';
  return str
    .replace(/&lrm;|&rlm;/gi, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSoundDescription(text) {
  if (!text) return false;
  const t = text.trim();
  return (t.startsWith('[') && t.endsWith(']')) ||
         (t.startsWith('(') && t.endsWith(')')) ||
         (t.startsWith('♪') && t.endsWith('♪')) ||
         (t.startsWith('#') && t.endsWith('#'));
}

function mergeSubtitles(mainCaptions, subCaptions) {
  if (!subCaptions || subCaptions.length === 0) {
    // Single language
    let html = '<div class="dialogue-container single">\n';
    let lastStart = 0;
    for (const c of mainCaptions) {
      if (c.start > lastStart + 5000 && lastStart > 0) {
        html += '<hr class="break" />\n';
      }
      lastStart = c.start;

      const clean = cleanSubtitleText(c.text);
      if (!clean) continue;
      const ccClass = isSoundDescription(clean) ? ' cc' : '';
      html += `<p class="main${ccClass}">${escapeHTML(clean)}</p>\n`;
    }
    html += '</div>\n';
    return html;
  }

  const allItems = alignCaptions(mainCaptions, subCaptions);

  let html = '<div class="dialogue-container dual">\n';
  let lastStart = 0;
  for (const item of allItems) {
    // Paragraph break for gaps > 5 seconds
    if (item.start > lastStart + 5000 && lastStart > 0) {
      html += '<hr class="break" />\n';
    }
    lastStart = item.start;

    const mainClean = cleanSubtitleText(item.mainText);
    const subClean = item.subTexts && item.subTexts.length > 0
      ? cleanSubtitleText(item.subTexts.join(' '))
      : '';

    if (mainClean) {
      const ccClass = isSoundDescription(mainClean) ? ' cc' : '';
      html += `<div class="main${ccClass}">${escapeHTML(mainClean)}</div>\n`;
    }
    if (subClean) {
      const ccClass = isSoundDescription(subClean) ? ' cc' : '';
      html += `<div class="sub${ccClass}">${escapeHTML(subClean)}</div>\n`;
    }
  }
  html += '</div>\n';

  return html;
}

function escapeHTML(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeXML(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ========== EPUB3 Generator ==========

// coverData: { data: Uint8Array, mediaType: 'image/jpeg'|'image/png', ext: 'jpg'|'png' } or null
function generateEPUB(title, chapters, coverData) {
  const zip = new JSZip();
  const uuid = crypto.randomUUID();
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const hasCover = coverData && coverData.data;

  // 1. mimetype (must be first — JSZip doesn't guarantee order, but EPUB readers are lenient)
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  // 2. META-INF/container.xml
  zip.file('META-INF/container.xml',
`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  // 3. Stylesheet (Theme-friendly, supports Light, Dark, and Sepia modes in all readers)
  zip.file('OEBPS/stylesheet.css',
`body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Georgia, serif;
  margin: 1.2em;
  line-height: 1.6;
}
h1 {
  text-align: center;
  margin-top: 1.5em;
  margin-bottom: 1.2em;
}
.main {
  font-size: 1.05em;
  margin-top: 0.7em;
  margin-bottom: 0.2em;
}
.single .main {
  font-weight: normal;
  line-height: 1.5;
}
.dual .main {
  font-weight: 600;
}
.sub {
  font-size: 0.92em;
  opacity: 0.75;
  margin-left: 0.8em;
  margin-bottom: 1em;
  font-style: italic;
}
.cc {
  font-style: italic;
  opacity: 0.7;
}
.break {
  margin: 1.8em auto;
  width: 40%;
  border: none;
  border-top: 1px dashed rgba(128, 128, 128, 0.4);
}
.cover-page {
  text-align: center;
  page-break-after: always;
}
.cover-page img {
  max-width: 100%;
  max-height: 100%;
}`);

  // 4. Cover image + cover page
  if (hasCover) {
    zip.file(`OEBPS/images/cover.${coverData.ext}`, coverData.data, { binary: true });
    zip.file('OEBPS/cover.xhtml',
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>Cover</title>
  <link rel="stylesheet" type="text/css" href="stylesheet.css"/>
</head>
<body>
  <div class="cover-page">
    <img src="images/cover.${coverData.ext}" alt="Cover"/>
  </div>
</body>
</html>`);
  }

  // 5. Chapter XHTML files
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    zip.file(`OEBPS/chapter${i + 1}.xhtml`,
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>${escapeXML(ch.title)}</title>
  <link rel="stylesheet" type="text/css" href="stylesheet.css"/>
</head>
<body>
  <h1>${escapeXML(ch.title)}</h1>
  ${ch.html}
</body>
</html>`);
  }

  // 6. content.opf
  let manifestItems = '';
  let spineItems = '';

  if (hasCover) {
    manifestItems += `    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>\n`;
    manifestItems += `    <item id="cover-image" href="images/cover.${coverData.ext}" media-type="${coverData.mediaType}" properties="cover-image"/>\n`;
    spineItems += `    <itemref idref="cover"/>\n`;
  }

  manifestItems += `    <item id="css" href="stylesheet.css" media-type="text/css"/>\n`;
  manifestItems += `    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n`;
  for (let i = 0; i < chapters.length; i++) {
    manifestItems += `    <item id="chapter${i + 1}" href="chapter${i + 1}.xhtml" media-type="application/xhtml+xml"/>\n`;
    spineItems += `    <itemref idref="chapter${i + 1}"/>\n`;
  }

  zip.file('OEBPS/content.opf',
`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:${uuid}</dc:identifier>
    <dc:title>${escapeXML(title)}</dc:title>
    <dc:creator>Netflix Subtitle Downloader</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${now}</meta>
  </metadata>
  <manifest>
${manifestItems}  </manifest>
  <spine>
${spineItems}  </spine>
</package>`);

  // 7. nav.xhtml (Table of Contents)
  let tocItems = '';
  if (hasCover) {
    tocItems += `      <li><a href="cover.xhtml">Cover</a></li>\n`;
  }
  for (let i = 0; i < chapters.length; i++) {
    tocItems += `      <li><a href="chapter${i + 1}.xhtml">${escapeXML(chapters[i].title)}</a></li>\n`;
  }

  zip.file('OEBPS/nav.xhtml',
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Table of Contents</title>
</head>
<body>
  <nav epub:type="toc">
    <h1>Table of Contents</h1>
    <ol>
${tocItems}    </ol>
  </nav>
</body>
</html>`);

  return zip;
}
