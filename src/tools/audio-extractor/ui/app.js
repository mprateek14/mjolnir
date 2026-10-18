'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let files = [];          // inspected files waiting to be extracted
let picked = new Map();  // file path -> Set of track numbers
let jobs = [];
let settings = { outputMode: 'beside', folder: '' };

function bytes(n) {
  if (!(n > 0)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
function dur(s) {
  if (!s) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}
const LAYOUT = { 1: 'mono', 2: 'stereo', 6: '5.1', 8: '7.1' };
function trackText(t) {
  return [t.codecLabel, LAYOUT[t.channels] || (t.channels ? `${t.channels} channels` : ''), t.sampleRate ? `${(t.sampleRate / 1000).toFixed(t.sampleRate % 1000 ? 1 : 0)} kHz` : '',
    t.bitRate ? `${Math.round(t.bitRate / 1000)} kbps` : '', t.lang].filter(Boolean).join('  ·  ');
}

function showMsg(t) { const m = $('msg'); m.textContent = t || ''; m.hidden = !t; }

// ---- choosing files --------------------------------------------------------------
async function add(paths) {
  paths = paths.filter(Boolean).filter((p) => !files.some((f) => f.file === p));
  if (!paths.length) return;
  showMsg('');
  try {
    const rows = await dl.invoke('inspect', paths);
    for (const r of rows) {
      files.push(r);
      if (!r.error) {
        // Start with the file's default track, or its first one.
        const first = r.audio.find((a) => a.isDefault) || r.audio[0];
        picked.set(r.file, new Set([first.n]));
      }
    }
    renderFiles();
  } catch (e) { showMsg(e.message); }
}

$('btnPick').onclick = async () => add(await dl.invoke('pickFiles'));

const drop = $('drop');
for (const ev of ['dragenter', 'dragover']) addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) drop.classList.remove('over'); });
addEventListener('drop', (e) => {
  e.preventDefault();
  add([...e.dataTransfer.files].map((f) => dl.pathOf(f)));
});

function renderFiles() {
  $('files').innerHTML = files.map((f, i) => {
    if (f.error) {
      return `<div class="file"><div class="f-top"><div class="f-name">${esc(f.name)}</div><button class="btn sm" data-rm="${i}">Remove</button></div><div class="f-err">${esc(f.error)}</div></div>`;
    }
    const sel = picked.get(f.file) || new Set();
    return `<div class="file"><div class="f-top"><div><div class="f-name" title="${esc(f.file)}">${esc(f.name)}</div>
      <div class="f-meta">${[dur(f.duration), bytes(f.size), f.hasVideo ? '' : 'audio only', `${f.audio.length} audio track${f.audio.length === 1 ? '' : 's'}`].filter(Boolean).join('  ·  ')}</div></div>
      <button class="btn sm" data-rm="${i}">Remove</button></div>
      ${f.audio.map((t) => `<div class="track"><label><input type="checkbox" data-f="${i}" data-n="${t.n}" ${sel.has(t.n) ? 'checked' : ''}>
        <span class="t-main">Track ${t.n + 1}${t.title ? ' · ' + esc(t.title) : ''}<div class="t-sub">${esc(trackText(t))}</div></span></label>
        <span class="t-out">saves as ${t.ext}</span></div>`).join('')}</div>`;
  }).join('');
  updateAct();
}

$('files').addEventListener('change', (e) => {
  const c = e.target;
  if (c.dataset.f === undefined) return;
  const f = files[Number(c.dataset.f)];
  const set = picked.get(f.file) || new Set();
  c.checked ? set.add(Number(c.dataset.n)) : set.delete(Number(c.dataset.n));
  picked.set(f.file, set);
  updateAct();
});
$('files').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rm]');
  if (!b) return;
  const f = files[Number(b.dataset.rm)];
  files.splice(Number(b.dataset.rm), 1);
  picked.delete(f.file);
  renderFiles();
});

