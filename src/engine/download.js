'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { request } = require('./http');
const { parseContentDisposition, filenameFromUrl, sanitizeName, uniquePath, sleep, Limiter, categoryOf } = require('./util');

const MIN_SPLIT = 256 * 1024; // a segment is only split while it has at least 2x this left
const MAX_RETRIES = 8;
const FATAL = new Set([400, 401, 403, 404, 405, 410, 451]);

const FILE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'pdf', 'zip', '7z', 'rar', 'gz', 'tgz', 'bz2', 'xz', 'tar', 'iso', 'exe', 'msi', 'dmg', 'apk', 'deb', 'rpm',
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'epub', 'torrent']);
function looksLikeFile(u) {
  try { return FILE_EXT.has(path.extname(new URL(u).pathname).slice(1).toLowerCase()); } catch { return false; }
}

class Restart extends Error {}
class Fatal extends Error {
  constructor(m) { super(m); this.fatal = true; }
}

class Download extends EventEmitter {
  constructor(init, { globalLimiter, isTaken = () => false }) {
    super();
    Object.assign(this, {
      id: crypto.randomUUID(), url: '', finalUrl: '', filename: '', dir: '', size: -1,
      resumable: false, etag: '', lastModified: '', mime: '', segments: [], status: 'queued',
      error: '', connections: 8, headers: {}, addedAt: Date.now(), completedAt: 0, lastTriedAt: 0,
      category: 'Other', checksum: '', speedLimit: 0, retries: 0, comment: '', autoSort: false,
    }, init);
    this.downloaded = 0;
    this.speed = 0;
    this.global = globalLimiter;
    this.isTaken = isTaken;
    this.own = new Limiter(this.speedLimit);
    this.active = new Set();
    this.fh = null;
    this.ac = null;
    this.effMax = this.connections;
    this.retryable = true;
    this.streaming = 0;
    this._lastBytes = 0;
    this._lastT = Date.now();
    this._restarts = 0;
    this.recount();
  }

  get partPath() { return path.join(this.dir, this.filename + '.part'); }
  get finalPath() { return path.join(this.dir, this.filename); }

  recount() { this.downloaded = this.segments.reduce((a, s) => a + (s.pos - s.start), 0); }

  toJSON() {
    const { id, url, finalUrl, filename, dir, size, resumable, etag, lastModified, mime, segments, status, error, connections,
      headers, addedAt, completedAt, lastTriedAt, category, checksum, speedLimit, retries, comment, autoSort } = this;
    return { id, url, finalUrl, filename, dir, size, resumable, etag, lastModified, mime, segments, status, error, connections,
      headers, addedAt, completedAt, lastTriedAt, category, checksum, speedLimit, retries, comment, autoSort };
  }

  snapshot() {
    const left = this.size > 0 ? this.size - this.downloaded : 0;
    return {
      id: this.id, url: this.url, filename: this.filename, dir: this.dir, size: this.size, downloaded: this.downloaded,
      status: this.status, error: this.error, speed: this.status === 'downloading' ? this.speed : 0,
      eta: this.speed > 1 && left > 0 ? left / this.speed : 0, resumable: this.resumable,
      connections: this.active.size, maxConnections: this.connections, category: this.category,
      addedAt: this.addedAt, completedAt: this.completedAt, lastTriedAt: this.lastTriedAt, mime: this.mime, speedLimit: this.speedLimit,
      segments: this.segments.map((s) => [s.start, s.end, s.pos]), checksum: this.checksum, comment: this.comment,
    };
  }

  // Throughput sample; the manager calls this on its tick.
  tick() {
    const now = Date.now();
    const dt = (now - this._lastT) / 1000;
    if (dt < 0.2) return;
    const inst = (this.downloaded - this._lastBytes) / dt;
    this.speed = this.speed ? this.speed * 0.6 + inst * 0.4 : inst;
    this._lastBytes = this.downloaded;
    this._lastT = now;
  }

