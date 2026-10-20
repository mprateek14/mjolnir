'use strict';
// Who may talk to the local bridge the browser extension uses.
//
// Any web page can send requests to 127.0.0.1, so the bridge has to know a request came from our extension.
// A browser stamps every cross-origin request with an Origin header that a web page cannot change. Our extension
// has a fixed ID (the `key` in extension/manifest.json), so its requests carry exactly EXT_ORIGIN.
// An extension from before this check proves itself with the old token instead, so it keeps working until updated.
const crypto = require('crypto');

const EXT_ID = 'kmkgfbkfpgliogcihlckmhojihgmppkj';
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;

// Chromium derives an extension's ID from its public key: the first 16 bytes of the SHA-256, written with a-p.
function extensionIdFromKey(keyBase64) {
  const hex = crypto.createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

// A page on the web cannot reach the bridge under another name (DNS rebinding), only by its own address.
const hostOk = (h) => /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(String(h || ''));

// headers: Node's lowercase request headers. legacyToken: the token older extensions send.
function authorize(headers, legacyToken) {
  if (!hostOk(headers.host)) return false;
  if (headers.origin === EXT_ORIGIN) return true;
  const sent = headers['x-mjolnir-token'] || headers['x-icefox-token'];
  return !!legacyToken && !!sent && sent === legacyToken;
}

// Only our extension may read answers from the bridge.
function corsHeaders(headers) {
  const h = { 'Access-Control-Allow-Headers': 'content-type, x-mjolnir-token, x-icefox-token', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', Vary: 'Origin' };
  if (headers.origin === EXT_ORIGIN) h['Access-Control-Allow-Origin'] = EXT_ORIGIN;
  return h;
}

module.exports = { EXT_ID, EXT_ORIGIN, extensionIdFromKey, authorize, corsHeaders, hostOk };
