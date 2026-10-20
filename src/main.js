'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { Manager } = require('./engine/manager');
const { categoryOf } = require('./engine/util');
const { DownloaderHost } = require('./downloaders/host');
const { PhoneLink } = require('./phonelink/server');
const updates = require('./updates');
const bridgeAuth = require('./bridgeauth');

const PORT = Number(process.env.MJOLNIR_BRIDGE_PORT) || 24680;   // the variable is for tests that run beside a running copy
let phone = null;
let win = null;
let tray = null;
let quitting = false;
let mgr = null;
let host = null;

// The app was called SwiftGet, then IceFox Downloader. Keep the settings, download list and paired phones from then.
try {
  const root = app.getPath('appData');
  const next = path.join(root, 'Mjolnir');
  if (!fs.existsSync(next)) {
    for (const old of ['IceFox Downloader', 'SwiftGet']) {
      const from = path.join(root, old);
      if (fs.existsSync(from)) { fs.renameSync(from, next); break; }
    }
  }
} catch (e) { console.error('Could not move the old settings folder:', e.message); }

// Existing users keep saving where they always did; new installs get the new name.
const baseFolder = ['SwiftGet', 'IceFox Downloader', 'Mjolnir']
  .map((n) => path.join(app.getPath('downloads'), n)).find((p) => fs.existsSync(p)) || path.join(app.getPath('downloads'), 'Mjolnir');

const APP_ID = 'com.mjolnir.downloader';
app.setAppUserModelId(APP_ID);   // lets Windows show our icon and group the taskbar button under our name
// Windows takes the taskbar icon from the Start Menu shortcut that carries our AppUserModelID, not from the window.
// Electron leaves such a shortcut pointing at electron.exe (its logo) when it first shows a notification, so when
// running from source we replace it with one that has our icon, and remove leftovers from earlier names.
if (process.platform === 'win32' && !app.isPackaged) {
  try {
    const programs = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    for (const name of ['Electron.lnk', 'IceFox Downloader.lnk']) {
      try {
        const id = shell.readShortcutLink(path.join(programs, name)).appUserModelId;
        if (id === APP_ID || id === 'com.icefox.downloader') fs.unlinkSync(path.join(programs, name));
      } catch { /* not there */ }
    }
    shell.writeShortcutLink(path.join(programs, 'Mjolnir.lnk'), 'create', {
      target: process.execPath, args: `"${app.getAppPath()}"`, cwd: app.getAppPath(),
      icon: path.join(__dirname, 'ui', 'mjolnir-app.ico'), iconIndex: 0, appUserModelId: APP_ID, description: 'Mjolnir',
    });
  } catch (e) { console.error('Could not write the dev shortcut:', e.message); }
}
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 720, minWidth: 860, minHeight: 520,
    backgroundColor: '#0f1115', title: 'Mjolnir',
    icon: nativeImage.createFromPath(path.join(__dirname, 'ui', 'mjolnir-app.ico')),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0f1115', symbolColor: '#c9ced8', height: 40 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.setIcon(nativeImage.createFromPath(path.join(__dirname, 'ui', 'mjolnir-app.ico')));
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
}

// Dedicated downloaders (YouTube and others) run isolated from the main flow; see src/downloaders.
function startDownloaders() {
  const bundled = (name, pick) => {
    try {
      const p = pick(require(name));
      return p && p.includes('app.asar') ? p.replace('app.asar', 'app.asar.unpacked') : p;
    } catch { return null; }
  };
  const ffmpegPath = bundled('ffmpeg-static', (m) => m);
  const ffprobePath = bundled('ffprobe-static', (m) => m.path);
  try {
    host = new DownloaderHost({
      electron: require('electron'), win, dataRoot: path.join(app.getPath('userData'), 'downloaders'),
      getSettings: () => mgr.settings, ffmpegPath, ffprobePath, baseFolder,
    });
  } catch (e) {
    console.error('Downloaders unavailable:', e.message);
  }
}

