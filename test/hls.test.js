'use strict';
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const { Manager } = require('../src/engine/manager');
const { parsePlaylist } = require('../src/engine/hls');

const waitFor = async (fn, ms = 60000) => {
  const t = Date.now();
  while (!(await fn())) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
};

function run(args, cwd) {
  const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', ...args], { cwd });
  if (r.status !== 0) throw new Error(r.stderr.toString());
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftget-hls-'));
  const www = path.join(tmp, 'www');
  fs.mkdirSync(www);
  const src = ['-f', 'lavfi', '-i', 'testsrc=duration=8:size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=duration=8', '-c:v', 'libx264', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];

  // plain stream
  run([...src, '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', 'plain%d.ts', 'plain.m3u8'], www);
  // AES-128 stream with explicit key and IV
  const key = crypto.randomBytes(16);
  fs.writeFileSync(path.join(www, 'enc.key'), key);
  fs.writeFileSync(path.join(www, 'enc.keyinfo'), `enc.key\n${path.join(www, 'enc.key')}\n00112233445566778899aabbccddeeff\n`);
  run([...src, '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_key_info_file', 'enc.keyinfo', '-hls_segment_filename', 'enc%d.ts', 'enc.m3u8'], www);
  fs.writeFileSync(path.join(www, 'master.m3u8'),
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=320x240\nplain.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nenc.m3u8\n');

  const srv = http.createServer((req, res) => {
    const f = path.join(www, decodeURIComponent(req.url.split('?')[0]));
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  // parser
  const pl = parsePlaylist(fs.readFileSync(path.join(www, 'enc.m3u8'), 'utf8'), base + '/enc.m3u8');
  assert.strictEqual(pl.master, false);
  assert.strictEqual(pl.live, false);
  assert(pl.segments.length >= 3, 'expected several chunks');
  assert.strictEqual(pl.keys[1].method, 'AES-128');
  console.log(`ok  parsed ${pl.segments.length} chunks, AES-128 key found`);

  const mgr = new Manager({ dataDir: path.join(tmp, 'data'), downloadDir: path.join(tmp, 'dl') });
  await mgr.init();

  const info = await mgr.probe(base + '/master.m3u8');
  assert.strictEqual(info.type, 'hls');
  assert.strictEqual(info.variants.length, 2);
  assert(info.variants[0].label.startsWith('720p'));
  console.log(`ok  master playlist lists qualities: ${info.variants.map((v) => v.label).join(' | ')}`);

  const check = (file) => {
    const r = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-']);
    assert.strictEqual(r.status, 0, r.stderr.toString());
    const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(spawnSync(ffmpeg, ['-i', file]).stderr.toString());
    return Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
  };
  const finish = async (id) => {
    await waitFor(() => ['completed', 'error'].includes(mgr.list().find((d) => d.id === id).status));
    const d = mgr.list().find((x) => x.id === id);
    assert.strictEqual(d.status, 'completed', d.error);
    return d;
  };

  // plain variant
  const a = mgr.add({ url: info.variants[1].add.url, type: 'hls', filename: 'plain.mp4', dir: path.join(tmp, 'dl') });
  const da = await finish(a.id);
  const secs = check(path.join(da.dir, da.filename));
  assert(secs > 6 && secs < 10, `duration ${secs}`);
  console.log(`ok  plain HLS merged to playable mp4 (${secs}s)`);

  // encrypted variant (the 720p entry in the master)
  const e = mgr.add({ url: info.variants[0].add.url, type: 'hls', filename: 'enc.mp4', dir: path.join(tmp, 'dl') });
  const de = await finish(e.id);
  assert(check(path.join(de.dir, de.filename)) > 6);
  console.log('ok  AES-128 encrypted HLS decrypted and merged');
  assert(!fs.existsSync(path.join(de.dir, `.${de.filename}.hls`)), 'temp dir left behind');

  await mgr.shutdown();
  srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('all passed');
  process.exit(0);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
