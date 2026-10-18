'use strict';
const fs = require('fs');
const path = require('path');

const CATEGORIES = {
  Compressed: ['zip', '7z', 'rar', 'gz', 'tgz', 'bz2', 'xz', 'tar', 'iso', 'img', 'cab', 'z'],
  Documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'epub', 'csv', 'odt'],
  Music: ['mp3', 'aac', 'flac', 'wav', 'ogg', 'm4a', 'wma', 'opus'],
  Video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'flv', 'm4v', 'mpg', 'mpeg', '3gp', 'ts'],
  Programs: ['exe', 'msi', 'msu', 'apk', 'dmg', 'deb', 'rpm', 'appimage', 'bin'],
};

function categoryOf(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  for (const [cat, exts] of Object.entries(CATEGORIES)) if (exts.includes(ext)) return cat;
  return 'Other';
}

function sanitizeName(name) {
  let s = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = '_' + s;
  return s.slice(0, 200) || 'download';
}

function parseContentDisposition(header) {
  if (!header) return null;
  let m = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (m) {
    try { return decodeURIComponent(m[2].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ }
  }
  m = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header) || /filename\s*=\s*([^;]+)/i.exec(header);
  if (!m) return null;
  let v = m[1].trim();
  try { if (/%[0-9a-f]{2}/i.test(v)) v = decodeURIComponent(v); } catch { /* keep raw */ }
  return v;
}

function filenameFromUrl(u) {
  try {
    const url = new URL(u);
    const base = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
    return base || url.hostname;
  } catch {
    return 'download';
  }
}

// name.ext -> name (1).ext when something already exists at that path.
function uniquePath(dir, name, taken = () => false) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate) || taken(candidate); i++) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
  }
  return candidate;
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

// Token bucket that lets a chunk through and makes the caller wait out the debt.
class Limiter {
  constructor(rate = 0) { this.setRate(rate); }
  setRate(rate) { this.rate = rate > 0 ? rate : 0; this.next = Date.now(); }
  async take(n, signal) {
    if (!this.rate) return;
    const now = Date.now();
    if (this.next < now) this.next = now;
    const wait = this.next - now;
    this.next += (n / this.rate) * 1000;
    if (wait > 1) await sleep(wait, signal);
  }
}

module.exports = { categoryOf, sanitizeName, parseContentDisposition, filenameFromUrl, uniquePath, sleep, Limiter, CATEGORIES };
