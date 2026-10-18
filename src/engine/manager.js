'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');
const { Download } = require('./download');
const { HlsDownload } = require('./hlsdownload');
const { DashDownload } = require('./dashdownload');
const { parseMpd, variantsOf, isDashUrl, isDashMime } = require('./dash');
const { parsePlaylist, fetchText, isHlsUrl, isHlsMime, label } = require('./hls');
const { Limiter, sanitizeName } = require('./util');

const DEFAULTS = {
  downloadDir: '',
  connections: 8,          // per download
  maxConcurrent: 3,        // downloads running at once
  speedLimit: 0,           // bytes/s, 0 = unlimited
  autoRetry: 3,            // retries for transient errors, every 30s like IDM's scheduler
  sortIntoFolders: true,
  clipboardWatch: false,
  schedule: { enabled: false, start: '02:00', stop: '06:00' },
  extensionToken: '',
  extensionEnabled: true,   // take over downloads the browser starts by itself
  extensionMinMB: 2,        // smaller files stay with the browser
};

class Manager extends EventEmitter {
  constructor({ dataDir, downloadDir }) {
    super();
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'downloads.json');
    this.settings = { ...DEFAULTS, downloadDir };
    this.items = new Map();
    this.global = new Limiter(0);
    this._saveTimer = null;
    this._dirty = new Set();
  }

  async init() {
    await fsp.mkdir(this.dataDir, { recursive: true });
    try {
      const raw = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      this.settings = { ...this.settings, ...raw.settings, schedule: { ...DEFAULTS.schedule, ...(raw.settings || {}).schedule } };
      for (const j of raw.items || []) {
        // Anything that was running when the app closed comes back paused.
        if (['downloading', 'queued', 'verifying', 'merging'].includes(j.status)) j.status = 'paused';
        this.adopt(this.make(j));
      }
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('Could not read state:', e.message);
    }
    this.global.setRate(this.settings.speedLimit);
    this.tickTimer = setInterval(() => this.tick(), 250);
    this.maintTimer = setInterval(() => this.maintain(), 30000);
    this.saveTimer = setInterval(() => this.save(), 5000);
  }

  make(init) {
    const Cls = init.type === 'dash' ? DashDownload : init.type === 'hls' ? HlsDownload : Download;
    return new Cls(init, this.deps());
  }

  deps() {
    return {
      globalLimiter: this.global,
      isTaken: (p, self) => [...this.items.values()].some((d) => d !== self && d.status !== 'completed' && (d.finalPath === p || d.partPath === p)),
    };
  }

  adopt(d) {
    this.items.set(d.id, d);
    d.on('state', () => { this.changed(d); this.schedule(); });
    d.on('requeue', () => { this.changed(d); this.schedule(); });
    d.on('complete', () => this.emit('complete', d.snapshot()));
    return d;
  }

  changed(d) {
    this._dirty.add(d.id);
    this.save();
  }

  // ---- public API --------------------------------------------------------------------

  list() { return [...this.items.values()].map((d) => d.snapshot()); }

  async probe(url, headers = {}) {
    if (isHlsUrl(url)) return this.probeHls(url, headers);
    if (isDashUrl(url)) return this.probeDash(url, headers);
    const d = new Download({ url, headers, dir: this.settings.downloadDir }, this.deps());
    const info = await d.probe();
    if (isHlsMime(info.mime)) return this.probeHls(url, headers);
    if (isDashMime(info.mime)) return this.probeDash(url, headers);
    return info;
  }

  async probeDash(url, headers) {
    const { text, url: finalUrl } = await fetchText(url, headers);
    const mpd = parseMpd(text, finalUrl);
    const variants = variantsOf(mpd);
    if (!variants.length) throw new Error('Manifest has no downloadable video or audio');
    const p = new URL(finalUrl).pathname.split('/').filter(Boolean);
    let base = decodeURIComponent(p.pop() || '').replace(/\.mpd$/i, '');
    if (!base || /^(index|master|manifest|stream|dash|playlist)/i.test(base)) base = decodeURIComponent(p.pop() || new URL(finalUrl).hostname);
    return {
      type: 'dash', filename: sanitizeName(base) + '.mp4', live: mpd.live, drm: mpd.drm, size: -1, resumable: true,
      mime: 'application/dash+xml', variants: variants.map((v) => ({ ...v, add: { ...v.add, url: finalUrl }, ext: v.webm ? '.mkv' : '.mp4' })),
    };
  }

  async probeHls(url, headers) {
    const { text, url: finalUrl } = await fetchText(url, headers);
    const pl = parsePlaylist(text, finalUrl);
    const variants = pl.master
      ? pl.variants.map((v) => ({ add: { url: v.url, audioUrl: v.audio }, label: label(v) + (v.audio ? '  (separate audio)' : '') }))
      : [{ add: { url: finalUrl }, label: pl.live ? 'Live stream' : `${Math.round(pl.duration)}s, ${pl.segments.length} chunks` }];
    const p = new URL(finalUrl).pathname.split('/').filter(Boolean);
    let base = decodeURIComponent(p.pop() || '').replace(/\.m3u8$/i, '');
    if (!base || /^(index|master|playlist|manifest|stream|chunklist|media)/i.test(base)) base = decodeURIComponent(p.pop() || new URL(finalUrl).hostname);
    return { type: 'hls', filename: sanitizeName(base) + '.mp4', variants, live: !pl.master && pl.live, size: -1, resumable: true, mime: 'application/vnd.apple.mpegurl' };
  }

  add({ url, filename = '', dir, headers = {}, connections, start = true, checksum = '', comment = '', type, audioUrl = '', quality = '', videoId = '', audioId = '' }) {
    url = String(url).trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http and https links are supported');
    const base = dir || this.settings.downloadDir;
    const dash = type === 'dash' || isDashUrl(url);
    const hls = !dash && (type === 'hls' || isHlsUrl(url));
    if (dash && !filename) filename = (decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || 'video').replace(/\.mpd$/i, '') || 'video') + '.mp4';
    if (hls && !filename) filename = (decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || 'video').replace(/\.m3u8$/i, '') || 'video') + '.mp4';
    const d = this.make({
      type: dash ? 'dash' : hls ? 'hls' : 'file', videoId, audioId,
      url, filename, headers, checksum, comment, audioUrl, quality,
      dir: base,
      connections: connections || this.settings.connections,
      autoSort: !dir && this.settings.sortIntoFolders,
      status: start ? 'queued' : 'paused',
    }, this.deps());
    this.adopt(d);
    this.changed(d);
    this.schedule();
    this.emit('added', d.snapshot());
    return d.snapshot();
  }

  async pause(id) { await this.items.get(id)?.pause(); this.schedule(); }

  resume(id) {
    const d = this.items.get(id);
    if (!d || ['completed', 'downloading', 'queued', 'verifying'].includes(d.status)) return;
    d.status = 'queued';
    d.retries = 0;
    this.changed(d);
    this.schedule();
  }

  async remove(id, deleteFiles = false) {
    const d = this.items.get(id);
    if (!d) return;
    this.items.delete(id);
    await d.dispose(deleteFiles);
    this.save();
    this.emit('removed', id);
    this.schedule();
  }

  pauseAll() { return Promise.all([...this.items.values()].map((d) => d.pause())); }
  resumeAll() { for (const id of this.items.keys()) this.resume(id); }

  setSettings(patch) {
    this.settings = { ...this.settings, ...patch, schedule: { ...this.settings.schedule, ...(patch.schedule || {}) } };
    this.global.setRate(this.settings.speedLimit);
    this.save();
    this.schedule();
    this.emit('settings', this.settings);
  }

  setSpeedLimit(id, rate) {
    const d = this.items.get(id);
    if (d) { d.speedLimit = rate; d.own.setRate(rate); this.changed(d); }
  }

  // ---- scheduling --------------------------------------------------------------------

  // Start queued items, oldest first, until the concurrency limit is full.
  schedule() {
    const running = [...this.items.values()].filter((d) => ['downloading', 'verifying', 'merging'].includes(d.status)).length;
    let free = this.settings.maxConcurrent - running;
    if (free <= 0) return;
    const waiting = [...this.items.values()].filter((d) => d.status === 'queued').sort((a, b) => a.addedAt - b.addedAt);
    for (const d of waiting) {
      if (free-- <= 0) break;
      d.start();
    }
  }

  maintain() {
    // Retry transient failures, like the IDM queue does every 30 seconds.
    for (const d of this.items.values()) {
      if (d.status === 'error' && d.retryable && d.retries < this.settings.autoRetry) {
        d.retries++;
        d.status = 'queued';
        this.changed(d);
      }
    }
    const s = this.settings.schedule;
    if (s.enabled) {
      const now = new Date();
      const mins = now.getHours() * 60 + now.getMinutes();
      const [sh, sm] = s.start.split(':').map(Number);
      const [eh, em] = s.stop.split(':').map(Number);
      const a = sh * 60 + sm;
      const b = eh * 60 + em;
      const inside = a <= b ? mins >= a && mins < b : mins >= a || mins < b;
      if (inside && !this._inWindow) this.resumeAll();
      if (!inside && this._inWindow) this.pauseAll();
      this._inWindow = inside;
    }
    this.schedule();
  }

  // ---- housekeeping ------------------------------------------------------------------

  tick() {
    const active = [];
    for (const d of this.items.values()) {
      if (d.status === 'downloading') {
        d.tick();
        active.push(d.snapshot());
      }
    }
    const total = active.reduce((a, d) => a + d.speed, 0);
    this.emit('progress', { items: active, totalSpeed: total });
  }

  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), 400);
  }

  async flush() {
    const payload = JSON.stringify({ settings: this.settings, items: [...this.items.values()] });
    const tmp = this.file + '.tmp';
    try {
      await fsp.writeFile(tmp, payload);
      await fsp.rename(tmp, this.file);
    } catch (e) {
      console.error('Could not save state:', e.message);
    }
  }

  async shutdown() {
    clearInterval(this.tickTimer); clearInterval(this.maintTimer); clearInterval(this.saveTimer);
    await this.pauseAll();
    await this.flush();
  }
}

module.exports = { Manager, DEFAULTS };
