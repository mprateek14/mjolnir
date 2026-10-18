'use strict';
// Everything that touches yt-dlp lives in this file. If yt-dlp changes its flags or output,
// this is the only place that needs to change. No Electron imports, so it runs under plain Node.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const REPO = 'yt-dlp/yt-dlp';
const ASSETS = {
  win32: { x64: 'yt-dlp.exe', ia32: 'yt-dlp_x86.exe', arm64: 'yt-dlp_arm64.exe' },
  darwin: { x64: 'yt-dlp_macos', arm64: 'yt-dlp_macos' },
  linux: { x64: 'yt-dlp_linux', arm64: 'yt-dlp_linux_aarch64' },
};

class YtDlp {
  // jsRuntime: { path, env } - an executable that behaves like Node, used to solve YouTube's player challenges.
  constructor({ binDir, ffmpeg, ffprobe, jsRuntime }) {
    this.binDir = binDir;
    this.ffmpeg = ffmpeg;
    this.ffprobe = ffprobe;
    this.jsRuntime = jsRuntime;
  }

  get bin() { return path.join(this.binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'); }

  env() { return { ...process.env, ...(this.jsRuntime && this.jsRuntime.env), PYTHONIOENCODING: 'utf-8' }; }

  // yt-dlp looks for ffmpeg and ffprobe side by side, but the two bundled builds live in different folders.
  // Link them into one folder (copying if linking is not allowed) and point yt-dlp there.
  toolsDir() {
    if (!this.ffmpeg) return null;
    const dir = path.join(this.binDir, 'tools');
    const ext = process.platform === 'win32' ? '.exe' : '';
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, src] of [['ffmpeg', this.ffmpeg], ['ffprobe', this.ffprobe]]) {
      if (!src || !fs.existsSync(src)) continue;
      const dest = path.join(dir, name + ext);
      let ok = false;
      try { ok = fs.statSync(dest).size === fs.statSync(src).size; } catch { /* missing */ }
      if (ok) continue;
      try { fs.rmSync(dest, { force: true }); fs.linkSync(src, dest); } catch { fs.copyFileSync(src, dest); }
      if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
    }
    return dir;
  }

  common() {
    const a = ['--ignore-config', '--no-colors', '--no-mtime'];
    const tools = this.toolsDir();
    if (tools) a.push('--ffmpeg-location', tools);
    if (this.jsRuntime) a.push('--js-runtimes', `node:${this.jsRuntime.path}`);
    return a;
  }

  installed() { return fs.existsSync(this.bin); }

  version() {
    return new Promise((resolve) => {
      if (!this.installed()) return resolve(null);
      execFile(this.bin, ['--version'], { env: this.env(), windowsHide: true, timeout: 20000 }, (e, out) => resolve(e ? null : out.trim()));
    });
  }

  assetName() {
    const a = (ASSETS[process.platform] || {})[process.arch];
    if (!a) throw new Error(`yt-dlp has no build for ${process.platform} ${process.arch}`);
    return a;
  }

  async latest() {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'user-agent': 'Mjolnir', accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(`Could not check for updates (GitHub replied ${r.status})`);
    return (await r.json()).tag_name;
  }

  // Downloads the official release, checks it against the published SHA-256 list, then swaps it in.
  async install(onProgress = () => {}) {
    const asset = this.assetName();
    const base = `https://github.com/${REPO}/releases/latest/download`;
    await fsp.mkdir(this.binDir, { recursive: true });
    const sums = await (await fetch(`${base}/SHA2-256SUMS`)).text();
    const line = sums.split('\n').find((l) => l.trim().endsWith(` ${asset}`) || l.trim().endsWith(` *${asset}`));
    if (!line) throw new Error('Could not find the checksum for this download');
    const want = line.trim().split(/\s+/)[0].toLowerCase();

    const res = await fetch(`${base}/${asset}`);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;
    const tmp = this.bin + '.new';
    const hash = crypto.createHash('sha256');
    let got = 0;
    const out = fs.createWriteStream(tmp);
    await pipeline(Readable.fromWeb(res.body), async function* (src) {
      for await (const chunk of src) {
        hash.update(chunk);
        got += chunk.length;
        onProgress(total ? got / total : 0, got, total);
        yield chunk;
      }
    }, out);
    if (hash.digest('hex') !== want) {
      await fsp.rm(tmp, { force: true });
      throw new Error('Downloaded file failed its checksum, so it was discarded');
    }
    if (process.platform !== 'win32') await fsp.chmod(tmp, 0o755);
    await fsp.rm(this.bin + '.old', { force: true });
    if (this.installed()) await fsp.rename(this.bin, this.bin + '.old');
    await fsp.rename(tmp, this.bin);
    const v = await this.version();
    if (!v) {
      // New binary will not start: put the old one back.
      if (fs.existsSync(this.bin + '.old')) { await fsp.rm(this.bin, { force: true }); await fsp.rename(this.bin + '.old', this.bin); }
      throw new Error('The new yt-dlp would not start, so the previous version was kept');
    }
    await fsp.rm(this.bin + '.old', { force: true });
    return v;
  }

