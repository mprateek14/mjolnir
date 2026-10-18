'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Download } = require('./download');
const { request } = require('./http');
const { parsePlaylist, fetchText } = require('./hls');
const { sleep, uniquePath, categoryOf } = require('./util');

const WORKERS = 6;
const RETRIES = 5;

let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); } catch { /* optional, falls back to PATH */ }
if (ffmpegPath && ffmpegPath.includes('app.asar')) ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
const FFMPEG = ffmpegPath && fs.existsSync(ffmpegPath) ? ffmpegPath : 'ffmpeg';

// Downloads an HLS playlist as chunks, decrypts AES-128 streams, then joins the chunks into one file.
class HlsDownload extends Download {
  constructor(init, deps) {
    super({ category: 'Video', resumable: true, connections: WORKERS, audioUrl: '', quality: '', type: 'hls', ...init }, deps);
    const stats = init.stats || {};
    this.total = stats.total || 0;
    this.doneCount = stats.doneCount || 0;
    this.bytes = stats.bytes || 0;
    this.downloaded = this.bytes;
    this.keyCache = new Map();
  }

  get tmpDir() { return path.join(this.dir, `.${this.filename}.hls`); }
  get partPath() { return path.join(this.tmpDir, 'merged.tmp'); }
  recount() {}

  toJSON() {
    return { ...super.toJSON(), type: this.type, audioUrl: this.audioUrl, quality: this.quality, stats: { total: this.total, doneCount: this.doneCount, bytes: this.bytes } };
  }

  snapshot() {
    const base = super.snapshot();
    // Show chunk progress through the same segment map the byte-range downloads use.
    const total = this.total || 1;
    const buckets = Math.min(total, 120);
    const segs = [];
    for (let b = 0; b < buckets; b++) {
      const from = Math.floor((b * total) / buckets);
      const to = Math.floor(((b + 1) * total) / buckets);
      let done = 0;
      for (let i = from; i < to; i++) if (this.done?.[i]) done++;
      const n = Math.max(1, to - from);
      segs.push([b * 100, b * 100 + 99, b * 100 + Math.round((100 * done) / n)]);
    }
    const est = this.doneCount ? Math.round((this.bytes / this.doneCount) * total) : -1;
    return { ...base, type: this.type, quality: this.quality, size: est, downloaded: this.bytes, mapSize: buckets * 100, resumable: true, segments: segs, chunks: [this.doneCount, this.total] };
  }

  async probe() { throw new Error('probe is handled by the manager for HLS'); }

  async start() {
    if (this.status === 'downloading') return;
    this.status = 'downloading';
    this.lastTriedAt = Date.now();
    this.error = '';
    this.retryable = true;
    this.ac = new AbortController();
    const { signal } = this.ac;
    this.speed = 0;
    this.emit('state');
    try {
      if (!this.filename) this.filename = 'video.mp4';
      this.dir && (await fsp.mkdir(this.dir, { recursive: true }));
      if (this.autoSort) { this.dir = path.join(this.dir, this.category); this.autoSort = false; await fsp.mkdir(this.dir, { recursive: true }); }
      await fsp.mkdir(this.tmpDir, { recursive: true });
      const tracks = await this.loadTracks(signal);
      if (tracks.some((t) => t.live)) throw Object.assign(new Error('Live streams are not supported yet'), { fatal: true });
      this.tracks = tracks;
      this.work = [];
      tracks.forEach((t, ti) => t.segments.forEach((s, si) => this.work.push({ ti, si, seg: s })));
      this.total = this.work.length;
      this.done = new Array(this.total).fill(false);
      this.doneCount = 0;
      this.bytes = 0;
      // Chunks already on disk from an earlier run count as done.
      for (let i = 0; i < this.total; i++) {
        try {
          const st = await fsp.stat(this.chunkPath(i));
          this.done[i] = true; this.doneCount++; this.bytes += st.size;
        } catch { /* not downloaded yet */ }
      }
      this._lastBytes = this.bytes;
      this._lastT = Date.now();
      this.downloaded = this.bytes;
      await this.runWorkers(signal);
      if (signal.aborted) return;
      await this.finish(signal);
    } catch (e) {
      if (signal.aborted) return;
      this.fail(e);
    }
  }

  async loadTracks(signal) {
    const tracks = [await this.loadTrack(this.url, signal)];
    if (this.audioUrl) tracks.push(await this.loadTrack(this.audioUrl, signal));
    return tracks;
  }

  async loadTrack(url, signal) {
    const { text, url: finalUrl } = await fetchText(url, this.headers, signal);
    const pl = parsePlaylist(text, finalUrl);
    if (pl.master) {
      if (!pl.variants.length) throw new Error('Playlist has no streams');
      return this.loadTrack(pl.variants[0].url, signal);
    }
    if (!pl.segments.length) throw new Error('Playlist has no chunks');
    return pl;
  }

  chunkPath(i) {
    const w = this.work[i];
    const ext = w.ti === 0 ? 'v' : 'a';
    return path.join(this.tmpDir, `${ext}${String(w.si).padStart(6, '0')}.chunk`);
  }

  async runWorkers(signal) {
    let next = 0;
    let failure = null;
    const pending = () => {
      while (next < this.total && this.done[next]) next++;
      return next < this.total ? next++ : -1;
    };
    const worker = async () => {
      for (;;) {
        if (signal.aborted || failure) return;
        const i = pending();
        if (i < 0) return;
        const token = {};
        this.active.add(token);
        try { await this.fetchChunk(i, signal); } catch (e) { if (!signal.aborted) failure = failure || e; } finally { this.active.delete(token); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(WORKERS, this.connections || WORKERS) }, worker));
    if (failure) throw failure;
  }

