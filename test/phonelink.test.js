'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { PhoneLink } = require('../src/phonelink/server');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftget-phone-'));
  const added = [];
  const notes = [];
  const phone = new PhoneLink({
    dataDir: tmp,
    route: async (url) => {
      if (/bad\.example/.test(url)) throw new Error('That is a playlist. Open it on the PC.');
      added.push(url);
      return { where: /youtube/.test(url) ? 'YouTube' : 'Direct download', key: 'k', id: String(added.length), title: 'Title ' + added.length };
    },
    peek: (key, id) => (id === '1' ? { status: 'running', percent: 0.5, title: 'Live title', size: 100 } : null),
    onReceive: (n) => notes.push(n),
  });
  await phone.start();
  assert(phone.port >= 24681);
  const base = `http://127.0.0.1:${phone.port}`;
  const call = async (p, body, token) => {
    const r = await fetch(base + p, {
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };

  // the page itself needs no key, the API does
  const html = await (await fetch(base + '/')).text();
  assert(html.includes('Send to Mjolnir'));
  assert.strictEqual((await call('/api/send', { urls: ['https://a.com/x.zip'] })).status, 401);
  assert.strictEqual((await call('/api/recent', null, 'nope')).status, 401);
  console.log('ok  page is served, API refuses unknown phones');

  // pairing: code works once
  const pair = await phone.pairing('127.0.0.1');
  assert(pair.link.includes('/?pair=') && pair.qr.startsWith('data:image/png'));
  const code = new URL(pair.link).searchParams.get('code') || new URL(pair.link).searchParams.get('pair');
  let r = await call('/api/pair', { code });
  assert.strictEqual(r.status, 200);
  const token = r.json.token;
  assert(token && token.length >= 40);
  assert.strictEqual((await call('/api/pair', { code })).status, 400);       // reused
  assert.deepStrictEqual(notes[0], { paired: 'Phone 1' });
  console.log('ok  a code pairs one phone, once');

  // the key is stored hashed, never in plain text
  assert(!fs.readFileSync(path.join(tmp, 'phonelink.json'), 'utf8').includes(token));
  assert.strictEqual(phone.info().devices.length, 1);
  console.log('ok  only a hash of the key is saved');

  // sending
  r = await call('/api/send', { urls: ['https://a.com/file.zip', 'https://www.youtube.com/watch?v=abc', 'https://bad.example/playlist', 'ftp://x/y', 'javascript:alert(1)', 'not a url'] }, token);
  assert.strictEqual(r.status, 200);
  const res = r.json.results;
  assert.deepStrictEqual(res.map((x) => x.ok), [true, true, false, false, false, false]);
  assert.strictEqual(res[1].where, 'YouTube');
  assert(/playlist/.test(res[2].error));
  assert(/http/.test(res[3].error));
  assert.deepStrictEqual(added, ['https://a.com/file.zip', 'https://www.youtube.com/watch?v=abc']);
  assert.deepStrictEqual(notes[1], { device: 'Phone 1', count: 2, targets: [{ key: 'k', where: 'YouTube' }] });
  const manifest = await (await fetch(base + '/manifest.json')).json();
  assert.strictEqual(manifest.display, 'standalone');
  assert.strictEqual((await fetch(base + '/icon.png')).headers.get('content-type'), 'image/png');
  console.log('ok  links are routed, bad ones are rejected with a reason');

  // links pointing back at this PC's own phone page are refused
  const me = phone.addresses()[0];
  if (me) {
    r = await call('/api/send', { urls: [`http://${me}:${phone.port}/`] }, token);
    assert.strictEqual(r.json.results[0].ok, false);
  }

  // status feed
  r = await call('/api/recent', null, token);
  assert.strictEqual(r.json.items.length, 2);
  const live = r.json.items.find((i) => i.url.includes('file.zip'));
  assert.deepStrictEqual([live.status, live.percent, live.title], ['running', 0.5, 'Live title']);
  assert.strictEqual(r.json.items.find((i) => i.url.includes('youtube')).status, 'gone');
  console.log('ok  the phone can watch progress');

  // limits
  const big = await fetch(base + '/api/send', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: 'x'.repeat(70000) }).then((x) => x.status);
  assert.strictEqual(big, 413);
  for (let i = 0; i < 8; i++) await call('/api/recent', null, 'wrong' + i);
  assert.strictEqual((await call('/api/recent', null, token)).status, 429);   // locked out after repeated wrong keys
  console.log('ok  oversized requests and repeated wrong keys are stopped');
  phone.fails.clear();

  // revoking cuts a phone off
  phone.revoke(phone.info().devices[0].id);
  assert.strictEqual((await call('/api/send', { urls: ['https://a.com/y'] }, token)).status, 401);
  console.log('ok  a removed phone loses access');

  // expired code
  const old = await phone.pairing('127.0.0.1');
  const oldCode = new URL(old.link).searchParams.get('pair');
  phone.codes.set(oldCode, Date.now() - 1);
  assert.strictEqual((await call('/api/pair', { code: oldCode })).status, 400);
  console.log('ok  expired codes are refused');

  // off means off, and it remembers across restarts
  await phone.shutdown();
  assert.strictEqual(phone.server, null);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'phonelink.json'), 'utf8')).enabled, true);
  await assert.rejects(fetch(base + '/'));
  const again = new PhoneLink({ dataDir: tmp, route: async () => ({}), peek: () => null });
  assert.strictEqual(again.state.enabled, true);
  await again.start();
  await again.stop();
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'phonelink.json'), 'utf8')).enabled, false);
  console.log('ok  stopping closes the port; quitting keeps the setting');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('all passed');
  process.exit(0);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