  run(args, { timeout = 120000 } = {}) {
    return new Promise((resolve, reject) => {
      const p = spawn(this.bin, [...this.common(), ...args], { env: this.env(), windowsHide: true });
      let out = '';
      let err = '';
      const t = setTimeout(() => { p.kill(); reject(new Error('Timed out talking to YouTube')); }, timeout);
      p.stdout.on('data', (d) => { out += d; if (out.length > 200e6) p.kill(); });
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', (e) => { clearTimeout(t); reject(e); });
      p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(friendly(err))); });
    });
  }

  async info(url, { cookiesFrom = '' } = {}) {
    const isList = /[?&]list=/.test(url) && (!/[?&]v=/.test(url) || /\/playlist\?/.test(url));
    const args = ['-J', '--no-warnings', isList ? '--flat-playlist' : '--no-playlist'];
    if (cookiesFrom) args.push('--cookies-from-browser', cookiesFrom);
    args.push(url);
    const out = normalize(JSON.parse(await this.run(args)), url);
    // A watch link that also carries a playlist: let the page offer the whole list.
    const list = /[?&]list=([\w-]+)/.exec(url);
    if (out.kind === 'video' && list && /^(PL|OLAK|UU|FL)/.test(list[1])) out.playlistUrl = `https://www.youtube.com/playlist?list=${list[1]}`;
    return out;
  }

  // Starts a download and reports progress through callbacks. Returns { kill, done } where done resolves with the files written.
  download(job, { dir, cookiesFrom = '' }, on) {
    const args = [...this.common(), ...buildArgs(job.opts, { dir, cookiesFrom }), job.url];
    const p = spawn(this.bin, args, { env: this.env(), windowsHide: true });
    const state = { stream: '', finished: 0, lastTotal: 0, files: [], err: '' };
    let buf = '';
    const line = (l) => parseLine(l, state, on);
    const feed = (d) => {
      buf += d;
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      parts.forEach(line);
    };
    p.stdout.setEncoding('utf8').on('data', feed);
    p.stderr.setEncoding('utf8').on('data', (d) => { state.err += d; });
    const done = new Promise((resolve, reject) => {
      p.on('error', reject);
      p.on('close', (code) => {
        if (buf) line(buf);
        if (code === 0) resolve(state.files);
        else if (state.killed) resolve(null);
        else reject(new Error(friendly(state.err)));
      });
    });
    const kill = () => {
      state.killed = true;
      if (process.platform === 'win32') execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else p.kill('SIGTERM');
    };
    return { kill, done };
  }
}