// Links from a paired phone go to whichever downloader claims them, else to the main downloader.
function startPhoneLink() {
  const statusOf = { downloading: 'running', verifying: 'running', merging: 'running', queued: 'queued', paused: 'paused', completed: 'done', error: 'error' };
  phone = new PhoneLink({
    dataDir: app.getPath('userData'),
    route: async (url) => {
      const viaDownloader = host ? await host.routeLink(url) : null;
      if (viaDownloader) return viaDownloader;
      const s = mgr.add({ url, comment: 'From phone' });
      return { where: 'Direct download', key: 'direct', id: s.id, title: s.filename || url };
    },
    peek: (key, id) => {
      if (key !== 'direct') return host ? host.peek(key, id) : null;
      const d = mgr.items.get(id);
      if (!d) return null;
      const s = d.snapshot();
      const percent = s.chunks && s.chunks[1] ? s.chunks[0] / s.chunks[1] : s.size > 0 ? s.downloaded / s.size : 0;
      return { status: statusOf[s.status] || s.status, percent: s.status === 'completed' ? 1 : percent, title: s.filename || s.url, size: s.status === 'completed' ? s.size : 0 };
    },
    onReceive: ({ device, count, paired, targets }) => {
      const text = paired ? `${paired} is now paired` : `${device} sent ${count} link${count === 1 ? '' : 's'}`;
      send('phone-received', { text, targets: targets || [] });
      if (Notification.isSupported()) new Notification({ title: 'Mjolnir phone link', body: text }).show();
    },
  });
  if (phone.state.enabled) phone.start().catch((e) => console.error('Phone link failed to start:', e.message));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'ui', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Mjolnir');
  tray.on('click', showWindow);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Mjolnir', click: showWindow },
    { label: 'Pause all', click: () => mgr.pauseAll() },
    { label: 'Resume all', click: () => mgr.resumeAll() },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };

// One small always-on-top window per link the browser hands over. It works without the main window.
const captures = new Map(); // webContents id -> { job, win }
let capOffset = 0;
function openCapture(job) {
  const w = new BrowserWindow({
    width: 540, height: 305, resizable: false, maximizable: false, minimizable: true, show: false,
    title: 'Mjolnir: file info', backgroundColor: '#0f1115', autoHideMenuBar: true,
    icon: nativeImage.createFromPath(path.join(__dirname, 'ui', 'mjolnir-app.ico')),
    webPreferences: { preload: path.join(__dirname, 'capture', 'preload.js'), contextIsolation: true, sandbox: true },
  });
  w.setMenuBarVisibility(false);
  const id = w.webContents.id;
  captures.set(id, { job: { ...job, dir: mgr.settings.downloadDir }, win: w });
  w.on('closed', () => captures.delete(id));
  w.once('ready-to-show', () => {
    const { workArea } = require('electron').screen.getPrimaryDisplay();
    const [ww, wh] = w.getSize();
    const step = (capOffset++ % 6) * 28;
    w.setPosition(Math.round(workArea.x + (workArea.width - ww) / 2 + step), Math.round(workArea.y + (workArea.height - wh) / 2 + step));
    w.setAlwaysOnTop(true);   // above the browser, which has the focus when the link is clicked
    w.show(); w.focus();
  });
  w.loadFile(path.join(__dirname, 'capture', 'index.html'));
}
function captureIpc() {
  const of = (e) => captures.get(e.sender.id);
  ipcMain.handle('cap:init', (e) => (of(e) || {}).job);
  ipcMain.handle('cap:probe', (e, url, headers) =>
    mgr.probe(url, headers).then((r) => ({ ...r, category: categoryOf(r.filename || '') })).catch((err) => ({ error: err.message })));
  ipcMain.handle('cap:pickFolder', async (e) => {
    const c = of(e);
    if (!c) return null;
    c.win.setAlwaysOnTop(false);
    const r = await dialog.showOpenDialog(c.win, { properties: ['openDirectory', 'createDirectory'], defaultPath: c.job.dir });
    c.win.setAlwaysOnTop(true);
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('cap:submit', (e, item) => {
    try { mgr.add(item); return { ok: true }; } catch (err) { return { error: err.message }; }
  });
  ipcMain.handle('cap:close', (e) => { const c = of(e); if (c) c.win.close(); });
}

// Browser extension talks to this.
// Only our extension may use the bridge, so web pages cannot queue downloads (see src/bridgeauth.js).
// Extensions from before the fixed extension ID still get in with the old token until they are updated.
const allowed = (req) => bridgeAuth.authorize(req.headers, mgr.settings.extensionToken);
function startBridge() {
  const srv = http.createServer((req, res) => {
    const cors = bridgeAuth.corsHeaders(req.headers);
    if (!bridgeAuth.hostOk(req.headers.host)) { res.writeHead(403, cors); return res.end(); }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.url === '/ping') { res.writeHead(200, cors); return res.end('mjolnir'); }
    if ((req.method === 'GET' || req.method === 'POST') && req.url === '/config') {
      req.resume();
      if (!allowed(req)) { console.error('Bridge refused a request, Origin:', req.headers.origin || '(none)'); res.writeHead(401, cors); return res.end('not allowed'); }
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      return res.end(JSON.stringify({ app: 'mjolnir', version: appVersion(), enabled: mgr.settings.extensionEnabled !== false, minBytes: Math.max(0, Number(mgr.settings.extensionMinMB) || 0) * 1024 * 1024 }));
    }
    if (req.method !== 'POST' || !['/add', '/stream', '/link'].includes(req.url)) { res.writeHead(404, cors); return res.end(); }
    if (!allowed(req)) { res.writeHead(401, cors); return res.end('not allowed'); }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const { url, referrer, cookie, userAgent, filename } = JSON.parse(body);
        const headers = {};
        if (referrer) headers.referer = referrer;
        if (cookie) headers.cookie = cookie;
        if (userAgent) headers['user-agent'] = userAgent;
        if (req.url === '/link') {
          // A page link (YouTube today): the matching downloader opens its own small window.
          const opened = host ? host.openCapture(url) : false;
          if (opened === 'off') { res.writeHead(423, cors); return res.end('off'); }
          if (opened) { res.writeHead(200, cors); return res.end('ok'); }
          res.writeHead(422, cors); return res.end('unsupported');
        }
        if (req.url === '/stream') {
          // Streams need a quality choice, so hand them to the Add dialog instead of queueing blindly.
          showWindow();
          send('open-add', { url, headers });
        } else {
          // Ask first, like IDM: a small window of its own, so the browser stays in front and the main app stays closed.
          openCapture({ url, headers, filename: filename || '' });
        }
        res.writeHead(200, cors); res.end('ok');
      } catch (e) { res.writeHead(400, cors); res.end(e.message); }
    });
  });
  srv.on('error', (e) => console.error('Bridge unavailable:', e.message));
  srv.listen(PORT, '127.0.0.1');
}

