'use strict';
const assert = require('assert');
const { check, compare, parse, isReleaseUrl } = require('../src/updates');

const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });

async function main() {
  // version order
  assert.deepStrictEqual(parse('v0.1.12-beta'), [0, 1, 12]);
  assert(compare('0.1.3', '0.1.2') > 0);
  assert(compare('0.2.0', '0.1.99') > 0);
  assert(compare('1.0.0', '0.9.9') > 0);
  assert(compare('0.1.10', '0.1.9') > 0, 'numbers, not text');
  assert(compare('0.1.2', '0.1.2') === 0);
  assert(compare('v0.1.2', '0.1.2') === 0);
  assert(compare('0.1.1', '0.1.2') < 0);
  console.log('ok  version order');

  // newer, same and older releases
  const rel = (tag) => ({ tag_name: tag, name: `Mjolnir ${tag.replace(/^v/, '')}`, html_url: `https://github.com/mprateek14/mjolnir/releases/tag/${tag}` });
  let r = await check('0.1.2', reply(200, rel('v0.1.3')));
  assert.strictEqual(r.newer, true);
  assert.strictEqual(r.latest.version, '0.1.3');
  assert.strictEqual(r.latest.url, 'https://github.com/mprateek14/mjolnir/releases/tag/v0.1.3');
  r = await check('0.1.3', reply(200, rel('v0.1.3')));
  assert.strictEqual(r.newer, false);
  r = await check('0.2.0', reply(200, rel('v0.1.3')));
  assert.strictEqual(r.newer, false, 'a newer local build is not an update');
  console.log('ok  newer, same and older');

  // nothing published, errors and odd answers
  r = await check('0.1.2', reply(404, {}));
  assert.strictEqual(r.latest, null);
  assert.strictEqual(r.newer, false);
  await assert.rejects(check('0.1.2', reply(403, {})), /GitHub answered 403/);
  await assert.rejects(check('0.1.2', async () => { throw new Error('offline'); }), /Could not reach GitHub/);
  await assert.rejects(check('0.1.2', reply(200, { name: 'x' })), /without a version/);
  console.log('ok  no release, GitHub errors, offline');

  // a release address from somewhere else is never passed on
  r = await check('0.1.2', reply(200, { tag_name: 'v0.1.3', html_url: 'https://evil.example/payload' }));
  assert(isReleaseUrl(r.latest.url));
  assert.strictEqual(r.latest.url, 'https://github.com/mprateek14/mjolnir/releases/latest');
  assert(!isReleaseUrl('https://github.com/someone-else/mjolnir/releases/tag/v9'));
  assert(!isReleaseUrl('file:///C:/Windows/System32/calc.exe'));
  console.log('ok  only this project\'s release pages');

  console.log('all passed');
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