function readyItems() {
  return files.filter((f) => !f.error && (picked.get(f.file) || new Set()).size).map((f) => ({ file: f.file, tracks: [...picked.get(f.file)] }));
}
function updateAct() {
  const has = files.length > 0;
  $('where').hidden = !has;
  $('act').hidden = !has;
  const n = readyItems().length;
  const tracks = readyItems().reduce((a, i) => a + i.tracks.length, 0);
  $('btnGo').disabled = !n || ($('where').querySelector('[value=folder]').checked && !$('folder').value);
  $('btnGo').textContent = n ? `Extract ${tracks} audio track${tracks === 1 ? '' : 's'}${n > 1 ? ` from ${n} files` : ''}` : 'Pick a track';
}

$('btnClearFiles').onclick = () => { files = []; picked = new Map(); renderFiles(); };

// ---- where to save ---------------------------------------------------------------
document.querySelectorAll('[name=out]').forEach((r) => r.addEventListener('change', async () => {
  settings = await dl.invoke('setSettings', { outputMode: r.value });
  updateAct();
}));
$('btnFolder').onclick = async () => {
  const p = await dl.invoke('pickFolder');
  if (!p) return;
  $('folder').value = p;
  document.querySelector('[value=folder]').checked = true;
  settings = await dl.invoke('setSettings', { folder: p, outputMode: 'folder' });
  updateAct();
};

$('btnGo').onclick = async () => {
  try {
    await dl.invoke('extract', { items: readyItems() });
    files = []; picked = new Map();
    renderFiles();
  } catch (e) { showMsg(e.message); }
};

// ---- results ---------------------------------------------------------------------
function statusText(j) {
  if (j.status === 'running') return `Extracting  ·  ${Math.round(j.percent * 100)}%`;
  if (j.status === 'queued') return 'Waiting';
  if (j.status === 'cancelled') return 'Cancelled, nothing was kept';
  if (j.status === 'error') return j.error;
  return `Done  ·  ${j.outputs.length} file${j.outputs.length === 1 ? '' : 's'} saved, audio copied unchanged`;
}

function renderJobs() {
  $('empty').hidden = jobs.length > 0;
  $('jobList').innerHTML = jobs.map((j) => {
    const act = [];
    if (j.status === 'running' || j.status === 'queued') act.push(`<button class="btn sm" data-a="cancel" data-id="${j.id}">Cancel</button>`);
    if (j.outputs.length) act.push(`<button class="btn sm" data-a="reveal" data-id="${j.id}">Show in folder</button>`);
    act.push(`<button class="btn sm" data-a="remove" data-id="${j.id}">Remove</button>`);
    return `<div class="job ${j.status}">
      <div class="j-top"><div class="j-title" title="${esc(j.file)}">${esc(j.name)}</div><div class="j-act">${act.join('')}</div></div>
      <div class="bar"><i style="width:${j.status === 'done' ? 100 : Math.round(j.percent * 100)}%"></i></div>
      <div class="j-stat ${j.status === 'error' ? 'err' : ''}">${esc(statusText(j))}</div>
      ${j.outputs.map((o) => `<div class="out"><span class="nm" data-open="${esc(o.file)}" title="Play">${esc(o.file.split(/[\\/]/).pop())}</span><span class="sz">${esc(o.codec)}  ·  ${bytes(o.size)}</span></div>`).join('')}
      ${j.notes.map((n) => `<div class="note">${esc(n)}</div>`).join('')}</div>`;
  }).join('');
}

$('jobList').onclick = async (e) => {
  const open = e.target.closest('[data-open]');
  if (open) { dl.invoke('open', open.dataset.open).catch(() => {}); return; }
  const b = e.target.closest('button');
  if (b) dl.invoke(b.dataset.a, b.dataset.id).catch((err) => showMsg(err.message));
};
$('btnClear').onclick = () => dl.invoke('clearDone');
dl.on('jobs', (list) => { jobs = list; renderJobs(); });

(async function boot() {
  settings = await dl.invoke('getSettings');
  document.querySelector(`[name=out][value=${settings.outputMode}]`).checked = true;
  $('folder').value = settings.folder || '';
  jobs = await dl.invoke('jobs');
  renderJobs();
})();