function buildArgs(o, { dir, cookiesFrom }) {
  const a = [
    '--newline', '--windows-filenames', '--trim-filenames', '200',
    '--concurrent-fragments', '8', '--http-chunk-size', '10M', '--retries', '10', '--fragment-retries', '10',
    '-P', dir,
    // The height in the name keeps two qualities of one video from being mistaken for the same file.
    '-o', (o.playlist ? '%(playlist_title).100B/%(playlist_index)02d - ' : '') + (o.prefix || '') + (o.mode === 'audio' ? '%(title).150B' + (o.suffix || '') + '.%(ext)s' : '%(title).150B [%(height)sp]' + (o.suffix || '') + '.%(ext)s'),
    o.playlist ? '--yes-playlist' : '--no-playlist',
    '--progress', '--progress-template',
    'download:SGP|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.format_id)s|%(info.playlist_index)s|%(info.n_entries)s',
    '--progress-template', 'postprocess:SGPP|%(progress.status)s|%(progress.postprocessor)s',
    // As JSON, because the plain form drops characters Windows swaps for look-alikes (: and " become full-width).
    '--print', 'after_move:SGDONE|%(filepath)j',
  ];
  if (o.mode === 'audio') {
    a.push('-f', 'ba/b', '-x', '--audio-format', o.audioFormat || 'mp3', '--audio-quality', '0');
  } else {
    const h = Number(o.height) || 0;
    const cap = h ? `[height<=${h}]` : '';
    // Exact format ids (picked when the page listed the sizes) keep the download identical to what was shown.
    // The height selector after the slash is the fallback if YouTube stops offering them.
    const exact = o.formatId ? `${o.formatId}${o.audioId ? '+' + o.audioId : ''}/` : '';
    a.push('-f', `${exact}bv*${cap}+ba/b${cap}`);
    if (o.container === 'best') a.push('--merge-output-format', 'mkv');
    else a.push('-S', 'res,vcodec:h264,acodec:m4a', '--merge-output-format', 'mp4');
    if (o.subs) a.push('--write-subs', '--sub-langs', 'en.*,en', '--embed-subs');
  }
  if (o.thumb) a.push('--embed-thumbnail', '--convert-thumbnails', 'jpg');
  if (o.meta) a.push('--embed-metadata');
  if (cookiesFrom) a.push('--cookies-from-browser', cookiesFrom);
  return a;
}

const num = (s) => (s === 'NA' || s === '' || s === undefined ? 0 : Number(s) || 0);

function parseLine(l, st, on) {
  if (l.startsWith('SGP|')) {
    const [, status, dl, tot, est, speed, eta, fmt, idx, n] = l.split('|');
    if (fmt !== st.stream) {
      // A new stream started (video, then audio). Fold the finished one into the running total.
      st.finished += st.lastTotal;
      st.stream = fmt;
    }
    const total = num(tot) || num(est);
    st.lastTotal = total || num(dl);
    on.progress && on.progress({
      status, done: st.finished + num(dl), streamTotal: total, finished: st.finished,
      speed: num(speed), eta: num(eta), index: num(idx), count: num(n),
    });
  } else if (l.startsWith('SGPP|')) {
    const [, status, pp] = l.split('|');
    if (status === 'started' && on.stage) {
      on.stage(/Merger/.test(pp) ? 'merging' : /ExtractAudio|Convertor|Remuxer/.test(pp) ? 'converting' : 'finishing');
    }
  } else if (l.startsWith('SGDONE|')) {
    let file = l.slice(7).trim();
    try { file = JSON.parse(file); } catch { /* older output: plain path */ }
    st.files.push(file);
    on.file && on.file(st.files[st.files.length - 1]);
  }
}

function friendly(stderr) {
  const lines = stderr.split(/\r?\n/).filter((l) => /^ERROR/.test(l));
  const last = (lines[lines.length - 1] || stderr.trim().split(/\r?\n/).pop() || 'yt-dlp failed').replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '');
  const rules = [
    [/confirm you.re not a bot|Sign in to confirm/i, 'YouTube wants a signed-in session. Pick your browser under Sign-in cookies in settings and try again.'],
    [/age.restricted|Sign in to confirm your age/i, 'This video is age restricted. Pick your browser under Sign-in cookies in settings.'],
    [/Private video/i, 'This video is private.'],
    [/Video unavailable|has been removed|no longer available/i, 'This video is unavailable.'],
    [/members.only|Join this channel/i, 'This video is for channel members only.'],
    [/not available in your country|blocked it in your country/i, 'This video is blocked in your country.'],
    [/Requested format is not available/i, 'That quality is not available for this video. Pick another one.'],
    [/HTTP Error 403|HTTP Error 429/i, 'YouTube refused the download. Updating the YouTube engine usually fixes this.'],
    [/ffmpeg|ffprobe/i, 'The video joiner (ffmpeg) failed: ' + last],
    [/Unable to download webpage|getaddrinfo|timed out|Network is unreachable/i, 'Could not reach YouTube. Check your connection.'],
    [/Unsupported URL/i, 'That link is not a YouTube video.'],
  ];
  for (const [re, msg] of rules) if (re.test(stderr)) return msg;
  return last;
}