let lastClip = '';
function watchClipboard() {
  setInterval(() => {
    if (!mgr.settings.clipboardWatch) return;
    const t = clipboard.readText().trim();
    if (t === lastClip) return;
    lastClip = t;
    if (/^https?:\/\/\S+\.(zip|7z|rar|iso|exe|msi|mp4|mkv|mp3|pdf|tar|gz|dmg|apk)(\?\S*)?$/i.test(t)) {
      send('clipboard-url', t);
    }
  }, 1000);
}

function ipc() {
  const h = (name, fn) => ipcMain.handle(name, (_e, ...a) => fn(...a));
  h('list', () => mgr.list());
  h('settings:get', () => mgr.settings);
  h('settings:set', (p) => { mgr.setSettings(p); return mgr.settings; });
  h('probe', (url, headers) => mgr.probe(url, headers).then((r) => ({ ...r, category: categoryOf(r.filename || '') })).catch((e) => ({ error: e.message })));
  h('add', (items) => {
    const out = [];
    for (const it of [].concat(items)) {
      try { out.push(mgr.add(it)); } catch (e) { out.push({ error: e.message, url: it.url }); }
    }
    return out;
  });
  h('pause', (id) => mgr.pause(id));
  h('resume', (id) => mgr.resume(id));
  h('remove', (id, del) => mgr.remove(id, del));
  h('pauseAll', () => mgr.pauseAll());
  h('resumeAll', () => mgr.resumeAll());
  h('speedLimit', (id, rate) => mgr.setSpeedLimit(id, rate));
  h('open', (id) => {
    const d = mgr.items.get(id);
    if (d) return shell.openPath(d.finalPath);
  });
  h('reveal', (id) => {
    const d = mgr.items.get(id);
    if (d) shell.showItemInFolder(d.status === 'completed' ? d.finalPath : d.partPath);
  });
  h('copyUrl', (id) => { const d = mgr.items.get(id); if (d) clipboard.writeText(d.url); });
  h('pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('clipboard', () => clipboard.readText());
  // The extension folder people load into their browser: next to the app when installed, in the project when run from source.
  h('ext:open', async () => {
    const dir = app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(app.getAppPath(), 'extension');
    const err = await shell.openPath(dir);
    return err ? { error: err } : { ok: true };
  });
  h('update:check', () => checkForUpdate(true));
  h('update:version', () => appVersion());
  h('update:skip', (version) => { mgr.setSettings({ skippedVersion: String(version || '') }); });
  h('update:open', (url) => { if (updates.isReleaseUrl(url)) return shell.openExternal(url); });
  // Batch download: one link or ticker per line, all of one kind. Returns one result per line.
  // Where each kind saves unless the user picks another place.
  const batchDefaults = async () => {
    const own = async (id) => { try { return (await host.callHandler(id, 'getSettings')).folder; } catch { return ''; } };
    return { normal: path.join(mgr.settings.downloadDir, 'Other'), youtube: await own('youtube'), screener: await own('screener') };
  };
  // Mjolnir_Batch_2026-10-18, then _2, _3 ... when that name is already taken in the place it would go.
  const freeBatchName = async (mode, dir) => {
    const parent = dir || (await batchDefaults())[mode];
    const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
    const base = `Mjolnir_Batch_${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    let name = base;
    for (let i = 2; parent && fs.existsSync(path.join(parent, name)); i++) name = `${base}_${i}`;
    return name;
  };
  h('batch:defaults', batchDefaults);
  h('batch:folderName', (mode, dir) => freeBatchName(mode, dir));
  h('batch:run', async ({ mode, lines, dir, start, force, folder }) => {
    if (!['normal', 'screener', 'youtube'].includes(mode) || !Array.isArray(lines)) return [];
    if (mode !== 'normal' && host && host.isOff(mode)) return lines.map((line) => ({ line: String(line), ok: false, error: 'This downloader is turned off in Settings' }));
    // folder: null for none, '' for an automatic name. One name for the whole batch.
    let sub = '';
    if (folder !== null && folder !== undefined) {
      const clean = String(folder).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 100);
      sub = clean || await freeBatchName(mode, dir);
    }
    const normalBase = dir || path.join(mgr.settings.downloadDir, 'Other');
    lines = lines.slice(0, 500).map((l) => String(l).trim()).filter(Boolean);
    let done = 0;
    const tick = () => send('batch-progress', { done: ++done, total: lines.length });
    const one = async (line) => {
      try {
        if (mode === 'normal') {
          mgr.add({ url: line, dir: sub ? path.join(normalBase, sub) : normalBase, start: start !== false });
          return { line, ok: true };
        }
        if (!host) throw new Error('Downloaders are not available');
        const where = mode === 'youtube' ? { dir, subdir: sub } : { base: dir, subfolder: sub };
        const r = await host.callHandler(mode, 'quickAdd', line, { source: 'batch', force: !!force, ...where });
        return { line, ok: true, title: r && r.title };
      } catch (e) {
        return { line, ok: false, error: e.message || String(e) };
      } finally { tick(); }
    };
    // Lookups hit the network, so run a few at a time. Direct links are instant.
    const width = mode === 'youtube' ? 3 : mode === 'screener' ? 2 : 1;
    const out = new Array(lines.length);
    let next = 0;
    await Promise.all(Array.from({ length: width }, async () => {
      while (next < lines.length) { const i = next++; out[i] = await one(lines[i]); }
    }));
    return out;
  });
  h('phone:info', () => phone.info());
  h('phone:enable', async (on) => {
    try { if (on) await phone.start(); else await phone.stop(); return { ...phone.info() }; } catch (e) { return { error: e.message, ...phone.info() }; }
  });
  h('phone:pair', async (ip) => { try { return await phone.pairing(ip); } catch (e) { return { error: e.message }; } });
  h('phone:revoke', (id) => { phone.revoke(id); return phone.info(); });
}

// Update check. It only tells the user; downloading and installing stay their choice (see src/updates.js).
// MJOLNIR_TEST_VERSION lets a test pretend to be an older version.
const appVersion = () => process.env.MJOLNIR_TEST_VERSION || app.getVersion();
async function checkForUpdate(manual) {
  const current = appVersion();
  try {
    const r = await updates.check(current);
    const skipped = r.newer && mgr.settings.skippedVersion === r.latest.version;
    // A skipped version stays quiet in the background, but a manual check still reports it.
    if (r.newer && (manual || !skipped)) send('update-available', { ...r.latest, current });
    return { ok: true, current, newer: r.newer, latest: r.latest, skipped };
  } catch (e) {
    return { ok: false, current, error: e.message };
  }
}
function startUpdateChecks() {
  const tick = () => { if (mgr.settings.updateCheck !== false) checkForUpdate(false); };
  setTimeout(tick, 20 * 1000);                    // not while the window is still opening
  setInterval(tick, 6 * 60 * 60 * 1000);          // and every few hours if the app stays open
}

app.whenReady().then(async () => {
  mgr = new Manager({ dataDir: app.getPath('userData'), downloadDir: baseFolder });
  await mgr.init();
  if (!mgr.settings.extensionToken) mgr.setSettings({ extensionToken: crypto.randomBytes(12).toString('hex') });
  ipc(); captureIpc();
  createWindow();
  startDownloaders();
  startPhoneLink();
  createTray();
  startBridge();
  startUpdateChecks();
  watchClipboard();
  mgr.on('progress', (p) => send('progress', p));
  mgr.on('added', (d) => send('added', d));
  mgr.on('removed', (id) => send('removed', id));
  mgr.on('complete', (d) => {
    send('complete', d);
    if (Notification.isSupported()) new Notification({ title: 'Download complete', body: d.filename }).show();
  });
  // Structural changes (status flips, errors) go out as full snapshots every second.
  setInterval(() => send('list', mgr.list()), 1000);
});

app.on('before-quit', async (e) => {
  if (quitting === 'done') return;
  e.preventDefault();
  quitting = true;
  if (phone) await phone.shutdown();
  if (host) await host.dispose();
  await mgr.shutdown();
  quitting = 'done';
  app.quit();
});
app.on('window-all-closed', () => {});
