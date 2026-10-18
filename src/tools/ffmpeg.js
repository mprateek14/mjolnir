'use strict';
// Everything that runs ffmpeg or ffprobe for the media tools lives here. No Electron imports.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn, execFile } = require('child_process');

// The container each audio codec is stored in unchanged. Anything not listed goes into Matroska audio (.mka),
// which can hold any codec as-is.
const BY_CODEC = {
  aac: ['.m4a', 'ipod'], alac: ['.m4a', 'ipod'],
  mp3: ['.mp3', 'mp3'], mp2: ['.mp2', 'mp2'],
  opus: ['.opus', 'opus'], vorbis: ['.ogg', 'ogg'], flac: ['.flac', 'flac'],
  ac3: ['.ac3', 'ac3'], eac3: ['.eac3', 'eac3'], dts: ['.dts', 'dts'], truehd: ['.thd', 'truehd'],
  wmav1: ['.wma', 'asf'], wmav2: ['.wma', 'asf'], wmapro: ['.wma', 'asf'],
  amr_nb: ['.amr', 'amr'], amr_wb: ['.amr', 'amr'],
  pcm_u8: ['.wav', 'wav'], pcm_s16le: ['.wav', 'wav'], pcm_s24le: ['.wav', 'wav'], pcm_s32le: ['.wav', 'wav'], pcm_f32le: ['.wav', 'wav'], pcm_f64le: ['.wav', 'wav'],
  pcm_s16be: ['.aiff', 'aiff'], pcm_s24be: ['.aiff', 'aiff'], pcm_s32be: ['.aiff', 'aiff'],
};
const FALLBACK = ['.mka', 'matroska'];
const NAMES = {
  aac: 'AAC', alac: 'ALAC', mp3: 'MP3', mp2: 'MP2', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', ac3: 'Dolby Digital (AC-3)', eac3: 'Dolby Digital Plus',
  dts: 'DTS', truehd: 'Dolby TrueHD', wmav1: 'WMA', wmav2: 'WMA', wmapro: 'WMA Pro', amr_nb: 'AMR', amr_wb: 'AMR-WB',
};
const codecName = (c) => NAMES[c] || (/^pcm_/.test(c) ? 'PCM (uncompressed)' : String(c || 'audio').toUpperCase());
const containerFor = (codec) => BY_CODEC[codec] || FALLBACK;

function run(bin, args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve(stdout);
    });
  });
}

// What is inside a file: its length and every audio track, with the file each would be saved as.
async function probe(ffprobe, file) {
  const out = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(out);
  const streams = j.streams || [];
  const audio = streams.filter((s) => s.codec_type === 'audio').map((s, n) => {
    const [ext] = containerFor(s.codec_name);
    const t = s.tags || {};
    return {
      n, index: s.index, codec: s.codec_name, codecLabel: codecName(s.codec_name), ext,
      channels: s.channels || 0, layout: s.channel_layout || '', sampleRate: Number(s.sample_rate) || 0,
      bitRate: Number(s.bit_rate) || Number(t.BPS) || 0, lang: t.language && t.language !== 'und' ? t.language : '', title: t.title || '',
      isDefault: !!(s.disposition && s.disposition.default),
    };
  });
  return {
    duration: Number(j.format && j.format.duration) || 0, size: Number(j.format && j.format.size) || 0,
    hasVideo: streams.some((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic)), audio,
  };
}

// Copies one audio stream out of the file. `-c copy` means the audio bytes are not decoded or encoded.
function copyArgs({ input, streamIndex, output, format }) {
  return ['-hide_banner', '-nostdin', '-n', '-loglevel', 'error', '-i', input, '-map', `0:${streamIndex}`, '-vn', '-sn', '-dn',
    '-c', 'copy', '-map_chapters', '-1', '-f', format, '-progress', 'pipe:1', '-nostats', output];
}

// Runs ffmpeg and reports 0..1. Resolves when finished, rejects with ffmpeg's own message.
function copyStream(ffmpeg, opts, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, copyArgs(opts), { windowsHide: true });
    let err = '';
    let buf = '';
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(l);   // both are microseconds
        if (m && opts.duration > 0) onProgress(Math.min(1, Number(m[1]) / 1e6 / opts.duration));
      }
    });
    const kill = () => { p.kill(); };
    if (signal) {
      if (signal.aborted) kill();
      signal.addEventListener('abort', kill, { once: true });
    }
    p.on('error', reject);
    p.on('close', (code) => {
      if (signal && signal.aborted) return reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `ffmpeg exited with ${code}`));
    });
  });
}

// A name that does not clash with anything already there: "Song.m4a", then "Song (1).m4a".
function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, base + ext);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

const clean = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();

module.exports = { probe, copyStream, copyArgs, containerFor, codecName, uniquePath, clean, fsp };