  async keyFor(track, seg, signal) {
    const k = track.keys[seg.key];
    if (!k || k.method === 'NONE') return null;
    if (k.method !== 'AES-128') throw Object.assign(new Error(`Encryption ${k.method} is not supported`), { fatal: true });
    if (!this.keyCache.has(k.uri)) {
      const { res } = await request(k.uri, { headers: this.headers, signal });
      if (res.statusCode >= 400) { res.resume(); throw Object.assign(new Error(`Key server replied ${res.statusCode}`), { fatal: true }); }
      const parts = [];
      for await (const c of res) parts.push(c);
      this.keyCache.set(k.uri, Buffer.concat(parts));
    }
    let iv;
    if (k.iv) iv = Buffer.from(k.iv.replace(/^0x/i, '').padStart(32, '0'), 'hex');
    else { iv = Buffer.alloc(16); iv.writeUInt32BE(seg.seq >>> 0, 12); }
    return { key: this.keyCache.get(k.uri), iv };
  }

  async download(url, range, signal) {
    const headers = { ...this.headers };
    if (range) headers.range = `bytes=${range.start}-${range.end}`;
    const { res } = await request(url, { headers, signal });
    if (res.statusCode >= 400) {
      res.resume();
      throw Object.assign(new Error(`Server replied ${res.statusCode}`), { status: res.statusCode, fatal: [401, 403, 404, 410].includes(res.statusCode) });
    }
    const parts = [];
    for await (const c of res) {
      if (signal.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
      await Promise.all([this.global.take(c.length, signal), this.own.take(c.length, signal)]);
      parts.push(c);
    }
    return Buffer.concat(parts);
  }

  async fetchChunk(i, signal) {
    const { ti, seg } = this.work[i];
    const track = this.tracks[ti];
    for (let attempt = 0; ; attempt++) {
      try {
        let data = await this.download(seg.url, seg.range, signal);
        const k = await this.keyFor(track, seg, signal);
        if (k) {
          const d = crypto.createDecipheriv('aes-128-cbc', k.key, k.iv);
          data = Buffer.concat([d.update(data), d.final()]);
        }
        const target = this.chunkPath(i);
        await fsp.writeFile(target + '.tmp', data);
        await fsp.rename(target + '.tmp', target);
        this.done[i] = true;
        this.doneCount++;
        this.bytes += data.length;
        this.downloaded = this.bytes;
        return;
      } catch (e) {
        if (signal.aborted || e.aborted) return;
        if (e.fatal || attempt >= RETRIES) throw e;
        await sleep(Math.min(8000, 400 * 2 ** attempt), signal);
      }
    }
  }

  // Joins the chunks of one track into a single file, init segment first when the stream uses fragmented MP4.
  async concat(ti, out) {
    const fh = await fsp.open(out, 'w');
    try {
      const track = this.tracks[ti];
      const first = track.segments[0];
      if (first.map) {
        const buf = await this.download(first.map.url, first.map.range, this.ac.signal);
        await fh.write(buf);
      }
      for (let i = 0; i < this.total; i++) {
        if (this.work[i].ti !== ti) continue;
        await fh.write(await fsp.readFile(this.chunkPath(i)));
      }
    } finally {
      await fh.close();
    }
  }

  ffmpeg(args) {
    return new Promise((resolve, reject) => {
      const p = spawn(FFMPEG, ['-y', '-loglevel', 'error', ...args], { windowsHide: true });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `ffmpeg exited with ${code}`))));
    });
  }

  async finish(signal) {
    this.status = 'merging';
    this.speed = 0;
    this.emit('state');
    const video = path.join(this.tmpDir, 'video.bin');
    await this.concat(0, video);
    const fmp4 = this.fragmented || !!this.tracks[0].segments[0].map;
    const ext = path.extname(this.filename) || '.mp4';
    const stem = path.basename(this.filename, ext);
    let out = path.join(this.tmpDir, 'out' + ext);
    try {
      const inputs = ['-i', video];
      if (this.tracks[1]) {
        const audio = path.join(this.tmpDir, 'audio.bin');
        await this.concat(1, audio);
        inputs.push('-i', audio);
      }
      const bsf = !fmp4 && /^\.(mp4|m4v|mov)$/i.test(ext) ? ['-bsf:a', 'aac_adtstoasc'] : [];
      await this.ffmpeg([...inputs, '-c', 'copy', ...bsf, out]);
    } catch (e) {
      if (signal.aborted) return;
      // No working ffmpeg: keep the raw transport stream so the download is not lost.
      if (this.tracks[1]) throw new Error(`Could not join audio and video: ${e.message}`);
      out = video;
      this.filename = stem + (fmp4 ? '.mp4' : '.ts');
    }
    const target = uniquePath(this.dir, this.filename);
    await fsp.rename(out, target);
    this.filename = path.basename(target);
    await fsp.rm(this.tmpDir, { recursive: true, force: true });
    this.status = 'completed';
    this.completedAt = Date.now();
    this.emit('state');
    this.emit('complete');
  }

  async dispose(deleteFiles) {
    this.ac?.abort();
    await this.settle();
    if (deleteFiles) {
      await fsp.rm(this.tmpDir, { recursive: true, force: true }).catch(() => {});
      if (this.status === 'completed') await fsp.rm(this.finalPath, { force: true }).catch(() => {});
    }
  }
}

module.exports = { HlsDownload };
