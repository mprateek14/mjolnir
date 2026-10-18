'use strict';
// Needs internet. Talks to GitHub and YouTube, so it is not part of `npm test`. Run: npm run test:live
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const { YtDlp } = require('../src/downloaders/youtube/ytdlp');

const VIDEO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'; // 19 second public video

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftget-yt-'));
  const electron = require('electron'); // path string when required from plain Node
  const yt = new YtDlp({ binDir: path.join(tmp, 'bin'), ffmpeg, ffprobe, jsRuntime: { path: electron, env: { ELECTRON_RUN_AS_NODE: '1' } } });

  assert.strictEqual(yt.installed(), false);
  let last = 0;
  const v = await yt.install((p) => { last = p; });
  assert(v && /^\d{4}\./.test(v), `version ${v}`);
  assert(last > 0.99);
  console.log(`ok  installed yt-dlp ${v} with checksum verified`);

  const info = await yt.info(VIDEO);
  assert.strictEqual(info.kind, 'video');
  assert(info.title && info.duration === 19);
  assert(info.qualities.length >= 2);
  console.log(`ok  info: "${info.title}", qualities ${info.qualities.map((q) => q.label).join(', ')}`);

  const dir = path.join(tmp, 'out');
  const seen = { progress: 0, stages: new Set() };
  const job = { url: VIDEO, opts: { mode: 'video', height: 240, container: 'compat', thumb: true, meta: true } };
  const files = await yt.download(job, { dir }, {
    progress: () => { seen.progress++; },
    stage: (s) => seen.stages.add(s),
  }).done;
  assert.strictEqual(files.length, 1, JSON.stringify(files));
  const f = files[0];
  assert(fs.existsSync(f) && f.endsWith('.mp4'), f);
  const meta = spawnSync(ffmpeg, ['-i', f]).stderr.toString();
  assert(/Video:/.test(meta) && /Audio:/.test(meta));
  assert(seen.progress > 0);
  console.log(`ok  video download -> ${path.basename(f)} (${seen.progress} progress updates, stages: ${[...seen.stages].join(',')})`);

  const audio = await yt.download({ url: VIDEO, opts: { mode: 'audio', audioFormat: 'mp3' } }, { dir }, {}).done;
  assert(audio[0].endsWith('.mp3') && fs.statSync(audio[0]).size > 10000);
  console.log('ok  audio-only mp3');

  // MKV with an embedded thumbnail and tags needs ffprobe next to ffmpeg
  const mkv = await yt.download({ url: VIDEO, opts: { mode: 'video', height: 240, container: 'best', thumb: true, meta: true } }, { dir: path.join(tmp, 'mkv') }, {}).done;
  assert(mkv[0].endsWith('.mkv') && fs.statSync(mkv[0]).size > 10000, mkv[0]);
  console.log('ok  mkv with thumbnail and metadata');

  // pause = kill, resume = run again and finish
  const h = yt.download({ url: VIDEO, opts: { mode: 'video', height: 144, container: 'best' } }, { dir: path.join(tmp, 'out2') }, {});
  setTimeout(() => h.kill(), 1500);
  assert.strictEqual(await h.done, null);
  const again = await yt.download({ url: VIDEO, opts: { mode: 'video', height: 144, container: 'best' } }, { dir: path.join(tmp, 'out2') }, {}).done;
  assert(fs.existsSync(again[0]));
  console.log('ok  kill then rerun completes');

  await assert.rejects(yt.info('https://www.youtube.com/watch?v=aaaaaaaaaaa'), /unavailable|not a valid|Incomplete/i);
  console.log('ok  bad video gives a readable error');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('all passed');
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
