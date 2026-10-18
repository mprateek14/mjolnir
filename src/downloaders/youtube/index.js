'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { YtDlp } = require('./ytdlp');

const DEFAULTS = { folder: '', cookiesFrom: '', maxParallel: 2, container: 'compat', audioFormat: 'mp3', thumb: true, meta: true };

function create(ctx) {
  const dataDir = ctx.dataDir;
  const yt = new YtDlp({ binDir: path.join(dataDir, 'bin'), ffmpeg: ctx.ffmpeg, ffprobe: ctx.ffprobe, jsRuntime: ctx.jsRuntime });
  const stateFile = path.join(dataDir, 'jobs.json');
  const jobs = new Map();
  const handles = new Map();
  let settings = { ...DEFAULTS };
  let saveTimer = null;
  let pushTimer = null;
  let ready = null;
  let busy = false;

  // Windows-safe folder name for a playlist.
const folderName = (t) => String(t || 'Playlist').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 100) || 'Playlist';

const outDir = () => settings.folder || path.join(ctx.baseFolder, 'YouTube');

  const load = async () => {
    await fsp.mkdir(dataDir, { recursive: true });
    try {
      const raw = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
      settings = { ...DEFAULTS, ...raw.settings };
      for (const j of raw.jobs || []) {
        if (j.status === 'running' || j.status === 'queued') j.status = 'paused';
        j.speed = 0; j.eta = 0;
        jobs.set(j.id, j);
      }
    } catch { /* first run */ }
  };
  const init = () => ready || (ready = load());

  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => fsp.writeFile(stateFile, JSON.stringify({ settings, jobs: [...jobs.values()] })).catch(() => {}), 500);
  };
  const push = () => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => { pushTimer = null; ctx.emit('jobs', list()); }, 250);
  };
  const list = () => [...jobs.values()].sort((a, b) => b.added - a.added);
  const touch = () => { save(); push(); };

  function pump() {
    const running = [...jobs.values()].filter((j) => j.status === 'running').length;
    let free = settings.maxParallel - running;
    for (const j of [...jobs.values()].sort((a, b) => a.added - b.added)) {
      if (free <= 0) break;
      if (j.status === 'queued') { start(j); free--; }
    }
  }

  const wasSkipped = (file, since) => { try { return fs.statSync(file).mtimeMs < since - 2000; } catch { return false; } };

  function start(job) {
    job.status = 'running';
    job.error = '';
    job.hint = '';
    job.note = '';
    job.stage = 'preparing';
    const startedAt = Date.now();
    let events = 0;
    const h = yt.download({ url: job.url, opts: { ...job.opts, suffix: job.suffix || '' } }, { dir: job.subdir ? path.join(job.dir || outDir(), job.subdir) : job.dir || outDir(), cookiesFrom: settings.cookiesFrom }, {
      progress: (p) => {
        events++;
        job.stage = p.status === 'finished' && job.stage === 'downloading' ? job.stage : 'downloading';
        job.done = p.done;
        job.speed = p.speed;
        job.eta = p.eta;
        // The first stream's real size is known as soon as it starts; the audio that follows is estimated.
        const pendingAudio = job.opts.mode === 'video' && p.finished === 0 ? job.audioSize || 0 : 0;
        const total = p.streamTotal ? p.finished + p.streamTotal + pendingAudio : job.approxSize || 0;
        job.total = total;
        let pct = total ? Math.min(0.995, p.done / total) : 0;
        if (p.count > 1) {
          job.index = p.index; job.count = p.count;
          pct = (p.index - 1 + (p.streamTotal ? Math.min(1, (p.done - p.finished) / p.streamTotal) : 0)) / p.count;
        }
        job.percent = Math.max(job.percent || 0, pct);
        push();
      },
      stage: (s) => { job.stage = s; job.speed = 0; push(); },
      file: (f) => { job.files = [...(job.files || []), f]; },
    });
    handles.set(job.id, h);
    h.done.then((files) => {
      handles.delete(job.id);
      if (files === null) return;        // killed on purpose; the caller already set the status
      // yt-dlp quietly skips a file that already exists. A fresh request for the same video should still download,
      // so retry under a numbered name: "Video [1080p] (1).mp4".
      const skipped = events === 0 && !job.percent && files[0] && wasSkipped(files[0], startedAt);
      // Videos that came from a playlist are not duplicated: running a playlist again only fetches what is new.
      if (skipped && job.group) job.note = 'Already downloaded';
      else if (!job.opts.playlist && skipped && (job.dupTries || 0) < 50) {
        job.dupTries = (job.dupTries || 0) + 1;
        job.suffix = ` (${job.dupTries})`;
        job.files = [];
        return start(job);
      }
      job.status = 'done';
      job.percent = 1;
      job.speed = 0; job.eta = 0; job.stage = '';
      job.finishedAt = Date.now();
      job.size = (job.files || []).reduce((a, f) => { try { return a + fs.statSync(f).size; } catch { return a; } }, 0);
      ctx.notify('YouTube download complete', job.title);
    }, (err) => {
      handles.delete(job.id);
      job.status = 'error';
      job.error = err.message;
      job.hint = /Updating the YouTube engine|Unable to extract|nsig|signature/i.test(err.message) ? 'update' : '';
      job.speed = 0; job.eta = 0; job.stage = '';
    }).finally(() => { touch(); pump(); });
    touch();
  }

  const stop = (job, status) => {
    job.status = status;
    job.speed = 0; job.eta = 0; job.stage = '';
    const h = handles.get(job.id);
    if (h) { handles.delete(job.id); h.kill(); }
  };

  async function engineStatus() {
    await init();
    return { installed: yt.installed(), version: await yt.version() };
  }

  async function install() {
    if (busy) throw new Error('Already updating');
    busy = true;
    try {
      const v = await yt.install((p, got, total) => ctx.emit('engine', { progress: p, got, total }));
      ctx.emit('engine', { done: true, version: v });
      return v;
    } finally { busy = false; }
  }

  const handlers = {
    async status() { return engineStatus(); },
    install,
    async checkUpdate() {
      const current = await yt.version();
      const latest = await yt.latest();
      return { current, latest, outdated: !!current && current !== latest.replace(/^v/, '') };
    },
    async info(url) {
      await init();
      if (!yt.installed()) throw new Error('ENGINE_MISSING');
      url = String(url || '').trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('Paste a full YouTube link starting with https://');
      return yt.info(url, { cookiesFrom: settings.cookiesFrom });
    },
    async add(item) {
      await init();
      if (!yt.installed()) throw new Error('ENGINE_MISSING');
      const job = {
        id: crypto.randomUUID(), url: item.url, title: item.title || item.url, channel: item.channel || '', thumbnail: item.thumbnail || '', dir: item.dir || '', subdir: item.subdir || '',
        duration: item.duration || 0, source: item.source || '', opts: item.opts, approxSize: item.approxSize || 0, audioSize: item.audioSize || 0,
        status: 'queued', stage: '', percent: 0, done: 0, speed: 0, eta: 0, files: [], error: '', added: Date.now(),
        index: 0, count: item.opts.playlist ? item.count || 0 : 0,
      };
      jobs.set(job.id, job);
      touch();
      pump();
      return job;
    },
    // One job per picked video, grouped under the playlist. Each can pause, fail and retry on its own.
    async addMany({ playlist, items, opts, folder, number }) {
      await init();
      if (!yt.installed()) throw new Error('ENGINE_MISSING');
      if (!items || !items.length) throw new Error('Pick at least one video.');
      const gid = crypto.randomUUID();
      const subdir = folder ? folderName(playlist.title) : '';
      const width = Math.max(2, String(playlist.count || Math.max(...items.map((x) => x.index))).length);
      const now = Date.now();
      items.forEach((it, n) => {
        const job = {
          id: crypto.randomUUID(), url: `https://www.youtube.com/watch?v=${it.id}`, title: it.title, channel: '',
          thumbnail: `https://i.ytimg.com/vi/${it.id}/mqdefault.jpg`, duration: it.duration || 0,
          opts: { ...opts, playlist: false, formatId: '', audioId: '', prefix: number ? `${String(it.index).padStart(width, '0')} - ` : '' },
          approxSize: 0, audioSize: 0, status: 'queued', stage: '', percent: 0, done: 0, speed: 0, eta: 0, files: [], error: '',
          added: now + n, index: 0, count: 0, subdir,
          group: { id: gid, title: playlist.title, total: items.length, position: it.index },
        };
        jobs.set(job.id, job);
      });
      touch();
      pump();
      return gid;
    },
    async pauseGroup(gid) { for (const j of jobs.values()) if (j.group && j.group.id === gid && ['running', 'queued'].includes(j.status)) stop(j, 'paused'); touch(); pump(); },
    async resumeGroup(gid) { for (const j of jobs.values()) if (j.group && j.group.id === gid && ['paused', 'error'].includes(j.status)) { j.status = 'queued'; j.error = ''; } touch(); pump(); },
    async removeGroup(gid) { for (const [id, j] of jobs) if (j.group && j.group.id === gid) { stop(j, 'removed'); jobs.delete(id); } touch(); pump(); },
    async revealGroup(gid) {
      const j = [...jobs.values()].find((x) => x.group && x.group.id === gid);
      if (!j) return;
      const dir = j.subdir ? path.join(outDir(), j.subdir) : outDir();
      await fsp.mkdir(dir, { recursive: true });
      return ctx.shell.openPath(dir);
    },
    // For links that arrive without the page (a paired phone): best quality, using the saved defaults.
    async quickAdd(url, opts = {}) {
      await init();
      if (!yt.installed()) throw new Error('Set up the YouTube downloader on the PC first.');
      const info = await yt.info(String(url).trim(), { cookiesFrom: settings.cookiesFrom });
      if (info.kind === 'playlist') throw new Error('That is a playlist. Open it on the PC to choose videos.');
      const top = info.qualities[0];
      const pick = top && top.picks[settings.container];
      const job = await handlers.add({
        url: info.url, title: info.title, channel: info.channel, thumbnail: info.thumbnail, duration: info.duration,
        source: opts.source || 'phone', dir: opts.dir || '', subdir: opts.subdir ? folderName(opts.subdir) : '', approxSize: pick ? pick.size : 0, audioSize: pick && info.audioSizes ? info.audioSizes[settings.container] : 0,
        opts: {
          mode: top ? 'video' : 'audio', playlist: false, height: 0, container: settings.container, audioFormat: settings.audioFormat,
          thumb: settings.thumb, meta: settings.meta, subs: false, formatId: pick ? pick.v : '', audioId: pick ? pick.a : '',
        },
      });
      return { id: job.id, title: job.title };
    },
    activity() { return { active: [...jobs.values()].filter((j) => j.status === 'running' || j.status === 'queued').length }; },
    peek(id) {
      const j = jobs.get(id);
      return j ? { status: j.status, percent: j.status === 'done' ? 1 : j.percent || 0, title: j.title, size: j.size || j.total || 0 } : null;
    },
    async jobs() { await init(); return list(); },
    async pause(id) { const j = jobs.get(id); if (j && ['running', 'queued'].includes(j.status)) { stop(j, 'paused'); touch(); pump(); } },
    async resume(id) { const j = jobs.get(id); if (j && ['paused', 'error'].includes(j.status)) { j.status = 'queued'; j.error = ''; touch(); pump(); } },
    async remove(id, deleteFiles) {
      const j = jobs.get(id);
      if (!j) return;
      stop(j, 'removed');
      jobs.delete(id);
      if (deleteFiles) for (const f of j.files || []) await fsp.rm(f, { force: true }).catch(() => {});
      touch(); pump();
    },
    async clearDone() { for (const [id, j] of jobs) if (j.status === 'done') jobs.delete(id); touch(); },
    async reveal(id) {
      const j = jobs.get(id);
      if (!j) return;
      const f = (j.files || [])[0];
      if (f && fs.existsSync(f)) ctx.shell.showItemInFolder(f); else ctx.shell.openPath(j.dir || outDir());
    },
    async open(id) { const j = jobs.get(id); const f = j && (j.files || [])[0]; if (f) return ctx.shell.openPath(f); },
    async getSettings() { await init(); return { ...settings, folder: outDir() }; },
    async setSettings(patch) {
      await init();
      const allowed = ['folder', 'cookiesFrom', 'maxParallel', 'container', 'audioFormat', 'thumb', 'meta'];
      for (const k of allowed) if (k in patch) settings[k] = patch[k];
      settings.maxParallel = Math.max(1, Math.min(6, Number(settings.maxParallel) || 2));
      save(); pump();
      return { ...settings, folder: outDir() };
    },
    async openFolder() { await init(); await fsp.mkdir(outDir(), { recursive: true }); return ctx.shell.openPath(outDir()); },
    pickFolder: () => ctx.pickFolder(),
    openLink: (url) => /^https:\/\/(github\.com|www\.youtube\.com)\//.test(url) && ctx.shell.openExternal(url),
  };

  return {
    handlers,
    async dispose() {
      for (const j of jobs.values()) if (j.status === 'running' || j.status === 'queued') stop(j, 'paused');
      clearTimeout(saveTimer);
      await fsp.mkdir(dataDir, { recursive: true });
      await fsp.writeFile(stateFile, JSON.stringify({ settings, jobs: [...jobs.values()] })).catch(() => {});
    },
  };
}

const matches = (url) => /^https?:\/\/((www|m|music)\.)?(youtube\.com|youtu\.be)\//i.test(url);

// The browser extension's Download button: the small window in capture/ takes one video page. Playlist and other pages are not offered.
const capture = {
  width: 600, height: 430,
  accept(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^(www|m|music)\./, '');
      let id = '';
      if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
      else if (host === 'youtube.com') id = u.pathname === '/watch' ? u.searchParams.get('v') || '' : (u.pathname.match(/^\/(?:shorts|live)\/([\w-]{6,})/) || [])[1] || '';
      return /^[\w-]{6,20}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : '';
    } catch { return ''; }
  },
};

module.exports = { id: 'youtube', dir: __dirname, matches, capture, hasFolder: true, name: 'YouTube', description: 'Videos, playlists and audio from YouTube, up to 8K when the video has it', create };
