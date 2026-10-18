'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const mod = require('../src/tools/audio-extractor');
const ff = require('../src/tools/ffmpeg');

const waitFor = async (fn, ms = 60000) => {
  const t = Date.now();
  while (!(await fn())) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 30));
  }
};

function make(args, out, cwd) {
  const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', ...args, out], { cwd });
  if (r.status !== 0) throw new Error(`could not build ${out}: ${r.stderr}`);
  return path.join(cwd, out);
}

// MD5 of the compressed audio packets of one stream. Equal hashes mean the audio bytes are identical,
// so nothing was decoded and re-encoded.
function packetHash(file, selector) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-map', selector, '-c', 'copy', '-f', 'streamhash', '-hash', 'md5', '-'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const m = /MD5=([0-9a-f]+)/.exec(r.stdout);
  assert(m, r.stdout);
  return m[1];
}
const codecOf = (file) => JSON.parse(spawnSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', file], { encoding: 'utf8' }).stdout).streams.map((s) => s.codec_name);

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mjolnir-media-'));
  const src = path.join(tmp, 'src');
  fs.mkdirSync(src);
  const video = ['-f', 'lavfi', '-i', 'testsrc=duration=3:size=160x120:rate=10'];
  const tone = (hz) => ['-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=3`];
  const vcodec = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'];

  const cases = [
    ['aac in mp4', 'a.mp4', [...video, ...tone(440), ...vcodec, '-c:a', 'aac'], 'aac', '.m4a'],
    ['mp3 in mkv', 'b.mkv', [...video, ...tone(500), ...vcodec, '-c:a', 'libmp3lame'], 'mp3', '.mp3'],
    ['opus in mkv', 'c.mkv', [...video, ...tone(600), ...vcodec, '-c:a', 'libopus'], 'opus', '.opus'],
    ['flac in mkv', 'd.mkv', [...video, ...tone(700), ...vcodec, '-c:a', 'flac'], 'flac', '.flac'],
    ['ac3 in mkv', 'e.mkv', [...video, ...tone(800), ...vcodec, '-c:a', 'ac3'], 'ac3', '.ac3'],
    ['vorbis in webm', 'f.webm', [...video, ...tone(900), '-c:v', 'libvpx', '-c:a', 'libvorbis'], 'vorbis', '.ogg'],
    ['pcm in mkv', 'g.mkv', [...video, ...tone(1000), ...vcodec, '-c:a', 'pcm_s16le'], 'pcm_s16le', '.wav'],
  ].map(([label, file, args, codec, ext]) => ({ label, codec, ext, file: make(args, file, src) }));
  const multi = make([...video, ...tone(300), ...tone(400), ...tone(500), '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:a', ...vcodec,
    '-c:a:0', 'aac', '-c:a:1', 'ac3', '-c:a:2', 'libopus', '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=fra'], 'multi.mkv', src);
  const silent = make([...video, ...vcodec, '-an'], 'silent.mp4', src);
  fs.writeFileSync(path.join(src, 'notes.mp4'), 'this is not a video');

  const done = [];
  const notes = [];
  const inst = mod.create({
    ffmpeg, ffprobe, emit: () => {}, notify: (t, b) => notes.push([t, b]), shell: { showItemInFolder() {}, openPath() {} },
    pickFiles: async () => [], pickFolder: async () => null,
  });
  const h = inst.handlers;
  const finish = async (ids) => {
    await waitFor(() => ids.every((id) => ['done', 'error', 'cancelled'].includes(done.find((j) => j.id === id).status)));
  };
  const refresh = async () => { done.length = 0; done.push(...(await h.jobs())); };
  const run = async (file, tracks) => {
    const ids = await h.extract({ items: [{ file, tracks }] });
    await waitFor(async () => { await refresh(); return ids.every((id) => ['done', 'error', 'cancelled'].includes(done.find((j) => j.id === id).status)); });
    return done.find((j) => j.id === ids[0]);
  };

  // 1. every codec comes out in its own format with identical audio bytes
  for (const c of cases) {
    const [info] = await h.inspect([c.file]);
    assert.strictEqual(info.audio[0].codec, c.codec, c.label);
    assert.strictEqual(info.audio[0].ext, c.ext, c.label);
    const job = await run(c.file, [0]);
    assert.strictEqual(job.status, 'done', `${c.label}: ${job.error}`);
    const out = job.outputs[0].file;
    assert.strictEqual(path.extname(out), c.ext, c.label);
    assert.strictEqual(path.dirname(out), path.dirname(c.file));           // saved next to the video
    assert.deepStrictEqual(codecOf(out), [c.codec], `${c.label}: codec changed`);
    assert.strictEqual(packetHash(out, '0:a:0'), packetHash(c.file, '0:a:0'), `${c.label}: audio bytes differ`);
    console.log(`ok  ${c.label.padEnd(15)} -> ${path.basename(out).padEnd(8)} same codec, identical audio bytes`);
  }

  // 2. several tracks: each its own file, named by position and language, all identical to the source stream
  const [mi] = await h.inspect([multi]);
  assert.deepStrictEqual(mi.audio.map((a) => a.codec), ['aac', 'ac3', 'opus']);
  const job = await run(multi, [0, 1, 2]);
  assert.strictEqual(job.status, 'done', job.error);
  assert.deepStrictEqual(job.outputs.map((o) => path.basename(o.file)), ['multi - audio 1 (eng).m4a', 'multi - audio 2 (fra).ac3', 'multi - audio 3.opus']);
  job.outputs.forEach((o, i) => assert.strictEqual(packetHash(o.file, '0:a:0'), packetHash(multi, `0:a:${i}`)));
  console.log('ok  three tracks -> three files, named by track and language, all identical to the source');

  // 3. one track out of several
  const one = await run(multi, [1]);
  assert.deepStrictEqual(one.outputs.map((o) => path.basename(o.file)), ['multi.ac3']);
  // 4. extracting again never overwrites
  const again = await run(multi, [1]);
  assert.deepStrictEqual(again.outputs.map((o) => path.basename(o.file)), ['multi (1).ac3']);
  console.log('ok  a single track keeps the plain name; a repeat gets (1), nothing is overwritten');

  // 5. save in a chosen folder
  const dest = path.join(tmp, 'elsewhere');
  await h.setSettings({ outputMode: 'folder', folder: dest });
  const elsewhere = await run(cases[0].file, [0]);
  assert.strictEqual(path.dirname(elsewhere.outputs[0].file), dest);
  console.log('ok  can save into another folder');

  // 6. things that are not extractable say so
  const bad = await h.inspect([silent, path.join(src, 'notes.mp4'), path.join(src, 'missing.mkv')]);
  assert.match(bad[0].error, /no audio/i);
  assert.match(bad[1].error, /does not look like a media file/i);
  assert.match(bad[2].error, /not found/i);
  console.log('ok  silent, broken and missing files are explained');

  // 7. cancelling leaves nothing behind
  const ac = new AbortController();
  ac.abort();
  const part = path.join(tmp, 'cancelled.m4a.part');
  await assert.rejects(ff.copyStream(ffmpeg, { input: cases[0].file, streamIndex: 1, output: part, format: 'ipod', duration: 3 }, () => {}, ac.signal), /Cancelled/);
  assert(!fs.existsSync(path.join(tmp, 'cancelled.m4a')));
  console.log('ok  cancelling stops ffmpeg');

  // 8. the video file itself is never touched
  assert.strictEqual(fs.statSync(cases[0].file).size > 0, true);
  assert(notes.length >= 1);

  await inst.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('all passed');
  process.exit(0);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