function normalize(j, url) {
  const thumb = j.thumbnail || (j.thumbnails && j.thumbnails.length && j.thumbnails[j.thumbnails.length - 1].url) || '';
  if (j._type === 'playlist') {
    const entries = (j.entries || []).filter(Boolean).map((e, i) => ({
      id: e.id, title: e.title || e.id, duration: e.duration || 0, index: i + 1,
      // Private and deleted videos show up in the list but cannot be downloaded.
      unavailable: /^\[(Private|Deleted) video\]$/i.test(e.title || '') || e.availability === 'private',
    }));
    const first = entries.find((e) => !e.unavailable);
    return {
      kind: 'playlist', url, id: j.id, title: j.title || 'Playlist', channel: j.uploader || j.channel || '',
      count: entries.length, entries, duration: entries.reduce((a, e) => a + e.duration, 0),
      thumbnail: first ? `https://i.ytimg.com/vi/${first.id}/mqdefault.jpg` : '',
    };
  }
  const formats = j.formats || [];
  const size = (f) => f.filesize || f.filesize_approx || (f.tbr && j.duration ? Math.round(f.tbr * 125 * j.duration) : 0);
  const usable = (f) => !/m3u8|dash_frag/.test(f.protocol || '') && !f.has_drm;
  const video = formats.filter((f) => f.vcodec && f.vcodec !== 'none' && f.height && usable(f));
  // Plain audio only: no dynamic-range-compressed copies, no HLS-only tracks. Original-language track first.
  let audio = formats.filter((f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none' && !/DRC/.test(f.format_note || '') && usable(f));
  const original = audio.filter((f) => /original|default/i.test(f.format_note || '') || f.language_preference > 0);
  if (original.length) audio = original;
  const byAbr = (a, b) => (b.abr || 0) - (a.abr || 0);
  const m4a = audio.filter((f) => /mp4a/.test(f.acodec)).sort(byAbr)[0];
  const opus = audio.filter((f) => /opus/.test(f.acodec)).sort(byAbr)[0];
  const anyAudio = audio.slice().sort(byAbr)[0];
  const audioFor = { compat: m4a || anyAudio, best: opus || anyAudio };

  // Which codec each container prefers. MP4 wants what plays everywhere; MKV takes the smallest-for-quality.
  const order = {
    compat: ['H.264', 'VP9', 'AV1', 'H.265'],
    best: ['AV1', 'VP9', 'H.265', 'H.264'],
  };
  const heights = [...new Set(video.map((f) => f.height))].sort((a, b) => b - a);
  const qualities = heights.map((h) => {
    let cands = video.filter((f) => f.height === h);
    // Formats with no label are YouTube's Premium bitrate copies. Skip them unless they are all there is.
    const plain = cands.filter((f) => f.format_note);
    if (plain.length) cands = plain;
    const pick = (cont) => {
      const rank = (f) => { const i = order[cont].indexOf(codecName(f.vcodec)); return i < 0 ? 99 : i; };
      const f = cands.slice().sort((a, b) => rank(a) - rank(b) || (b.tbr || 0) - (a.tbr || 0))[0];
      const au = audioFor[cont];
      const v = size(f);
      return { v: f.format_id, a: au ? au.format_id : '', codec: codecName(f.vcodec), size: v ? v + (au ? size(au) : 0) : 0 };
    };
    const fps = Math.max(...cands.map((f) => f.fps || 0));
    return { height: h, fps, label: `${h}p${fps > 30 ? Math.round(fps) : ''}`, codecs: [...new Set(cands.map((f) => codecName(f.vcodec)))], picks: { compat: pick('compat'), best: pick('best') } };
  });
  const bestAudio = audioFor.compat;
  return {
    kind: 'video', url: j.webpage_url || url, id: j.id, title: j.title, channel: j.uploader || j.channel || '',
    duration: j.duration || 0, thumbnail: thumb, qualities, live: !!j.is_live, subs: Object.keys(j.subtitles || {}).length,
    audioSize: bestAudio ? size(bestAudio) : 0,
    audioPicks: { compat: audioFor.compat ? audioFor.compat.format_id : '', best: audioFor.best ? audioFor.best.format_id : '' },
    audioSizes: { compat: audioFor.compat ? size(audioFor.compat) : 0, best: audioFor.best ? size(audioFor.best) : 0 },
  };
}

const codecName = (c) => (/^av01/.test(c) ? 'AV1' : /^vp0?9/.test(c) ? 'VP9' : /^(hev|hvc)/.test(c) ? 'H.265' : /^avc/.test(c) ? 'H.264' : c.split('.')[0]);

module.exports = { YtDlp, buildArgs, parseLine, friendly, normalize };