  // A 1-byte ranged GET tells us size, range support, validators and filename in one round trip.
  async probe() {
    const headers = { ...this.headers, range: 'bytes=0-0' };
    const ac = new AbortController();
    const { res, url } = await request(this.url, { headers, signal: ac.signal });
    const h = res.headers;
    res.resume();
    ac.abort();
    if (res.statusCode >= 400) {
      throw Object.assign(new Error(`Server replied ${res.statusCode} ${res.statusMessage || ''}`.trim()), {
        status: res.statusCode, fatal: FATAL.has(res.statusCode),
      });
    }
    this.finalUrl = url;
    this.mime = (h['content-type'] || '').split(';')[0].trim();
    // A link that looks like a file but answers with a web page is almost always a login wall, a
    // hotlink block or an expired link. Saving that page under the file's name would look like success.
    if (this.mime === 'text/html' && looksLikeFile(this.url)) {
      throw Object.assign(new Error('The server sent a web page instead of the file. The link may need a login, a Referrer, or may have expired.'), { fatal: true });
    }
    this.etag = h.etag && !h.etag.startsWith('W/') ? h.etag : '';
    this.lastModified = h['last-modified'] || '';
    if (res.statusCode === 206) {
      const m = /\/(\d+|\*)$/.exec(h['content-range'] || '');
      this.size = m && m[1] !== '*' ? Number(m[1]) : -1;
      this.resumable = this.size > 0;
    } else {
      this.size = h['content-length'] !== undefined ? Number(h['content-length']) : -1;
      this.resumable = false;
    }
    if (!this.filename) {
      const name = parseContentDisposition(h['content-disposition']) || filenameFromUrl(this.finalUrl || this.url);
      this.filename = sanitizeName(name);
    }
    return this.snapshot();
  }

  buildSegments() {
    if (!this.resumable || this.size <= 0) {
      this.segments = [{ start: 0, end: this.size > 0 ? this.size - 1 : Number.MAX_SAFE_INTEGER, pos: 0 }];
      return;
    }
    const n = Math.max(1, Math.min(this.connections, Math.floor(this.size / MIN_SPLIT)));
    const step = Math.ceil(this.size / n);
    this.segments = [];
    for (let i = 0; i < n; i++) {
      const start = i * step;
      const end = Math.min(this.size - 1, start + step - 1);
      if (start <= end) this.segments.push({ start, end, pos: start });
    }
  }

  async start() {
    if (this.status === 'downloading') return;
    this.status = 'downloading';
    this.lastTriedAt = Date.now();   // whatever happens next, this is the last time we tried
    this.error = '';
    this.retryable = true;
    this.ac = new AbortController();
    const { signal } = this.ac;
    this.effMax = this.connections;
    this._lastBytes = this.downloaded;
    this._lastT = Date.now();
    this.speed = 0;
    this.emit('state');
    try {
      if (!this.segments.length || !this.filename) {
        await this.probe();
        if (signal.aborted) return;
        this.buildSegments();
        this.category = categoryOf(this.filename);
        if (this.autoSort) { this.dir = path.join(this.dir, this.category); this.autoSort = false; }
        this.filename = path.basename(uniquePath(this.dir, this.filename, (p) => this.isTaken(p, this)));
      }
      await fsp.mkdir(this.dir, { recursive: true });
      await this.openFile();
      if (signal.aborted) { await this.closeFile(); return; }
      this.pump();
      if (!this.active.size) this.checkDone();
    } catch (e) {
      if (signal.aborted) return;
      this.fail(e);
    }
  }

  async openFile() {
    let existing = false;
    try { existing = (await fsp.stat(this.partPath)).isFile(); } catch { /* no part file yet */ }
    if (!existing && this.downloaded > 0) this.resetSegments(); // user deleted the .part file
    this.fh = await fsp.open(this.partPath, existing ? 'r+' : 'w+');
    if (!existing && this.size > 0) await this.fh.truncate(this.size); // preallocate to avoid fragmentation
  }

