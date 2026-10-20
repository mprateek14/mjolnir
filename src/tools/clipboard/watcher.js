'use strict';
// Reads the system clipboard and says what is new on it. Electron has no "clipboard changed" event, so the
// Clipboard tool asks every second or so. poll() is cheap when nothing changed.
//
// What is picked up
//  - text
//  - an image on the clipboard (a screenshot, "copy image" in a browser)
//  - an image FILE copied in File Explorer: the file's own bytes are kept, so a GIF stays a GIF and keeps moving
// Left out on purpose
//  - anything a password manager marked as private (Windows' "exclude from clipboard history" flag)
//  - files that are not images (nothing to show or paste back yet)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

const IMAGE_FILES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.avif': 'image/avif', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic',
};
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' };

const sha1 = (v) => crypto.createHash('sha1').update(v).digest('hex');

class ClipboardWatcher {
  // clipboard: Electron's (read() gives ClipboardItems whose getType() gives Blobs). nativeImage: for picture sizes.
  constructor({ clipboard, nativeImage, maxBytes }) {
    this.cb = clipboard;
    this.ni = nativeImage;
    this.maxBytes = maxBytes;
    this.last = null;      // what we saw on the previous look
  }

  // A cheap fingerprint of what is on the clipboard now, plus the pieces needed to store it.
  async look() {
    let items;
    try { items = await this.cb.read(); } catch { return { sig: 'unreadable' }; }
    const types = new Set(items.flatMap((i) => i.types));
    const get = async (t) => {
      for (const it of items) {
        if (it.types.includes(t)) return Buffer.from(await (await it.getType(t)).arrayBuffer());
      }
      return null;
    };

    // Set by password managers so clipboard managers leave the copy alone.
    if ([...types].some((t) => t.includes('ExcludeClipboardContentFromMonitorProcessing'))) return { sig: 'private', private: true };

    // Files copied in File Explorer show up as file addresses.
    if (types.has('text/uri-list')) {
      const raw = (await get('text/uri-list')).toString('utf8');
      const files = raw.split(/\r?\n/).filter((l) => /^file:/i.test(l)).map((l) => { try { return fileURLToPath(l); } catch { return ''; } }).filter(Boolean);
      if (files.length) return { sig: 'file:' + files.join('|'), files };
    }
    if (types.has('text/plain')) {
      const text = (await get('text/plain')).toString('utf8');
      if (text.trim()) return { sig: 'text:' + sha1(text), text };
    }
    const imgType = types.has('image/png') ? 'image/png' : [...types].find((t) => t.startsWith('image/'));
    if (imgType) {
      const bytes = await get(imgType);
      if (bytes && bytes.length) return { sig: `image:${bytes.length}:${sha1(bytes)}`, bytes, mime: imgType };
    }
    return { sig: 'empty' };
  }

  // The system clipboard just got something from us: do not treat it as a new copy.
  async markOwn() { try { this.last = (await this.look()).sig; } catch { this.last = null; } }

  // Returns null when nothing changed, otherwise { capture } to store, or { skipped: why, ... }.
  async poll() {
    const now = await this.look();
    if (now.sig === this.last) return null;
    this.last = now.sig;
    if (now.sig === 'empty' || now.sig === 'unreadable') return null;
    if (now.private) return { skipped: 'private' };

    if (now.files) {
      // several files: the first picture among them
      let skip = null;
      for (const f of now.files) {
        const r = this.fromFile(f);
        if (r && r.capture) return r;
        if (r && !skip) skip = r;
      }
      return skip;
    }
    if (now.text) {
      const bytes = Buffer.from(now.text, 'utf8');
      if (bytes.length > this.maxBytes) return { skipped: 'too-large', kind: 'text', size: bytes.length };
      return {
        capture: {
          kind: 'text', bytes, ext: 'txt', mime: 'text/plain', chars: now.text.length,
          preview: now.text.length > 600 ? now.text.slice(0, 600) : now.text,
        },
      };
    }
    if (now.bytes) {
      if (now.bytes.length > this.maxBytes) return { skipped: 'too-large', kind: 'image', size: now.bytes.length };
      let width = 0, height = 0;
      try { ({ width, height } = this.ni.createFromBuffer(now.bytes).getSize()); } catch { /* a type Electron cannot read */ }
      return { capture: { kind: 'image', bytes: now.bytes, ext: MIME_EXT[now.mime] || 'png', mime: now.mime, width, height } };
    }
    return null;
  }

  fromFile(file) {
    const ext = path.extname(file).toLowerCase();
    const mime = IMAGE_FILES[ext];
    if (!mime) return { skipped: 'not-image', name: path.basename(file) };
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    if (!st.isFile()) return null;
    if (st.size > this.maxBytes) return { skipped: 'too-large', kind: 'image', size: st.size, name: path.basename(file) };
    let bytes;
    try { bytes = fs.readFileSync(file); } catch { return null; }
    let width = 0, height = 0;
    try { ({ width, height } = this.ni.createFromBuffer(bytes).getSize()); } catch { /* a type Electron cannot read, still kept */ }
    return { capture: { kind: 'image', bytes, ext: ext.slice(1) === 'jpeg' ? 'jpg' : ext.slice(1), mime, width, height, name: path.basename(file) } };
  }
}

module.exports = { ClipboardWatcher, IMAGE_FILES };
