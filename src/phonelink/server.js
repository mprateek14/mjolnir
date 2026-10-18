'use strict';
// Lets a paired phone on the same Wi-Fi send links to this PC. Off until the user turns it on.
// This file knows nothing about how links are downloaded: it is given three functions for that.
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const page = require('./page');

const DEFAULT_PORT = 24681;
const CODE_TTL = 5 * 60 * 1000;
const MAX_BODY = 64 * 1024;
const MAX_URLS = 50;
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

class PhoneLink {
  // route(url)  -> { where, key, id, title } or throws with a readable message
  // peek(key, id) -> { status, percent, title, size } | null
  // onReceive({ device, count, targets }) is for the desktop notification; targets say which downloaders got links
  constructor({ dataDir, route, peek, onReceive = () => {} }) {
    this.file = path.join(dataDir, 'phonelink.json');
    this.route = route;
    this.peek = peek;
    this.onReceive = onReceive;
    this.server = null;
    this.port = 0;
    this.state = { enabled: false, devices: [] };
    this.codes = new Map();      // pairing code -> expiry
    this.sent = new Map();       // device id -> recent items
    this.fails = new Map();      // ip -> { n, until }
    try { this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch { /* first run */ }
  }

  save() {
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.state)); } catch { /* keep running */ }
  }

  // The addresses a phone could use, best guess first (home networks are usually 192.168.x.x).
  addresses() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
    const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
    return out.sort((a, b) => rank(a) - rank(b));
  }

  async start() {
    if (this.server) return;
    for (let p = DEFAULT_PORT; p < DEFAULT_PORT + 10; p++) {
      try {
        await new Promise((resolve, reject) => {
          const s = http.createServer((req, res) => this.handle(req, res));
          s.once('error', reject);
          s.listen(p, '0.0.0.0', () => { s.removeListener('error', reject); this.server = s; this.port = p; resolve(); });
        });
        break;
      } catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
    }
    if (!this.server) throw new Error('No free port for the phone link');
    this.server.on('error', () => {});
    this.state.enabled = true;
    this.save();
  }

  async stop() {
    const s = this.server;
    this.server = null;
    this.codes.clear();
    if (s) { s.closeAllConnections && s.closeAllConnections(); await new Promise((r) => s.close(r)); }
    this.state.enabled = false;
    this.save();
  }

  // App is quitting: close the port but keep "enabled" so it comes back next launch.
  async shutdown() {
    const s = this.server;
    this.server = null;
    if (s) { s.closeAllConnections && s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  }

  url(ip) { ip = ip || this.addresses()[0]; return ip && this.port ? `http://${ip}:${this.port}` : ''; }

  info() {
    return {
      enabled: !!this.server, url: this.url(), port: this.port, addresses: this.addresses(),
      devices: this.state.devices.map((d) => ({ id: d.id, name: d.name, added: d.added, lastSeen: d.lastSeen })),
    };
  }

  // A fresh single-use code, shown to the user as a QR code. Valid for five minutes.
  async pairing(ip) {
    if (!this.server) throw new Error('Turn the phone link on first');
    const base = this.url(ip && this.addresses().includes(ip) ? ip : undefined);
    if (!base) throw new Error('This PC is not on a network. Connect to Wi-Fi first.');
    for (const [c, exp] of this.codes) if (exp < Date.now()) this.codes.delete(c);
    const code = crypto.randomBytes(12).toString('hex');
    const expires = Date.now() + CODE_TTL;
    this.codes.set(code, expires);
    const link = `${base}/?pair=${code}`;
    const qr = await QRCode.toDataURL(link, { margin: 1, width: 220, color: { dark: '#0f1115', light: '#ffffff' } });
    return { link, qr, expires };
  }

  revoke(id) {
    this.state.devices = this.state.devices.filter((d) => d.id !== id);
    this.sent.delete(id);
    this.save();
  }

  // ---- http ------------------------------------------------------------------------
  json(res, code, body) {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  blocked(ip) { const f = this.fails.get(ip); return f && f.until > Date.now(); }
  fail(ip) {
    const f = this.fails.get(ip) || { n: 0, until: 0 };
    f.n++;
    if (f.n >= 8) { f.until = Date.now() + 60_000; f.n = 0; }   // too many wrong tries: a minute off
    this.fails.set(ip, f);
  }

  device(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return null;
    const h = hash(m[1]);
    const d = this.state.devices.find((x) => x.hash === h);
    if (d) d.lastSeen = Date.now();
    return d || null;
  }

  body(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const parts = [];
      req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { if (size - c.length <= MAX_BODY) reject(new Error('Too large')); } else parts.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch { reject(new Error('Bad request')); } });
      req.on('error', reject);
    });
  }

  async handle(req, res) {
    const ip = req.socket.remoteAddress || '';
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(page);
      }
      if (req.method === 'GET' && url.pathname === '/manifest.json') {
        res.writeHead(200, { 'content-type': 'application/manifest+json' });
        return res.end(JSON.stringify({ name: 'Mjolnir', short_name: 'Mjolnir', start_url: '/', display: 'standalone', background_color: '#0f1115', theme_color: '#0f1115', icons: [{ src: '/icon.png', sizes: '64x64', type: 'image/png' }] }));
      }
      if (req.method === 'GET' && url.pathname === '/icon.png') {
        try { const png = fs.readFileSync(path.join(__dirname, '..', 'ui', 'icon.png')); res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' }); return res.end(png); } catch { res.writeHead(404); return res.end(); }
      }
      if (!url.pathname.startsWith('/api/')) { res.writeHead(404); return res.end(); }
      if (this.blocked(ip)) return this.json(res, 429, { error: 'Too many wrong tries. Wait a minute.' });

      if (req.method === 'POST' && url.pathname === '/api/pair') {
        const { code } = await this.body(req);
        const exp = this.codes.get(String(code));
        this.codes.delete(String(code));          // single use, even when expired
        if (!exp || exp < Date.now()) { this.fail(ip); return this.json(res, 400, { error: 'That code has expired. Make a new one on your PC.' }); }
        const token = crypto.randomBytes(24).toString('hex');
        const ua = String(req.headers['user-agent'] || '');
        const kind = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : 'Phone';
        const dev = { id: crypto.randomUUID(), name: `${kind} ${this.state.devices.length + 1}`, hash: hash(token), added: Date.now(), lastSeen: Date.now() };
        this.state.devices.push(dev);
        this.save();
        this.onReceive({ paired: dev.name });
        return this.json(res, 200, { token, name: os.hostname() });
      }

      const dev = this.device(req);
      if (!dev) { this.fail(ip); return this.json(res, 401, { error: 'Not paired' }); }

      if (req.method === 'GET' && url.pathname === '/api/me') return this.json(res, 200, { name: os.hostname() });

      if (req.method === 'GET' && url.pathname === '/api/recent') {
        const items = (this.sent.get(dev.id) || []).map((i) => {
          const p = this.peek(i.key, i.id);
          return { url: i.url, where: i.where, title: (p && p.title) || i.title, status: p ? p.status : 'gone', percent: p ? p.percent : 0, size: p ? p.size : 0 };
        });
        return this.json(res, 200, { items });
      }

      if (req.method === 'POST' && url.pathname === '/api/send') {
        const { urls } = await this.body(req);
        if (!Array.isArray(urls) || !urls.length) return this.json(res, 400, { error: 'No links' });
        const results = [];
        const targets = new Map();
        for (const raw of urls.slice(0, MAX_URLS)) {
          const u = String(raw).trim();
          try {
            const target = new URL(u);
            if (!/^https?:$/.test(target.protocol)) throw new Error('Only http and https links work.');
            if (target.port === String(this.port) && this.addresses().includes(target.hostname)) throw new Error('That link points back at this PC.');
            const r = await this.route(u);
            const list = this.sent.get(dev.id) || [];
            list.unshift({ url: u, where: r.where, key: r.key, id: r.id, title: r.title || u });
            this.sent.set(dev.id, list.slice(0, 30));
            targets.set(r.key, r.where);
            results.push({ url: u, ok: true, where: r.where });
          } catch (e) {
            results.push({ url: u, ok: false, error: e.message || 'Could not add this link.' });
          }
        }
        const ok = results.filter((r) => r.ok).length;
        if (ok) this.onReceive({ device: dev.name, count: ok, targets: [...targets].map(([key, where]) => ({ key, where })) });
        return this.json(res, 200, { results });
      }

      this.json(res, 404, { error: 'Not found' });
    } catch (e) {
      if (res.headersSent) return;
      if (e.message === 'Too large') {
        res.setHeader('connection', 'close');
        res.on('finish', () => req.destroy());
        return this.json(res, 413, { error: 'Too large' });
      }
      this.json(res, 400, { error: e.message });
    }
  }
}

module.exports = { PhoneLink, DEFAULT_PORT };