  resetSegments() {
    this.buildSegments();
    this.recount();
    this._lastBytes = 0;
  }

  pickSegment() {
    const idle = this.segments.find((s) => s.pos <= s.end && !this.active.has(s));
    if (idle) return idle;
    if (!this.resumable) return null;
    // Dynamic segmentation: a free connection takes the top half of whichever segment has the most left.
    let best = null;
    for (const s of this.active) {
      const rem = s.end - s.pos + 1;
      if (rem >= MIN_SPLIT * 2 && (!best || rem > best.end - best.pos + 1)) best = s;
    }
    if (!best) return null;
    const mid = best.pos + Math.floor((best.end - best.pos + 1) / 2);
    const fresh = { start: mid, end: best.end, pos: mid };
    best.end = mid - 1;
    this.segments.push(fresh);
    this.segments.sort((a, b) => a.start - b.start);
    return fresh;
  }

  pump() {
    const { signal } = this.ac;
    while (!signal.aborted && this.active.size < this.effMax) {
      const seg = this.pickSegment();
      if (!seg) break;
      this.active.add(seg);
      this.runSegment(seg, signal)
        .catch((e) => { if (!signal.aborted) this.handleFailure(e); })
        .finally(() => {
          this.active.delete(seg);
          if (signal.aborted || this.status !== 'downloading') return;
          this.pump();
          if (!this.active.size) this.checkDone();
        });
    }
  }

  handleFailure(e) {
    if (e instanceof Restart && this._restarts++ < 1) this.restart();
    else this.fail(e);
  }

  // The server changed under us or ignores ranges. Start over with one plain connection.
  async restart() {
    this.ac.abort();
    await this.settle();
    this.resumable = false;
    this.resetSegments();
    this.segments = [{ start: 0, end: this.size > 0 ? this.size - 1 : Number.MAX_SAFE_INTEGER, pos: 0 }];
    this.recount();
    await this.fh?.truncate(0).catch(() => {});
    await this.closeFile();
    this.status = 'queued';
    this.emit('requeue');
  }

  async runSegment(seg, signal) {
    let attempt = 0;
    while (!signal.aborted && seg.pos <= seg.end) {
      try {
        await this.fetchRange(seg, signal);
        return;
      } catch (e) {
        if (signal.aborted || e.aborted) return;
        if (e.fatal || e instanceof Restart) throw e;
        // Server is pushing back on parallel connections: give up one slot and let a sibling take over.
        if ((e.status === 429 || e.status === 503) && this.active.size > 1) {
          this.effMax = Math.max(2, this.streaming);
          this.throttledAt = Date.now();
          return;
        }
        if (++attempt > MAX_RETRIES) throw e;
        await sleep(Math.min(15000, 500 * 2 ** attempt), signal);
      }
    }
  }

