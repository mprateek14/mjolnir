'use strict';
// The list behind the Clipboard tool: the last N things copied, newest-used first, kept on disk.
// Pure file handling, no Electron, so it can be tested on its own.
//
// Rules
//  - At most `max` items. When a new one arrives and the list is full, the least recently used one is dropped.
//  - Copying something that is already in the list does not add a second copy, it moves the old one to the top.
//  - Using an item (putting it back on the clipboard) also moves it to the top.
//  - An item bigger than `maxBytes` is never kept.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const MAX_ITEMS = 25;
const MAX_BYTES = 10 * 1024 * 1024;

class ClipStore {
  constructor({ dir, max = MAX_ITEMS, maxBytes = MAX_BYTES }) {
    this.dir = dir;
    this.max = max;
    this.maxBytes = maxBytes;
    this.items = [];   // index 0 is the most recently used
    this.indexFile = path.join(dir, 'index.json');
    this.itemsDir = path.join(dir, 'items');
  }

  async load() {
    await fsp.mkdir(this.itemsDir, { recursive: true });
    try {
      const raw = JSON.parse(await fsp.readFile(this.indexFile, 'utf8'));
      const kept = [];
      for (const it of raw.items || []) {
        if (it && it.id && fs.existsSync(this.filePath(it))) kept.push(it);   // ignore entries whose file went missing
      }
      this.items = kept.slice(0, this.max);
    } catch { this.items = []; }
    // files nobody points at any more (a crash between writing a file and the index)
    const known = new Set(this.items.map((i) => path.basename(this.filePath(i))));
    for (const f of await fsp.readdir(this.itemsDir).catch(() => [])) {
      if (!known.has(f)) await fsp.rm(path.join(this.itemsDir, f), { force: true }).catch(() => {});
    }
    await this.save();
  }

  filePath(item) { return path.join(this.itemsDir, `${item.id}.${item.ext}`); }
  find(id) { return this.items.find((i) => i.id === id) || null; }
  list() { return this.items.slice(); }

  async save() {
    const tmp = this.indexFile + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify({ items: this.items }));
    await fsp.rename(tmp, this.indexFile);
  }

  // c: { kind: 'text' | 'image', bytes: Buffer, ext, mime, preview?, width?, height?, name? }
  // Returns { item, isNew } or { skipped: 'too-large', size }.
  async add(c) {
    const size = c.bytes.length;
    if (size === 0) return { skipped: 'empty', size };
    if (size > this.maxBytes) return { skipped: 'too-large', size };
    const id = crypto.createHash('sha1').update(c.kind).update(c.bytes).digest('hex').slice(0, 20);
    const have = this.find(id);
    if (have) {
      await this.touch(id);
      return { item: this.find(id), isNew: false };
    }
    const item = {
      id, kind: c.kind, ext: c.ext, mime: c.mime, size, preview: c.preview || '', chars: c.chars || 0,
      width: c.width || 0, height: c.height || 0, name: c.name || '', createdAt: Date.now(), usedAt: Date.now(),
    };
    await fsp.writeFile(this.filePath(item), c.bytes);
    this.items.unshift(item);
    // the list is full: drop what was used longest ago
    while (this.items.length > this.max) {
      const old = this.items.pop();
      await fsp.rm(this.filePath(old), { force: true }).catch(() => {});
    }
    await this.save();
    return { item, isNew: true };
  }

  async touch(id) {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return null;
    const [it] = this.items.splice(i, 1);
    it.usedAt = Date.now();
    this.items.unshift(it);
    await this.save();
    return it;
  }

  async remove(id) {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    const [it] = this.items.splice(i, 1);
    await fsp.rm(this.filePath(it), { force: true }).catch(() => {});
    await this.save();
    return true;
  }

  async clear() {
    for (const it of this.items) await fsp.rm(this.filePath(it), { force: true }).catch(() => {});
    this.items = [];
    await this.save();
  }

  async readBytes(id) {
    const it = this.find(id);
    return it ? fsp.readFile(this.filePath(it)) : null;
  }
}

module.exports = { ClipStore, MAX_ITEMS, MAX_BYTES };
