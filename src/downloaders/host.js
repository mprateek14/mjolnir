'use strict';
const path = require('path');
const registry = require('./registry');

// Loads downloader modules and shows each one in its own view, so a crash or error in one cannot reach the main app.
class DownloaderHost {
  constructor({ electron, win, dataRoot, getSettings, ffmpegPath, ffprobePath, baseFolder }) {
    this.e = electron;
    this.win = win;
    this.dataRoot = dataRoot;
    this.getSettings = getSettings;
    this.ffmpegPath = ffmpegPath;
    this.ffprobePath = ffprobePath;
    this.baseFolder = baseFolder;
    this.entries = new Map();
    this.active = null;
    for (const file of registry) {
      try {
        const mod = require(file);
        this.entries.set(mod.id, { mod, instance: null, view: null, error: '', captures: new Set() });
      } catch (e) {
        console.error(`Downloader ${file} failed to load:`, e.message);
        this.entries.set(file, { mod: { id: file, name: file.replace('./', ''), description: '' }, error: e.message });
      }
    }
    this.register();
    // A few modules do their work in the background and have to run from the start (the Clipboard tool).
    for (const [id, en] of this.entries) {
      if (en.error || !en.mod.autostart) continue;
      try { this.instance(id); } catch (e) { en.error = e.message; console.error(`${id} did not start:`, e.message); }
    }
    this.lastActivity = '';
    this.activityTimer = setInterval(() => this.pollActivity(), 1500);
    if (this.activityTimer.unref) this.activityTimer.unref();
  }

  register() {
    const { ipcMain } = this.e;
    ipcMain.handle('dl:list', () => [...this.entries.values()].map(({ mod, error }) => ({ id: mod.id, name: mod.name, description: mod.description, kind: mod.kind || 'downloader', error, folder: !error && !!mod.hasFolder })));
    ipcMain.handle('dl:openFolder', async (_e, id) => {
      try { await this.instance(id).handlers.openFolder(); return { ok: true }; } catch (e) { return { error: e.message }; }
    });
    ipcMain.handle('dl:show', (_e, id, bounds) => this.show(id, bounds));
    ipcMain.handle('dl:bounds', (_e, bounds) => this.setBounds(bounds));
    ipcMain.handle('dl:hide', () => this.hide());
    ipcMain.handle('dl:call', (e, id, name, args) => this.call(e.sender, id, name, args));
  }

