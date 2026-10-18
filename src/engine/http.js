'use strict';
const http = require('http');
const https = require('https');
const { URL } = require('url');

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: Infinity }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: Infinity }),
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

class HttpError extends Error {
  constructor(status, message) { super(message || `HTTP ${status}`); this.status = status; }
}

function once(urlStr, { method = 'GET', headers = {}, signal, timeout = 30000 }) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch { return reject(new Error('Invalid URL')); }
    if (!agents[url.protocol]) return reject(new Error(`Unsupported protocol ${url.protocol}`));
    // Many sites serve a web page instead of the file to clients with no browser-like User-Agent.
    const h = { 'user-agent': UA, accept: '*/*', 'accept-encoding': 'identity', ...headers };
    if (url.username && !h.authorization) {
      h.authorization = 'Basic ' + Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64');
    }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, { method, headers: h, agent: agents[url.protocol] }, resolve);
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) return req.destroy(Object.assign(new Error('aborted'), { aborted: true }));
      signal.addEventListener('abort', () => req.destroy(Object.assign(new Error('aborted'), { aborted: true })), { once: true });
    }
    req.end();
  });
}

// Follows redirects by hand so cookies and auth can be dropped when the host changes.
async function request(urlStr, opts = {}) {
  let current = urlStr;
  let headers = { ...(opts.headers || {}) };
  for (let hops = 0; hops < 10; hops++) {
    const res = await once(current, { ...opts, headers });
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      const next = new URL(res.headers.location, current).href;
      if (new URL(next).host !== new URL(current).host) {
        delete headers.cookie; delete headers.authorization;
      }
      current = next;
      continue;
    }
    return { res, url: current };
  }
  throw new Error('Too many redirects');
}

module.exports = { request, HttpError };