  async fetchRange(seg, signal) {
    const headers = { ...this.headers };
    const ranged = this.resumable;
    if (ranged) {
      headers.range = `bytes=${seg.pos}-${seg.end}`;
      const validator = this.etag || this.lastModified;
      if (validator) headers['if-range'] = validator;
    }
    const { res } = await request(this.finalUrl || this.url, { headers, signal });
    const code = res.statusCode;
    if (code >= 400) {
      res.resume();
      throw Object.assign(new Error(`Server replied ${code} ${res.statusMessage || ''}`.trim()), {
        status: code, fatal: FATAL.has(code) || code === 416,
      });
    }
    if (ranged) {
      if (code !== 206) { res.resume(); throw new Restart('Server ignored the range request'); }
      const m = /bytes (\d+)-/.exec(res.headers['content-range'] || '');
      if (!m || Number(m[1]) !== seg.pos) { res.resume(); throw new Restart('Unexpected range in reply'); }
    }
    const onAbort = () => res.destroy();
    signal.addEventListener('abort', onAbort, { once: true });
    this.streaming++;
    try {
      for await (let chunk of res) {
        if (signal.aborted) return;
        const room = seg.end - seg.pos + 1;
        if (room <= 0) { res.destroy(); return; } // a sibling took the rest of this range
        if (chunk.length > room) chunk = chunk.subarray(0, room);
        await Promise.all([this.global.take(chunk.length, signal), this.own.take(chunk.length, signal)]);
        if (signal.aborted) return;
        await this.fh.write(chunk, 0, chunk.length, seg.pos);
        seg.pos += chunk.length;
        this.downloaded += chunk.length;
        if (seg.pos > seg.end) { res.destroy(); return; }
      }
    } catch (e) {
      if (signal.aborted || seg.pos > seg.end) return;
      throw e;
    } finally {
      this.streaming--;
      signal.removeEventListener('abort', onAbort);
    }
    // A stream of unknown length ends when the server says so.
    if (this.size <= 0) {
      seg.end = seg.pos - 1;
      this.size = this.downloaded;
      return;
    }
    if (seg.pos <= seg.end && !signal.aborted) throw new Error('Connection closed early');
  }

  async checkDone() {
    if (this.status !== 'downloading' || this._finishing) return;
    if (this.segments.some((s) => s.pos <= s.end)) {
      if (!this.active.size) this.fail(new Error('Download stalled with segments left'));
      return;
    }
    this._finishing = true;
    try {
      await this.closeFile();
      if (this.size > 0) {
        const real = (await fsp.stat(this.partPath)).size;
        if (real !== this.size) throw new Error(`Size mismatch: expected ${this.size}, got ${real}`);
      }
      if (this.checksum) {
        this.status = 'verifying';
        this.emit('state');
        await this.verifyChecksum();
      }
      const target = uniquePath(this.dir, this.filename);
      await fsp.rename(this.partPath, target);
      this.filename = path.basename(target);
      this.status = 'completed';
      this.completedAt = Date.now();
      this.speed = 0;
      this.emit('state');
      this.emit('complete');
    } catch (e) {
      this.fail(e);
    } finally {
      this._finishing = false;
    }
  }

  verifyChecksum() {
    const [algo, want] = this.checksum.includes(':') ? this.checksum.split(':') : ['sha256', this.checksum];
    return new Promise((resolve, reject) => {
      const h = crypto.createHash(algo.toLowerCase());
      fs.createReadStream(this.partPath)
        .on('data', (d) => h.update(d))
        .on('error', reject)
        .on('end', () => {
          if (h.digest('hex').toLowerCase() === want.trim().toLowerCase()) resolve();
          else reject(new Fatal(`${algo} checksum does not match`));
        });
    });
  }

  fail(e) {
    if (this.status === 'error' || this.status === 'completed') return;
    this.ac?.abort();
    this.status = 'error';
    this.error = e.message || String(e);
    this.retryable = !e.fatal;
    this.speed = 0;
    this.closeFile();
    this.emit('state');
  }

  async settle() {
    for (let i = 0; i < 100 && this.active.size; i++) await sleep(20);
  }

  async closeFile() {
    const fh = this.fh;
    this.fh = null;
    if (fh) await fh.close().catch(() => {});
  }

  async pause() {
    if (this.status !== 'downloading' && this.status !== 'queued') return;
    const wasRunning = this.status === 'downloading';
    this.status = 'paused';
    this.speed = 0;
    if (wasRunning) {
      this.ac.abort();
      await this.settle();
      await this.closeFile();
    }
    this.emit('state');
  }

  async dispose(deleteFiles) {
    this.ac?.abort();
    await this.settle();
    await this.closeFile();
    if (deleteFiles) {
      await fsp.rm(this.partPath, { force: true }).catch(() => {});
      if (this.status === 'completed') await fsp.rm(this.finalPath, { force: true }).catch(() => {});
    }
  }
}

module.exports = { Download };
