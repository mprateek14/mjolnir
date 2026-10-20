'use strict';
// Clipboard: keeps the last 25 things you copied (text and images) so you can bring any of them back.
// It starts with the app and watches in the background; the page only shows and manages the list.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { ClipStore, MAX_ITEMS, MAX_BYTES } = require('./store');
const { ClipboardWatcher } = require('./watcher');

const POLL_MS = 800;
const KEEP_OUT = 8;     // pasted-back picture files kept around, so a program can still read the file it was handed

function create(ctx) {
  const { clipboard, ClipboardItem, nativeImage, dialog } = require('electron');
  const store = new ClipStore({ dir: ctx.dataDir, max: MAX_ITEMS, maxBytes: MAX_BYTES });
  const watcher = new ClipboardWatcher({ clipboard, nativeImage, maxBytes: MAX_BYTES });
  const stateFile = path.join(ctx.dataDir, 'state.json');
  const outDir = path.join(ctx.dataDir, 'out');
  let paused = false;
  let lastSkipped = null;      // { text, at } shown on the page for a while
  let timer = null;
  let busy = false;

  const view = (it) => ({
    id: it.id, kind: it.kind, ext: it.ext, mime: it.mime, size: it.size, preview: it.preview, chars: it.chars,
    width: it.width, height: it.height, name: it.name, createdAt: it.createdAt, usedAt: it.usedAt,
    url: it.kind === 'image' ? pathToFileURL(store.filePath(it)).href : '',
  });
  const snapshot = () => ({
    items: store.list().map(view), max: MAX_ITEMS, maxBytes: MAX_BYTES, paused,
    skipped: lastSkipped && Date.now() - lastSkipped.at < 60000 ? lastSkipped.text : '',
  });
  const push = () => ctx.emit('items', snapshot());
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

  async function look() {
    if (busy || paused) return;
    busy = true;
    try {
      const r = await watcher.poll();
      if (!r) return;
      if (r.skipped === 'too-large') {
        lastSkipped = { at: Date.now(), text: `Skipped ${r.name || (r.kind === 'text' ? 'some text' : 'a picture')}. It is ${mb(r.size)}, and items over ${mb(MAX_BYTES)} are not kept.` };
        push();
      } else if (r.capture) {
        const out = await store.add(r.capture);
        if (out.skipped === 'too-large') lastSkipped = { at: Date.now(), text: `Skipped an item. It is ${mb(out.size)}, and items over ${mb(MAX_BYTES)} are not kept.` };
        push();
      }
    } catch (e) {
      console.error('Clipboard watcher:', e.message);
    } finally { busy = false; }
  }

  // A friendly-named copy of a stored picture, because the stored one is named after its hash. A program that is
  // handed the file on paste (Explorer, chat apps) then shows the real name and the GIF keeps moving.
  async function asFile(it) {
    const dir = path.join(outDir, it.id);
    const stamp = new Date(it.createdAt).toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const file = path.join(dir, it.name || `Image ${stamp}.${it.ext}`);
    if (!fs.existsSync(file)) {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.copyFile(store.filePath(it), file);
    }
    // keep only the most recent few
    const dirs = (await fsp.readdir(outDir).catch(() => [])).map((d) => ({ d, t: fs.statSync(path.join(outDir, d)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const old of dirs.slice(KEEP_OUT)) await fsp.rm(path.join(outDir, old.d), { recursive: true, force: true }).catch(() => {});
    return file;
  }

  // One still frame as PNG, for pictures Electron cannot decode itself (GIF, WebP, BMP, TIFF). Uses the bundled ffmpeg.
  const stillFrame = (file) => new Promise((resolve) => {
    if (!ctx.ffmpeg) return resolve(null);
    const out = path.join(ctx.dataDir, 'still.png');
    execFile(ctx.ffmpeg, ['-y', '-loglevel', 'error', '-i', file, '-frames:v', '1', out], { windowsHide: true, timeout: 20000 }, (err) => {
      if (err) return resolve(null);
      fsp.readFile(out).then(resolve, () => resolve(null));
    });
  });

  async function putBack(it) {
    if (it.kind === 'text') {
      await clipboard.writeText((await store.readBytes(it.id)).toString('utf8'));
      return '';
    }
    const file = await asFile(it);
    let png = null;
    if (it.ext === 'png') png = await store.readBytes(it.id);
    else if (it.ext === 'jpg') { const img = nativeImage.createFromPath(file); if (!img.isEmpty()) png = img.toPNG(); }
    else png = await stillFrame(file);
    // Both go on the clipboard: the picture for editors and documents, the file for Explorer and chat apps.
    const data = { 'text/uri-list': pathToFileURL(file).href };
    if (png && png.length) data['image/png'] = new Blob([png], { type: 'image/png' });
    await clipboard.write([new ClipboardItem(data)]);
    if (it.ext === 'gif') return 'Copied. Programs that take files, like chat apps and Explorer, paste the moving GIF.';
    return png && png.length ? '' : 'Copied as a file. Programs that take pictures directly may not paste it.';
  }

  const init = (async () => {
    await store.load();
    try { paused = !!JSON.parse(await fsp.readFile(stateFile, 'utf8')).paused; } catch { /* first run */ }
    await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
    timer = setInterval(look, POLL_MS);
    if (timer.unref) timer.unref();
  })();

  const handlers = {
    async list() { await init; return snapshot(); },
    // Put an item back on the clipboard. It moves to the top, because it is the one just used.
    async copy(id) {
      await init;
      const it = store.find(id);
      if (!it) throw new Error('That item is gone.');
      const note = await putBack(it);
      await watcher.markOwn();
      await store.touch(id);
      push();
      return { ok: true, note };
    },
    async text(id) {
      await init;
      const it = store.find(id);
      return it && it.kind === 'text' ? (await store.readBytes(id)).toString('utf8') : '';
    },
    async saveAs(id) {
      await init;
      const it = store.find(id);
      if (!it) throw new Error('That item is gone.');
      const base = it.name || `clipboard.${it.ext}`;
      const r = await dialog.showSaveDialog({ defaultPath: base, filters: [{ name: it.kind === 'image' ? 'Picture' : 'Text', extensions: [it.ext] }] });
      if (r.canceled || !r.filePath) return { ok: false };
      await fsp.copyFile(store.filePath(it), r.filePath);
      return { ok: true };
    },
    async remove(id) { await init; await store.remove(id); push(); },
    async clear() { await init; await store.clear(); push(); },
    async pause(on) {
      await init;
      paused = !!on;
      if (!paused) await watcher.markOwn();   // what was copied while it was off is not picked up as a surprise
      await fsp.writeFile(stateFile, JSON.stringify({ paused })).catch(() => {});
      push();
    },
  };

  return {
    handlers,
    async dispose() { clearInterval(timer); },
  };
}

module.exports = {
  id: 'clipboard', kind: 'tool', dir: __dirname, autostart: true, name: 'Clipboard',
  description: 'The last 25 things you copied, text and pictures, ready to use again', create,
};
