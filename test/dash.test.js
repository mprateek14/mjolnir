'use strict';
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const { Manager } = require('../src/engine/manager');
const { parseMpd, variantsOf, isoDuration, fill } = require('../src/engine/dash');

const waitFor = async (fn, ms = 60000) => {
  const t = Date.now();
  while (!(await fn())) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
};

function unit() {
  assert.strictEqual(isoDuration('PT1H2M3.5S'), 3723.5);
  assert.strictEqual(fill('seg-$RepresentationID$-$Number%05d$.m4s', { RepresentationID: 'v1', Number: 7 }), 'seg-v1-00007.m4s');

  // 4K plus lower qualities, template with timeline, nested BaseURL, separate audio
  const mpd = `<?xml version="1.0"?>
  <MPD type="static" mediaPresentationDuration="PT30S"><BaseURL>cdn/</BaseURL>
   <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
     <SegmentTemplate timescale="1000" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Time$.m4s">
       <SegmentTimeline><S t="0" d="10000" r="2"/></SegmentTimeline></SegmentTemplate>
     <Representation id="uhd" bandwidth="16000000" width="3840" height="2160" codecs="vp09.00.51.08" frameRate="60" mimeType="video/webm"/>
     <Representation id="hd" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028" frameRate="30"/>
     <Representation id="sd" bandwidth="1000000" width="640" height="360" codecs="avc1.4d401e" frameRate="30"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">
     <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2">
       <SegmentList><Initialization sourceURL="a/init.mp4"/><SegmentURL media="a/1.m4s" mediaRange="0-99"/><SegmentURL media="a/2.m4s"/></SegmentList>
     </Representation>
    </AdaptationSet>
   </Period></MPD>`;
  const m = parseMpd(mpd, 'https://example.com/v/manifest.mpd');
  assert.strictEqual(m.live, false);
  const v = variantsOf(m);
  assert.deepStrictEqual(v.map((x) => x.height), [2160, 1080, 360]);
  assert(v[0].label.includes('2160p60') && v[0].label.includes('VP9'), v[0].label);
  assert.strictEqual(v[0].add.audioId, 'a1');
  const uhd = m.reps.find((r) => r.id === 'uhd').segments();
  assert.strictEqual(uhd.init.url, 'https://example.com/v/cdn/uhd/init.mp4');
  assert.deepStrictEqual(uhd.segs.map((s) => s.url.split('/').pop()), ['0.m4s', '10000.m4s', '20000.m4s']);
  const a = m.reps.find((r) => r.id === 'a1').segments();
  assert.strictEqual(a.segs[0].range.end, 99);
  console.log('ok  manifest parsing: 4K/1080p/360p listed, templates, timelines, lists');

  assert.strictEqual(parseMpd(mpd.replace('type="static"', 'type="dynamic"'), 'https://x/y.mpd').live, true);
  const drm = parseMpd(mpd.replace('<Representation id="sd"', '<ContentProtection schemeIdUri="urn:uuid:edef8ba9"/><Representation id="sd"'), 'https://x/y.mpd');
  assert.strictEqual(drm.drm, true);
  console.log('ok  live and DRM manifests are flagged');
}

async function main() {
  unit();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftget-dash-'));
  const www = path.join(tmp, 'www');
  fs.mkdirSync(www);
  const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=8:size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=duration=8',
    '-map', '0:v', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-keyint_min', '25', '-sc_threshold', '0',
    '-b:v:0', '600k', '-s:v:1', '320x180', '-b:v:1', '200k', '-c:a', 'aac',
    '-f', 'dash', '-seg_duration', '2', '-adaptation_sets', 'id=0,streams=v id=1,streams=a', 'out.mpd'], { cwd: www });
  assert.strictEqual(r.status, 0, r.stderr.toString());

  const srv = http.createServer((req, res) => {
    const f = path.join(www, decodeURIComponent(req.url.split('?')[0]));
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': f.endsWith('.mpd') ? 'application/dash+xml' : 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  });
  await new Promise((rs) => srv.listen(0, '127.0.0.1', rs));
  const url = `http://127.0.0.1:${srv.address().port}/out.mpd`;

  const mgr = new Manager({ dataDir: path.join(tmp, 'data'), downloadDir: path.join(tmp, 'dl') });
  await mgr.init();
  const info = await mgr.probe(url);
  assert.strictEqual(info.type, 'dash');
  assert.strictEqual(info.variants.length, 2);
  console.log(`ok  probe lists: ${info.variants.map((v) => v.label).join(' | ')}`);

  for (const [i, v] of info.variants.entries()) {
    const d = mgr.add({ ...v.add, type: 'dash', quality: v.label, filename: `q${i}.mp4`, dir: path.join(tmp, 'dl') });
    await waitFor(() => ['completed', 'error'].includes(mgr.list().find((x) => x.id === d.id).status));
    const done = mgr.list().find((x) => x.id === d.id);
    assert.strictEqual(done.status, 'completed', done.error);
    const file = path.join(done.dir, done.filename);
    const probe = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-']);
    assert.strictEqual(probe.status, 0, probe.stderr.toString());
    const meta = spawnSync(ffmpeg, ['-i', file]).stderr.toString();
    assert(/Video:/.test(meta) && /Audio:/.test(meta), 'expected video and audio streams');
    const size = /(\d{2,4})x(\d{2,4})/.exec(meta.split('Video:')[1]);
    console.log(`ok  quality ${i} merged: ${size[1]}x${size[2]} with audio`);
  }
  assert.notStrictEqual(info.variants[0].add.videoId, info.variants[1].add.videoId);

  await mgr.shutdown();
  srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('all passed');
  process.exit(0);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
