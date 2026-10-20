'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EXT_ID, EXT_ORIGIN, extensionIdFromKey, authorize, corsHeaders } = require('../src/bridgeauth');

const host = '127.0.0.1:24680';

// The ID the app trusts must be the ID the extension's manifest key produces.
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/manifest.json'), 'utf8'));
assert(manifest.key, 'the manifest needs a key so the extension keeps one ID');
assert.strictEqual(extensionIdFromKey(manifest.key), EXT_ID);
assert(/^[a-p]{32}$/.test(EXT_ID));
// the popup carries the same ID, so it can tell a copy with another ID from a version mismatch
const popup = fs.readFileSync(path.join(__dirname, '../extension/popup.js'), 'utf8');
assert(popup.includes(`'${EXT_ID}'`), 'popup.js must name the same extension ID');
console.log('ok  the manifest key gives the extension ID the app trusts');

// our extension
assert.strictEqual(authorize({ host, origin: EXT_ORIGIN }, 'tok'), true);
assert.strictEqual(authorize({ host: 'localhost:24680', origin: EXT_ORIGIN }, 'tok'), true);
console.log('ok  our extension is accepted without a token');

// web pages and other extensions
assert.strictEqual(authorize({ host, origin: 'https://evil.example' }, 'tok'), false);
assert.strictEqual(authorize({ host, origin: 'http://127.0.0.1:24680' }, 'tok'), false);
assert.strictEqual(authorize({ host, origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' }, 'tok'), false);
assert.strictEqual(authorize({ host, origin: 'null' }, 'tok'), false);
assert.strictEqual(authorize({ host }, 'tok'), false, 'no Origin and no token');
assert.strictEqual(authorize({ host, origin: EXT_ORIGIN.toUpperCase() }, 'tok'), false, 'exact match only');
console.log('ok  web pages and other extensions are refused');

// the old token still works for extensions from earlier releases
assert.strictEqual(authorize({ host, 'x-mjolnir-token': 'tok' }, 'tok'), true);
assert.strictEqual(authorize({ host, 'x-icefox-token': 'tok' }, 'tok'), true);
assert.strictEqual(authorize({ host, 'x-mjolnir-token': 'wrong' }, 'tok'), false);
assert.strictEqual(authorize({ host, 'x-mjolnir-token': 'x' }, ''), false, 'an empty saved token never matches');
console.log('ok  the old token still works, a wrong one does not');

// a page reaching the bridge under its own name (DNS rebinding) is refused, even with our origin
assert.strictEqual(authorize({ host: 'rebind.evil.example:24680', origin: EXT_ORIGIN }, 'tok'), false);
assert.strictEqual(authorize({ origin: EXT_ORIGIN }, 'tok'), false);
console.log('ok  other host names are refused');

// only our extension may read the answers
assert.strictEqual(corsHeaders({ origin: EXT_ORIGIN })['Access-Control-Allow-Origin'], EXT_ORIGIN);
assert.strictEqual(corsHeaders({ origin: 'https://evil.example' })['Access-Control-Allow-Origin'], undefined);
assert.strictEqual(corsHeaders({})['Access-Control-Allow-Origin'], undefined);
console.log('ok  answers are readable only by our extension');

console.log('all passed');