  instance(id) {
    const en = this.entries.get(id);
    if (!en || en.error) throw new Error(en ? en.error : 'Unknown downloader');
    if (!en.instance) {
      const { app, shell, dialog, Notification } = this.e;
      en.instance = en.mod.create({
        dataDir: path.join(this.dataRoot, id),
        settings: this.getSettings,
        ffmpeg: this.ffmpegPath,
        ffprobe: this.ffprobePath,
        // Electron's own binary can act as Node, which tools like yt-dlp need to solve site challenges.
        jsRuntime: { path: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } },
        emit: (channel, payload) => {
          const targets = [en.view && en.view.webContents, ...[...(en.captures || [])].map((w) => w.webContents)];
          for (const t of targets) if (t && !t.isDestroyed()) t.send('dl:event', channel, payload);
        },
        notify: (title, body) => Notification.isSupported() && new Notification({ title, body }).show(),
        shell,
        pickFiles: async (opts = {}) => {
          const r = await dialog.showOpenDialog(this.win, { properties: ['openFile', 'multiSelections'], filters: opts.filters });
          return r.canceled ? [] : r.filePaths;
        },
        pickFolder: async () => {
          const r = await dialog.showOpenDialog(this.win, { properties: ['openDirectory', 'createDirectory'] });
          return r.canceled ? null : r.filePaths[0];
        },
        baseFolder: this.baseFolder,
      });
    }
    return en.instance;
  }

  // Tells the main window how many downloads each downloader is working on, for the sidebar badges.
  pollActivity() {
    const out = {};
    for (const [id, en] of this.entries) {
      try { if (en.instance && typeof en.instance.handlers.activity === 'function') out[id] = en.instance.handlers.activity(); } catch { /* skip */ }
    }
    const json = JSON.stringify(out);
    if (json === this.lastActivity) return;
    this.lastActivity = json;
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('dl-activity', out);
  }

  // A downloader can claim links with `matches(url)` and handle them with `quickAdd(url)` (default settings, no page).
  // Used when links arrive from outside the UI, for example from a paired phone. Returns null when nobody claims it.
  isOff(id) { return ((this.getSettings() || {}).disabledDownloaders || []).includes(id); }

  async routeLink(url) {
    for (const en of this.entries.values()) {
      if (en.error || typeof en.mod.matches !== 'function' || !en.mod.matches(url)) continue;
      if (this.isOff(en.mod.id)) throw new Error(`The ${en.mod.name} downloader is turned off. Turn it on in Settings, Downloaders.`);
      const r = await this.instance(en.mod.id).handlers.quickAdd(url);
      return { where: en.mod.name, key: en.mod.id, id: r.id, title: r.title };
    }
    return null;
  }

  // Opens the downloader's small pop-up for a page link sent by the browser extension, without showing the main window.
  // Returns false when no downloader offers one for this link, and 'off' when the one that does is turned off.
  openCapture(url) {
    for (const en of this.entries.values()) {
      const cap = en.mod.capture;
      if (en.error || !cap) continue;
      const clean = cap.accept(url);
      if (!clean) continue;
      if (this.isOff(en.mod.id)) return 'off';
      const { BrowserWindow, nativeImage, screen } = this.e;
      const w = new BrowserWindow({
        width: cap.width, height: cap.height, resizable: false, maximizable: false, show: false, autoHideMenuBar: true,
        title: `Mjolnir: ${en.mod.name}`, backgroundColor: '#0f1115',
        icon: nativeImage.createFromPath(path.join(__dirname, '..', 'ui', 'mjolnir-app.ico')),
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          additionalArguments: [`--dl-id=${en.mod.id}`, `--cap-url=${encodeURIComponent(clean)}`],
          contextIsolation: true, sandbox: true, nodeIntegration: false,
        },
      });
      w.setMenuBarVisibility(false);
      w.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https?:/.test(u)) this.e.shell.openExternal(u); return { action: 'deny' }; });
      en.captures.add(w);
      w.on('closed', () => en.captures.delete(w));
      w.once('ready-to-show', () => {
        const { workArea } = screen.getPrimaryDisplay();
        w.setPosition(Math.round(workArea.x + (workArea.width - cap.width) / 2), Math.round(workArea.y + (workArea.height - cap.height) / 2));
        w.setAlwaysOnTop(true);
        w.show(); w.focus();
      });
      w.loadFile(path.join(en.mod.dir || path.join(__dirname, en.mod.id), 'capture', 'index.html'));
      return true;
    }
    return false;
  }

  // For the app's own code (batch download): call one of a downloader's handlers directly.
  async callHandler(id, name, ...args) {
    const fn = this.instance(id).handlers[name];
    if (typeof fn !== 'function') throw new Error(`Unknown action ${name}`);
    return fn(...args);
  }

  // Status of something routeLink created: { status, percent, title, size } or null.
  peek(key, id) {
    try {
      const en = this.entries.get(key);
      if (!en || en.error || !en.instance || typeof en.instance.handlers.peek !== 'function') return null;
      return en.instance.handlers.peek(id);
    } catch { return null; }
  }

  async call(sender, id, name, args) {
    try {
      const en = this.entries.get(id);
      const popup = en && [...en.captures].find((w) => !w.isDestroyed() && w.webContents === sender);
      if (!en || !((en.view && en.view.webContents === sender) || popup)) throw new Error('Not allowed');
      if (popup && name === 'pickFolder') {
        // The pop-up floats above everything, which would hide the folder dialog, so step down while it is open.
        popup.setAlwaysOnTop(false);
        const r = await this.e.dialog.showOpenDialog(popup, { properties: ['openDirectory', 'createDirectory'] });
        if (!popup.isDestroyed()) popup.setAlwaysOnTop(true);
        return r.canceled ? null : r.filePaths[0];
      }
      const inst = this.instance(id);
      const fn = inst.handlers[name];
      if (typeof fn !== 'function') throw new Error(`Unknown action ${name}`);
      return await fn(...(args || []));
    } catch (e) {
      return { __error: e.message || String(e) };
    }
  }

  show(id, bounds) {
    const en = this.entries.get(id);
    if (!en || en.error) return { error: en ? en.error : 'Unknown downloader' };
    this.hide();
    const { WebContentsView } = this.e;
    if (!en.view || en.view.webContents.isDestroyed()) {
      const view = new WebContentsView({
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          additionalArguments: [`--dl-id=${id}`],
          contextIsolation: true, sandbox: true, nodeIntegration: false,
        },
      });
      view.setBackgroundColor('#0f1115');
      view.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) this.e.shell.openExternal(url); return { action: 'deny' }; });
      view.webContents.on('render-process-gone', () => { en.view = null; if (this.active === id) this.active = null; });
      view.webContents.loadFile(path.join(en.mod.dir || path.join(__dirname, id), 'ui', 'index.html'));
      en.view = view;
    }
    this.win.contentView.addChildView(en.view);
    this.active = id;
    this.setBounds(bounds);
    en.view.setVisible(true);
    return { ok: true };
  }

  setBounds(b) {
    const en = this.active && this.entries.get(this.active);
    if (en && en.view && b) en.view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
  }

  hide() {
    const en = this.active && this.entries.get(this.active);
    if (en && en.view && !en.view.webContents.isDestroyed()) {
      en.view.setVisible(false);
      this.win.contentView.removeChildView(en.view);
    }
    this.active = null;
  }

  async dispose() {
    clearInterval(this.activityTimer);
    for (const en of this.entries.values()) {
      try { if (en.instance && en.instance.dispose) await en.instance.dispose(); } catch { /* keep shutting down */ }
    }
  }
}

module.exports = { DownloaderHost };
