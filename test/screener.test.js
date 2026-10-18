'use strict';
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const cheerio = require('cheerio');
const s = require('../src/downloaders/screener/scraper');

async function main() {
  // 1. Parsing matches what screener_downloader.py produced for the same HTML (golden file made by running the script).
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'screener-sample.html'), 'utf8');
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'screener-expected.json'), 'utf8'));
  const $ = cheerio.load(html);
  const got = {
    'Annual Reports': s.parseAnnualReports($),
    'Credit Ratings': s.parseCreditRatings($),
    'Concalls': s.parseConcalls($),
  };
  for (const [section, rows] of Object.entries(golden)) {
    const mine = got[section].map((i) => [i.url, s.sanitizeFilename(i.name)]);
    assert.deepStrictEqual(mine, rows, section);
  }
  console.log(`ok  parsed ${Object.values(golden).map((r) => r.length).join(' + ')} items, identical to the Python script`);

  // 2. Names and input handling
  assert.strictEqual(s.sanitizeFilename('Q1 FY25: <Results> / "Call"?'), 'Q1_FY25_Results_Call');
  assert.strictEqual(s.sanitizeFilename('  ._  '), 'file');
  assert.strictEqual(s.sanitizeFilename('x'.repeat(300)).length, 150);
  assert.strictEqual(s.parseInput('avantel'), 'AVANTEL');
  assert.strictEqual(s.parseInput('https://www.screener.in/company/AVANTEL/consolidated/'), 'AVANTEL');
  assert.throws(() => s.parseInput('https://www.screener.in/screens/'), /ticker/);
  assert.strictEqual(s.extensionFromUrl('https://x.com/a/Report.PDF?x=1'), '.pdf');
  assert.strictEqual(s.extensionFromUrl('https://x.com/a/page'), '');
  console.log('ok  file names and ticker parsing follow the script');

  // 3. Download rules against a local server
  let flaky = 0;
  const srv = http.createServer((req, res) => {
    const body = Buffer.from('%PDF-1.4 test ' + req.url);
    if (req.url === '/a.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(body); }
    else if (req.url === '/noext') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(body); }
    else if (req.url === '/talk.mp3') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(body); }   // extension wins
    else if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<html>login</html>'); }
    else if (req.url === '/flaky.pdf') { if (flaky++ < 1) { res.writeHead(503); res.end(); } else { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(body); } }
    else if (req.url === '/go') { res.writeHead(302, { location: '/a.pdf' }); res.end(); }
    else { res.writeHead(404, { 'content-type': 'text/html' }); res.end('nope'); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftget-screener-'));
  const dir = path.join(tmp, 'TICK', 'Annual Reports');
  const dlf = (url, name, extra = {}) => s.downloadFile({ url: base + url, dir, baseName: name, force: false, delay: 0, retries: 1, ...extra });

  let r = await dlf('/a.pdf', 'Annual_Report_2025');
  assert.strictEqual(r.result, 'downloaded');
  assert.strictEqual(path.basename(r.file), 'Annual_Report_2025.pdf');
  r = await dlf('/a.pdf', 'Annual_Report_2025');
  assert.strictEqual(r.result, 'skipped');
  r = await dlf('/a.pdf', 'Annual_Report_2025', { force: true });
  assert.strictEqual(path.basename(r.file), 'Annual_Report_2025_2.pdf');
  r = await dlf('/a.pdf', 'Annual_Report_2025', { force: true });
  assert.strictEqual(path.basename(r.file), 'Annual_Report_2025_3.pdf');
  console.log('ok  download, skip when present, _2 and _3 when forced');

  r = await dlf('/noext', 'Octet');
  assert.strictEqual(path.basename(r.file), 'Octet.pdf');
  r = await dlf('/talk.mp3', 'Recording_2025Jun_Concall');
  assert.strictEqual(path.basename(r.file), 'Recording_2025Jun_Concall.mp3');
  r = await dlf('/go', 'Redirected');
  assert.strictEqual(r.result, 'downloaded');
  console.log('ok  extension from URL, then content type, octet-stream saved as pdf, redirects followed');

  r = await dlf('/page', 'Some_Page');
  assert.strictEqual(r.result, 'reference');
  assert.strictEqual(path.basename(r.file), 'Some_Page_LINK.txt');
  const text = fs.readFileSync(r.file, 'utf8').replace(/\r\n/g, '\n');
  assert.strictEqual(text, `Could not download a file directly (HTTP 200, Content-Type: text/html).\nOriginal link:\n${base}/page\n`);
  r = await dlf('/gone', 'Missing');
  assert.strictEqual(r.result, 'reference');
  assert(fs.readFileSync(r.file, 'utf8').includes('HTTP 404'));
  console.log('ok  pages and errors become _LINK.txt like the script');

  r = await dlf('/flaky.pdf', 'Flaky');
  assert.strictEqual(r.result, 'downloaded');
  console.log('ok  503 is retried');

  r = await s.downloadFile({ url: 'http://127.0.0.1:1/x.pdf', dir, baseName: 'Dead', force: false, delay: 0, retries: 0 });
  assert.strictEqual(r.result, 'failed');
  assert(!fs.readdirSync(dir).some((n) => n.endsWith('.part')), 'no partial files left');
  console.log('ok  unreachable host is reported as failed');

  // 4. A host that sends untidy headers, which strict clients reject
  const odd = net.createServer((sock) => {
    sock.once('data', () => {
      sock.write('HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nX-Policy: a \r\n  b\r\nContent-Length: 9\r\nConnection: close\r\n\r\n%PDF-test');
      sock.end();
    });
  });
  await new Promise((rs) => odd.listen(0, '127.0.0.1', rs));
  const strict = await fetch(`http://127.0.0.1:${odd.address().port}/x.pdf`).then(() => 'ok', () => 'rejected');
  r = await s.downloadFile({ url: `http://127.0.0.1:${odd.address().port}/x.pdf`, dir, baseName: 'Odd', force: false, delay: 0, retries: 0 });
  assert.strictEqual(r.result, 'downloaded');
  console.log(`ok  untidy headers accepted (fetch says: ${strict})`);

  srv.close(); odd.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('all passed');
  process.exit(0);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
