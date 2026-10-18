'use strict';
// A port of screener_downloader.py. Page parsing, file names, folder layout and the "save a link instead" rule
// follow that script on purpose, so files land exactly where the script would have put them.
// If screener.in changes its page, this is the only file to touch. No Electron imports.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const cheerio = require('cheerio');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const os = require('os');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const BASE_URL = 'https://www.screener.in';

// Maps a response Content-Type to a file extension trusted enough to save as a binary file.
const CONTENT_TYPE_EXTENSIONS = {
  'application/pdf': '.pdf',
  'application/octet-stream': '.pdf',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'video/mp4': '.mp4',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/zip': '.zip',
};
const URL_EXTENSIONS = new Set(['.pdf', '.mp3', '.mp4', '.wav', '.doc', '.docx', '.xls', '.xlsx', '.zip']);
const ILLEGAL = /[<>:"/\\|?*\x00-\x1f]/g;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

// ---- naming ------------------------------------------------------------------------

function sanitizeFilename(name, maxLen = 150) {
  let s = String(name).replace(ILLEGAL, '');
  s = s.trim().replace(/\s+/g, '_');
  s = s.replace(/^[._]+|[._]+$/g, '');
  if (!s) s = 'file';
  return s.slice(0, maxLen);
}

// name.ext -> name_2.ext, name_3.ext ... when something is already there.
function uniquePath(file) {
  if (!fs.existsSync(file)) return file;
  const ext = path.extname(file);
  const stem = path.basename(file, ext);
  const dir = path.dirname(file);
  for (let n = 2; ; n++) {
    const candidate = path.join(dir, `${stem}_${n}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function extensionFromUrl(url) {
  let p;
  try { p = new URL(url).pathname; } catch { return ''; }
  const ext = path.posix.extname(p).toLowerCase();
  return URL_EXTENSIONS.has(ext) ? ext : '';
}

// A ticker from a bare name or from a screener.in company link.
function parseInput(target) {
  target = String(target || '').trim();
  if (/^https?:\/\//i.test(target)) {
    const m = /\/company\/([^/]+)\//.exec(target);
    if (!m) throw new Error(`Could not find a ticker in the URL: ${target}`);
    return decodeURIComponent(m[1]).toUpperCase();
  }
  return target.toUpperCase();
}

// ---- parsing -----------------------------------------------------------------------
// BeautifulSoup's get_text(strip=True) joins the stripped text pieces with nothing between them.

function pieces($, el) {
  const out = [];
  const walk = (node) => {
    for (const c of node.children || []) {
      if (c.type === 'text') { const t = c.data.trim(); if (t) out.push(t); } else if (c.type === 'tag') walk(c);
    }
  };
  walk(el);
  return out;
}
const textOf = ($, el) => pieces($, el).join('');

function parseAnnualReports($) {
  const items = [];
  const box = $('div.annual-reports').first();
  if (!box.length) return items;
  box.find('ul.list-links > li').each((_, li) => {
    const a = $(li).find('a[href]').first();
    if (!a.length) return;
    const label = textOf($, a[0]);
    const m = /(\d{4})/.exec(label);
    const year = m ? m[1] : sanitizeFilename(label);
    items.push({ url: a.attr('href'), name: `Annual_Report_${year}` });
  });
  return items;
}

function parseCreditRatings($) {
  const items = [];
  const box = $('div.credit-ratings').first();
  if (!box.length) return items;
  box.find('ul.list-links > li').each((_, li) => {
    const a = $(li).find('a[href]').first();
    if (!a.length) return;
    const strings = pieces($, a[0]);
    const title = strings.length ? strings[0] : 'Rating';
    const detail = strings.length > 1 ? strings[1] : '';
    // detail looks like "9 Apr from care" or "10 Oct 2025 from care"
    const i = detail.indexOf(' from ');
    const datePart = (i < 0 ? detail : detail.slice(0, i)).trim().replace(/ /g, '');
    const agency = i < 0 ? '' : detail.slice(i + 6).trim();
    const name = [title, datePart, agency].filter(Boolean).join('_');
    items.push({ url: a.attr('href'), name: name || 'Credit_Rating' });
  });
  return items;
}

function parseConcalls($) {
  const items = [];
  const box = $('div.concalls').first();
  if (!box.length) return items;
  box.find('ul.list-links > li').each((_, li) => {
    const dateDiv = $(li).find('div.nowrap').first();
    const period = dateDiv.length ? textOf($, dateDiv[0]) : 'Unknown_Period';
    const m = /^([A-Za-z]+)\s*(\d{4})$/.exec(period.trim());
    const periodClean = m ? `${m[2]}${m[1]}` : period.replace(/ /g, '');
    $(li).find('a.button-chip[href]').each((__, a) => {
      const kind = textOf($, a) || 'Document';
      items.push({ url: $(a).attr('href'), name: `${sanitizeFilename(kind)}_${periodClean}_Concall` });
    });
  });
  return items;
}

// Folder names match the script: <ticker>/Annual Reports, Credit Ratings, Concalls.
const SECTIONS = [
  { name: 'Annual Reports', parse: parseAnnualReports },
  { name: 'Credit Ratings', parse: parseCreditRatings },
  { name: 'Concalls', parse: parseConcalls },
];

function parsePage(html, pageUrl) {
  const $ = cheerio.load(html);
  const abs = (u) => { try { return new URL(u, pageUrl).href; } catch { return u; } };
  const company = $('h1').first().text().trim();
  return {
    company,
    sections: SECTIONS.map((s) => ({ name: s.name, items: s.parse($).map((i) => ({ ...i, url: abs(i.url) })) })),
  };
}

// ---- network -----------------------------------------------------------------------

// One request with redirects. Uses Node's http client in lenient mode because some hosts (BSE India) send
// slightly malformed headers that fetch rejects and Python's requests accepts.
function once(url, signal, timeout) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, {
      method: 'GET', insecureHTTPParser: true, maxHeaderSize: 65536,
      headers: { 'user-agent': USER_AGENT, accept: '*/*', 'accept-encoding': 'gzip, deflate' },
    }, resolve);
    req.setTimeout(timeout, () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) return req.destroy(Object.assign(new Error('Cancelled'), { cancelled: true }));
      signal.addEventListener('abort', () => req.destroy(Object.assign(new Error('Cancelled'), { cancelled: true })), { once: true });
    }
    req.end();
  });
}

async function follow(url, signal, timeout) {
  let current = url;
  for (let hops = 0; hops < 20; hops++) {
    const res = await once(current, signal, timeout);
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      current = new URL(res.headers.location, current).href;
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects');
}

// Wraps the raw response: decoded body stream plus small helpers. Same retry shape as urllib3
// Retry(total=3, backoff_factor=1) on 429/500/502/503/504.
async function get(url, { signal, timeout = 30000, retries = 3 } = {}) {
  if (retries === undefined) retries = 3;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal && signal.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
    try {
      const raw = await follow(url, signal, timeout);
      if (RETRY_STATUS.has(raw.statusCode) && attempt < retries) {
        raw.resume();
        await sleep(1000 * 2 ** attempt, signal);
        continue;
      }
      const enc = String(raw.headers['content-encoding'] || '').toLowerCase();
      const stream = enc === 'gzip' ? raw.pipe(zlib.createGunzip()) : enc === 'deflate' ? raw.pipe(zlib.createInflate()) : raw;
      if (stream !== raw) raw.on('error', (e) => stream.destroy(e));
      const read = async () => { const parts = []; for await (const c of stream) parts.push(c); return Buffer.concat(parts); };
      return {
        status: raw.statusCode,
        headers: { get: (k) => { const v = raw.headers[k.toLowerCase()]; return Array.isArray(v) ? v[0] : v || null; } },
        stream,
        text: async () => (await read()).toString('utf8'),
        json: async () => JSON.parse((await read()).toString('utf8')),
        discard: () => { raw.destroy(); },
        __cleanup: () => {},
      };
    } catch (e) {
      if (e.cancelled || (signal && signal.aborted)) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      lastErr = e;
      if (attempt < retries) await sleep(1000 * 2 ** attempt, signal);
    }
  }
  throw lastErr;
}

// Prefers the consolidated view, then the standalone one, like the script.
async function fetchCompanyPage(ticker, { signal } = {}) {
  const tried = [];
  for (const suffix of ['consolidated/', '']) {
    const url = `${BASE_URL}/company/${encodeURIComponent(ticker)}/${suffix}`;
    try {
      const res = await get(url, { signal });
      if (res.status === 200) {
        const html = await res.text();
        res.__cleanup();
        return { html, url, ...parsePage(html, url) };
      }
      res.discard();
      tried.push(`${url} replied ${res.status}`);
    } catch (e) {
      if (e.cancelled) throw e;
      tried.push(`${url} failed: ${e.message}`);
    }
  }
  throw new Error(`Could not load a screener.in page for "${ticker}". Check the ticker or link and try again.`);
}

async function search(q, { signal } = {}) {
  const res = await get(`${BASE_URL}/api/company/search/?q=${encodeURIComponent(q)}&v=3&fts=1`, { signal, retries: 1 });
  if (res.status !== 200) return [];
  const rows = await res.json();
  res.__cleanup();
  return rows
    .filter((r) => r.id && /\/company\//.test(r.url))
    .map((r) => ({ name: r.name, ticker: decodeURIComponent(/\/company\/([^/]+)\//.exec(r.url)[1]).toUpperCase() }));
}

function existingFile(dir, safeBase) {
  try {
    return fs.readdirSync(dir).find((n) => n.startsWith(safeBase + '.') && !n.endsWith('.part')) || null;
  } catch { return null; }
}

// Result is one of: downloaded, skipped, reference, failed.
async function downloadFile({ url, dir, baseName, force, delay, signal, onBytes, retries }) {
  await fsp.mkdir(dir, { recursive: true });
  const safeBase = sanitizeFilename(baseName);

  // Skip when any file with this base name exists, unless forced.
  if (!force) {
    const have = existingFile(dir, safeBase);
    if (have) return { result: 'skipped', file: path.join(dir, have) };
  }

  let res;
  try {
    res = await get(url, { signal, retries });
  } catch (e) {
    if (e.cancelled) throw e;
    return { result: 'failed', error: e.message };
  }
  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const urlExt = extensionFromUrl(url);
  const downloadable = res.status === 200 && (URL_EXTENSIONS.has(urlExt) || contentType in CONTENT_TYPE_EXTENSIONS);

  let out;
  if (downloadable) {
    const ext = urlExt || CONTENT_TYPE_EXTENSIONS[contentType] || '.pdf';
    const dest = uniquePath(path.join(dir, `${safeBase}${ext}`));
    const tmp = dest + '.part';
    try {
      const ws = fs.createWriteStream(tmp);
      let got = 0;
      let idle;
      const total = Number(res.headers.get('content-length')) || 0;
      const src = res.stream;
      const watchdog = () => { clearTimeout(idle); idle = setTimeout(() => src.destroy(new Error('Download stalled')), 30000); };
      watchdog();
      src.on('data', (c) => { got += c.length; watchdog(); onBytes && onBytes(got, total); });
      if (signal) signal.addEventListener('abort', () => src.destroy(Object.assign(new Error('Cancelled'), { cancelled: true })), { once: true });
      await new Promise((resolve, reject) => {
        src.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', resolve);
        src.pipe(ws);
      });
      clearTimeout(idle);
      await fsp.rename(tmp, dest);
      out = { result: 'downloaded', file: dest };
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      if (e.cancelled || (signal && signal.aborted)) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      return { result: 'failed', error: `could not save ${path.basename(dest)}: ${e.message}` };
    }
  } else {
    // Not a real file (login wall, overlay link, blocked...): keep the link instead.
    const dest = uniquePath(path.join(dir, `${safeBase}_LINK.txt`));
    await fsp.writeFile(dest, `Could not download a file directly (HTTP ${res.status}, Content-Type: ${contentType || 'unknown'}).\nOriginal link:\n${url}\n`, 'utf8');
    res.discard();
    out = { result: 'reference', file: dest };
  }
  res.__cleanup();
  if (delay) await sleep(delay * 1000, signal);
  return out;
}

module.exports = { parseInput, parsePage, parseAnnualReports, parseCreditRatings, parseConcalls, fetchCompanyPage, downloadFile, search, sanitizeFilename, uniquePath, extensionFromUrl, existingFile, SECTIONS, BASE_URL };
