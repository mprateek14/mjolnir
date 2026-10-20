'use strict';
const $ = (id) => document.getElementById(id);

let state = { items: [], max: 25, maxBytes: 10485760, paused: false, skipped: '' };
let query = '';

const bytes = (n) => {
  const u = ['B', 'KB', 'MB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
};
function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s} seconds ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

function card(it) {
  const el = document.createElement('div');
  el.className = 'item';
  el.dataset.id = it.id;
  const body = document.createElement('div');
  body.className = 'body';
  const meta = document.createElement('div');
  meta.className = 'meta';
  const tag = (t) => { const s = document.createElement('span'); s.className = 'tag'; s.textContent = t; return s; };
  const span = (t) => { const s = document.createElement('span'); s.textContent = t; return s; };

  if (it.kind === 'text') {
    const pre = document.createElement('div');
    pre.className = 'text';
    pre.textContent = it.preview;   // the box shows three lines and ends with ... when there is more
    body.appendChild(pre);
    meta.append(tag('TEXT'), span(`${it.chars.toLocaleString()} characters`), span(ago(it.usedAt)));
  } else {
    const pic = document.createElement('div');
    pic.className = 'pic';
    if (['tif', 'tiff', 'heic'].includes(it.ext)) {
      const n = document.createElement('div');
      n.className = 'nopic';
      n.textContent = `${it.ext.toUpperCase()} picture, no preview`;
      pic.appendChild(n);
    } else {
      const img = document.createElement('img');
      img.src = it.url;
      img.alt = '';
      pic.appendChild(img);
    }
    body.appendChild(pic);
    meta.append(tag(it.ext === 'gif' ? 'GIF' : it.ext.toUpperCase()), ...(it.width ? [span(`${it.width} x ${it.height}`)] : []), span(bytes(it.size)), ...(it.name ? [span(it.name)] : []), span(ago(it.usedAt)));
  }
  body.appendChild(meta);

  const acts = document.createElement('div');
  acts.className = 'acts';
  const b = (label, act, cls) => { const x = document.createElement('button'); x.className = 'btn sm ' + (cls || ''); x.dataset.act = act; x.textContent = label; return x; };
  acts.append(b('Copy', 'copy'));
  acts.append(b('Save as…', 'save'));
  acts.append(b('Delete', 'remove', 'danger'));
  el.append(body, acts);
  return el;
}

function render() {
  const q = query.trim().toLowerCase();
  const shown = state.items.filter((it) => !q || (it.kind === 'text' && it.preview.toLowerCase().includes(q)) || (it.name || '').toLowerCase().includes(q));
  const list = $('list');
  list.replaceChildren(...shown.map(card));
  $('empty').hidden = state.items.length > 0;
  $('btnClear').disabled = !state.items.length;
  $('count').textContent = q ? `${shown.length} of ${state.items.length} match` : `${state.items.length} of ${state.max}`;
  $('btnPause').textContent = state.paused ? 'Resume' : 'Pause';
  $('paused').hidden = !state.paused;
  $('note').hidden = !state.skipped;
  $('note').textContent = state.skipped;
  $('sub').textContent = `The last ${state.max} things you copied, text and pictures. Items over ${bytes(state.maxBytes)} are skipped.`;
}

$('list').addEventListener('click', async (e) => {
  const el = e.target.closest('.item');
  if (!el) return;
  const id = el.dataset.id;
  const act = (e.target.closest('[data-act]') || {}).dataset ? e.target.closest('[data-act]').dataset.act : 'copy';
  try {
    if (act === 'remove') { await dl.invoke('remove', id); return; }
    if (act === 'save') { await dl.invoke('saveAs', id); return; }
    const r = await dl.invoke('copy', id);   // the page refreshes itself when the list changes
    toast(r && r.note ? r.note : 'Copied. It is back on your clipboard.');
  } catch (err) { toast(err.message); }
});

$('search').addEventListener('input', () => { query = $('search').value; render(); });
$('btnPause').onclick = () => dl.invoke('pause', !state.paused);
// Two clicks: the first asks, the second does it. No pop-up dialog.
let clearArmed = null;
$('btnClear').onclick = async () => {
  if (!clearArmed) {
    $('btnClear').textContent = 'Click again to clear all';
    clearArmed = setTimeout(() => { clearArmed = null; $('btnClear').textContent = 'Clear all'; }, 3000);
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = null;
  $('btnClear').textContent = 'Clear all';
  await dl.invoke('clear');
};

dl.on('items', (s) => { state = s; render(); });
setInterval(render, 30000);   // keeps "2 min ago" honest
(async () => { state = await dl.invoke('list'); render(); })();
