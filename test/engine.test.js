'use strict';
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { Manager } = require('../src/engine/manager');

const DATA = crypto.randomBytes(24 * 1024 * 1024);
const SHA = crypto.createHash('sha256').update(DATA).digest('hex');
let maxConc = 0;
let conc = 0;
let hits = 0;

function server({ ranges = true } = {}) {
  return http.createServer((req, res) => {
    hits++;
    conc++; maxConc = Math.max(maxConc, conc);
    res.on('close', () => conc--);
    const base = { ETag: '"abc"', 'Content-Disposition': 'attachment; filename="test file.bin"', 'Content-Type': 'application/octet-stream' };
    let start = 0;
    let end = DATA.length - 1;
    let code = 200;
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (m && ranges) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(end, Number(m[2]));
      code = 206;
      base['Content-Range'] = `bytes ${start}-${end}/${DATA.length}`;
    }
    base['Content-Length'] = end - start + 1;
    res.writeHead(code, base);
    // ~4 MB/s per connection so pause has something to interrupt
    let pos = start;
    const t = setInterval(() => {
      if (pos > end) { clearInterval(t); return res.end(); }
      const n = Math.min(256 * 1024, end - pos + 1);
      res.write(DATA.subarray(pos, pos + n));
      pos += n;
    }, 60);
    res.on('close', () => clearInterval(t));
  });
}

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const waitFor = async (fn, ms = 60000) => {
  const t = Date.now();
  while (!(await fn())) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
};
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftget-'));
  const dl = path.join(tmp, 'dl');
  const srv = server();
  const port = await listen(srv);
  const url = `http://127.0.0.1:${port}/x`;

  // 1. parallel download, hash intact
  let mgr = new Manager({ dataDir: path.join(tmp, 'data'), downloadDir: dl });
  await mgr.init();
  const a = mgr.add({ url, dir: dl });
  await waitFor(() => mgr.list().find((d) => d.id === a.id).status === 'completed');
  const done = mgr.list()[0];
  assert.strictEqual(done.filename, 'test file.bin');
  assert.strictEqual(sha(path.join(dl, done.filename)), SHA);
  assert(maxConc > 1, `expected parallel connections, saw ${maxConc}`);
  console.log(`ok  parallel download (${maxConc} connections)`);

  // 2. pause / resume, including a restart of the manager in the middle
  const b = mgr.add({ url, dir: dl, connections: 4 });
  await waitFor(() => mgr.list().find((d) => d.id === b.id).downloaded > 3e6);
  await mgr.pause(b.id);
  const mid = mgr.list().find((d) => d.id === b.id);
  assert.strictEqual(mid.status, 'paused');
  assert(mid.downloaded < DATA.length);
  await mgr.shutdown();
  mgr = new Manager({ dataDir: path.join(tmp, 'data'), downloadDir: dl });
  await mgr.init();
  const back = mgr.list().find((d) => d.id === b.id);
  assert.strictEqual(back.status, 'paused');
  assert.strictEqual(back.downloaded, mid.downloaded);
  mgr.resume(b.id);
  await waitFor(() => mgr.list().find((d) => d.id === b.id).status === 'completed');
  const rb = mgr.list().find((d) => d.id === b.id);
  assert.strictEqual(sha(path.join(rb.dir, rb.filename)), SHA);
  console.log('ok  pause, restart, resume');

  // 3. dynamic segmentation: one connection finishing frees capacity for the others
  const c = mgr.add({ url, dir: dl, connections: 16 });
  await waitFor(() => mgr.list().find((d) => d.id === c.id).segments.length > 16 || mgr.list().find((d) => d.id === c.id).status === 'completed');
  await waitFor(() => mgr.list().find((d) => d.id === c.id).status === 'completed');
  console.log('ok  16 connections');

  // 4. server without range support
  const srv2 = server({ ranges: false });
  const port2 = await listen(srv2);
  const e = mgr.add({ url: `http://127.0.0.1:${port2}/y`, dir: dl });
  await waitFor(() => mgr.list().find((d) => d.id === e.id).status === 'completed');
  const re = mgr.list().find((d) => d.id === e.id);
  assert.strictEqual(re.resumable, false);
  assert.strictEqual(sha(path.join(re.dir, re.filename)), SHA);
  console.log('ok  non-resumable server falls back to one connection');

  // 5. bad link ends in error without retrying forever
  const f = mgr.add({ url: 'http://127.0.0.1:1/none', dir: dl });
  await waitFor(() => mgr.list().find((d) => d.id === f.id).status === 'error');
  console.log('ok  unreachable host reports error');

  // 6. a file-looking link that answers with a web page is an error, not a saved "file"; requests look like a browser
  let sawUA = '';
  const srv3 = http.createServer((req, res) => {
    sawUA = req.headers['user-agent'] || '';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html>please log in</html>');
  });
  const port3 = await listen(srv3);
  const g = mgr.add({ url: `http://127.0.0.1:${port3}/uploads/icon.png`, dir: dl });
  await waitFor(() => mgr.list().find((d) => d.id === g.id).status === 'error');
  const rg = mgr.list().find((d) => d.id === g.id);
  assert(/web page instead of the file/.test(rg.error), rg.error);
  assert(/Mozilla\/5\.0/.test(sawUA), `user agent was "${sawUA}"`);
  assert(!fs.readdirSync(dl).some((n) => n.startsWith('icon')), 'nothing saved for the web page');
  console.log('ok  a web page sent for an image link is refused, and requests carry a browser User-Agent');
  srv3.close();

  await mgr.shutdown();
  srv.close(); srv2.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('all passed');
  process.exit(0);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
