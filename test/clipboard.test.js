'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClipStore } = require('../src/tools/clipboard/store');
const { ClipboardWatcher } = require('../src/tools/clipboard/watcher');

const text = (s) => ({ kind: 'text', bytes: Buffer.from(s), ext: 'txt', mime: 'text/plain', preview: s, chars: s.length });
const image = (n, size = 100) => ({ kind: 'image', bytes: Buffer.alloc(size, n), ext: 'png', mime: 'image/png', width: 10, height: 10 });

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjolnir-clip-'));

  // ---- the list: newest first, 25 at most, least recently used goes first
  const s = new ClipStore({ dir, max: 25, maxBytes: 1000 });
  await s.load();
  for (let i = 1; i <= 25; i++) await s.add(text('item ' + i));
  assert.strictEqual(s.list().length, 25);
  assert.strictEqual(s.list()[0].preview, 'item 25', 'newest on top');
  assert.strictEqual(s.list()[24].preview, 'item 1');
  console.log('ok  keeps 25, newest on top');

  // the 26th pushes out the least recently used (item 1)
  await s.add(text('item 26'));
  assert.strictEqual(s.list().length, 25);
  assert(!s.list().some((i) => i.preview === 'item 1'), 'item 1 was dropped');
  assert.strictEqual(s.list()[0].preview, 'item 26');
  assert.strictEqual(fs.readdirSync(s.itemsDir).length, 25, 'the dropped item\'s file is gone too');
  console.log('ok  the 26th item drops the least recently used one, and its file');

  // copying something already in the list moves it up instead of adding a copy
  const before = s.list().length;
  const r = await s.add(text('item 10'));
  assert.strictEqual(r.isNew, false);
  assert.strictEqual(s.list().length, before);
  assert.strictEqual(s.list()[0].preview, 'item 10');
  console.log('ok  a repeat copy moves to the top, no duplicate');

  // using an item also moves it to the top, and protects it from the next drop
  const old = s.list()[s.list().length - 1];            // the oldest: item 2
  assert.strictEqual(old.preview, 'item 2');
  await s.touch(old.id);
  assert.strictEqual(s.list()[0].id, old.id);
  await s.add(text('item 27'));
  assert(s.list().some((i) => i.id === old.id), 'the one just used survives');
  assert(!s.list().some((i) => i.preview === 'item 3'), 'the next oldest went instead');
  console.log('ok  using an item moves it to the top and keeps it');

  // ---- size limit
  const big = await s.add(image(7, 2000));
  assert.strictEqual(big.skipped, 'too-large');
  const edge = await s.add(image(8, 1000));
  assert(edge.item, 'exactly at the limit is kept');
  assert.strictEqual((await s.add({ ...text(''), bytes: Buffer.alloc(0) })).skipped, 'empty');
  console.log('ok  items over the size limit are skipped');

  // ---- text and pictures live side by side, and the bytes come back as stored
  const png = image(9, 300);
  const added = await s.add(png);
  assert.deepStrictEqual(await s.readBytes(added.item.id), png.bytes);
  assert.notStrictEqual((await s.add(image(10, 300))).item.id, added.item.id, 'different pictures are different items');
  console.log('ok  pictures kept byte for byte');

  // ---- remove and clear
  assert.strictEqual(await s.remove(added.item.id), true);
  assert.strictEqual(await s.remove('nope'), false);
  assert(!fs.existsSync(s.filePath(added.item)));
  console.log('ok  remove');

  // ---- survives a restart; a missing file drops its entry; stray files are cleaned
  const keep = s.list().map((i) => i.id);
  fs.rmSync(s.filePath(s.list()[3]));
  fs.writeFileSync(path.join(s.itemsDir, 'stray.txt'), 'x');
  const s2 = new ClipStore({ dir, max: 25, maxBytes: 1000 });
  await s2.load();
  assert.strictEqual(s2.list().length, keep.length - 1);
  assert.deepStrictEqual(s2.list().map((i) => i.id), keep.filter((id) => id !== keep[3]));
  assert(!fs.existsSync(path.join(s.itemsDir, 'stray.txt')));
  console.log('ok  reload keeps the order, drops missing files, cleans strays');

  await s2.clear();
  assert.strictEqual(s2.list().length, 0);
  assert.strictEqual(fs.readdirSync(s2.itemsDir).length, 0);
  console.log('ok  clear');

  // ---- what is picked up from the system clipboard (stand-ins for Electron's async clipboard)
  const blob = (b) => ({ arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
  // data: { 'text/plain': Buffer, 'text/uri-list': Buffer, 'image/png': Buffer, <raw types>: Buffer }
  const mk = (data = {}) => {
    const cb = { data, async read() {
      const types = Object.keys(this.data);
      return types.length ? [{ types, getType: async (t) => blob(this.data[t]) }] : [];
    } };
    const w = new ClipboardWatcher({ clipboard: cb, nativeImage: { createFromBuffer: () => ({ getSize: () => ({ width: 3, height: 2 }) }) }, maxBytes: 1000 });
    return { cb, w };
  };
  const T = (s) => Buffer.from(s, 'utf8');
  const uri = (f) => T(require('url').pathToFileURL(f).href);
  let { cb, w } = mk();
  assert.strictEqual(await w.poll(), null, 'nothing on the clipboard');
  cb.data = { 'text/plain': T('hello') };
  let p = await w.poll();
  assert.strictEqual(p.capture.kind, 'text');
  assert.strictEqual(await w.poll(), null, 'the same text again is not news');
  cb.data = { 'text/plain': T('hello two') };
  assert((await w.poll()).capture, 'a new text is');
  cb.data = { 'text/plain': T('x'.repeat(2000)) };
  assert.strictEqual((await w.poll()).skipped, 'too-large');
  assert.strictEqual(await w.poll(), null, 'a skipped item is not retried every second');
  cb.data = { 'text/plain': T('   ') };
  assert.strictEqual(await w.poll(), null, 'blank text is ignored');
  console.log('ok  text: new, repeat, too large, blank');

  // a picture on the clipboard (a screenshot), and a text that comes with it wins (a copied spreadsheet range)
  ({ cb, w } = mk({ 'image/png': Buffer.alloc(300, 5) }));
  p = await w.poll();
  assert.strictEqual(p.capture.kind, 'image');
  assert.strictEqual(p.capture.ext, 'png');
  assert.strictEqual(p.capture.width, 3);
  cb.data = { 'image/png': Buffer.alloc(300, 6) };
  assert((await w.poll()).capture, 'another picture is news');
  cb.data = { 'image/png': Buffer.alloc(300, 6), 'text/plain': T('A1\tB1') };
  assert.strictEqual((await w.poll()).capture.kind, 'text');
  cb.data = { 'image/png': Buffer.alloc(2000, 7) };
  assert.strictEqual((await w.poll()).skipped, 'too-large');
  console.log('ok  pictures: new, another, text with it wins, too large');

  ({ cb, w } = mk({ 'text/plain': T('secret'), 'electron application/osclipboard;format="ExcludeClipboardContentFromMonitorProcessing"': Buffer.from([1]) }));
  assert.strictEqual((await w.poll()).skipped, 'private');
  console.log('ok  password manager copies are left alone');

  // own writes are not picked up again
  ({ cb, w } = mk({ 'text/plain': T('first') }));
  await w.poll();
  cb.data = { 'text/plain': T('from the list') };
  await w.markOwn();
  assert.strictEqual(await w.poll(), null);
  console.log('ok  what Mjolnir puts on the clipboard itself is not recorded as a new copy');

  // an image file copied in File Explorer keeps its own bytes (a GIF stays a GIF)
  const gif = path.join(dir, 'party.gif');
  fs.writeFileSync(gif, Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(50, 1)]));
  ({ cb, w } = mk({ 'text/uri-list': uri(gif) }));
  p = await w.poll();
  assert.strictEqual(p.capture.ext, 'gif');
  assert.strictEqual(p.capture.mime, 'image/gif');
  assert.strictEqual(p.capture.name, 'party.gif');
  assert.deepStrictEqual(p.capture.bytes, fs.readFileSync(gif));
  const doc = path.join(dir, 'notes.docx');
  fs.writeFileSync(doc, 'x');
  cb.data = { 'text/uri-list': uri(doc) };
  assert.strictEqual((await w.poll()).skipped, 'not-image');
  const huge = path.join(dir, 'huge.png');
  fs.writeFileSync(huge, Buffer.alloc(5000));
  cb.data = { 'text/uri-list': uri(huge) };
  assert.strictEqual((await w.poll()).skipped, 'too-large');
  for (const ext of ['jpg', 'jpeg', 'webp', 'bmp', 'svg']) {
    const f = path.join(dir, 'p.' + ext);
    fs.writeFileSync(f, 'x');
    cb.data = { 'text/uri-list': uri(f) };
    assert((await w.poll()).capture, ext + ' files are kept');
  }
  // several files copied together: the first picture among them
  cb.data = { 'text/uri-list': Buffer.concat([uri(doc), T('\r\n'), uri(gif)]) };
  assert.strictEqual((await w.poll()).capture.name, 'party.gif');
  // addresses that are not files are just text
  cb.data = { 'text/uri-list': T('https://example.com/a'), 'text/plain': T('https://example.com/a') };
  assert.strictEqual((await w.poll()).capture.kind, 'text');
  console.log('ok  image files keep their bytes and type; other files and big ones are skipped');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('all passed');
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
