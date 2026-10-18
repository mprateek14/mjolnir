'use strict';
const $ = (id) => document.getElementById(id);
const items = new Map();       // id -> snapshot
const rows = new Map();        // id -> element
const history = new Map();     // id -> recent speed samples
let totalHist = [];
let filter = 'all';
let query = '';
let selected = null;
let settings = {};
let tools = [];
let activeTool = null;
let activity = {};   // downloads in progress per downloader, for the sidebar badges

const EYE_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
// Dedicated downloaders (YouTube, Screener) the user has left turned on in Settings.
const allDownloaders = () => tools.filter((t) => t.kind !== 'tool');
const dlEnabled = (id) => !((settings.disabledDownloaders) || []).includes(id);
const enabledDownloaders = () => allDownloaders().filter((t) => dlEnabled(t.id));
const FOLDER_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const CATS = ['Compressed', 'Documents', 'Music', 'Video', 'Programs', 'Other'];

// ---- formatting ------------------------------------------------------------------
function bytes(n) {
  if (!(n >= 0)) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
function dur(s) {
  if (!s || !isFinite(s)) return '';
  s = Math.round(s);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
const STATUS = { downloading: 'Downloading', queued: 'Queued', paused: 'Paused', completed: 'Complete', error: 'Error', verifying: 'Verifying', merging: 'Merging' };

// ---- sidebar ---------------------------------------------------------------------
function matchesFilter(d) {
  if (filter === 'all') return true;
  if (filter === 'active') return d.status === 'downloading' || d.status === 'queued' || d.status === 'verifying';
  if (filter === 'done') return d.status === 'completed';
  if (filter === 'unfinished') return d.status !== 'completed';
  if (filter === 'error') return d.status === 'error';
  if (filter.startsWith('cat:')) return d.category === filter.slice(4);
  return true;
}

function renderSide() {
  const all = [...items.values()];
  const count = (f) => { const keep = filter; filter = f; const n = all.filter(matchesFilter).length; filter = keep; return n; };
  const entry = (t) => `<div class="nav ${activeTool === t.id ? 'on' : ''}" data-tool="${t.id}" title="${esc(t.error || t.description || '')}"><span>${esc(t.name)}</span>${t.error ? '<span class="n">!</span>' : activity[t.id] && activity[t.id].active ? `<span class="busy" title="${activity[t.id].active} running">${activity[t.id].active}</span>` : ''}</div>`;
  const head = (title, group) => `<h4 class="sec"><span>${title}</span><button class="vis-btn" data-vis="${group}" title="Choose what to show" aria-label="Choose what to show in ${title}">${EYE_ICON}</button></h4>`;
  // Downloaders: the header stays even when every entry is hidden, so the button to bring them back is still there.
  const section = (title, list) => (list.length ? `<h4>${title}</h4>` + list.map(entry).join('') : '');
  const downloaders = enabledDownloaders();
  const nav = (key, label) => `<div class="nav ${!activeTool && filter === key ? 'on' : ''}" data-f="${key}"><span>${label}</span><span class="n">${count(key)}</span></div>`;
  $('side').innerHTML =
    '<h4>Downloads</h4>' + nav('all', 'All') + nav('active', 'Active') + nav('unfinished', 'Unfinished') + nav('done', 'Completed') + nav('error', 'Failed') +
    head('Categories', 'categories') + CATS.filter((c) => shown('cat:' + c)).map((c) => nav('cat:' + c, c)).join('') +
    // Dedicated downloaders keep their own folders. These open them in File Explorer.
    tools.filter((t) => t.folder && shown('folder:' + t.id)).map((t) => `<div class="nav" data-folder="${t.id}" title="Open the ${esc(t.name)} folder"><span>${esc(t.name)}</span><span class="n open-ico">${FOLDER_ICON}</span></div>`).join('') +
    // Downloaders and tools are separate lists. Each entry opens its own page.
    (downloaders.length ? head('Downloaders', 'downloaders') + downloaders.filter((t) => shown('tool:' + t.id)).map(entry).join('') : '') +
    section('Tools', tools.filter((t) => t.kind === 'tool'));
}
$('side').addEventListener('click', (e) => {
  const v = e.target.closest('[data-vis]');
  if (v) { openVisMenu(v); return; }
  const n = e.target.closest('.nav');
  if (!n) return;
  if (n.dataset.tool) { enterTool(n.dataset.tool); return; }
  if (n.dataset.folder) {
    sg.dlOpenFolder(n.dataset.folder).then((r) => { if (r && r.error) toast(r.error); });
    return;
  }
  leaveTool();
  filter = n.dataset.f;
  renderSide();
  renderList();
});

// ---- downloaders -----------------------------------------------------------------
// Each downloader is its own view owned by the main process. The page only tells it where to sit.
function toolBounds() {
  const r = document.querySelector('.main').getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}
async function enterTool(id) {
  document.body.classList.add('dl-active');
  activeTool = id;
  renderSide();
  await new Promise((r) => requestAnimationFrame(r));
  const res = await sg.dlShow(id, toolBounds());
  if (res && res.error) { leaveTool(); toast(res.error); }
}
function leaveTool() {
  if (!activeTool) return;
  activeTool = null;
  document.body.classList.remove('dl-active');
  sg.dlHide();
  renderSide();
}
new ResizeObserver(() => { if (activeTool) sg.dlBounds(toolBounds()); }).observe(document.querySelector('.main'));

// ---- list ------------------------------------------------------------------------
function makeRow(id) {
  const el = document.createElement('div');
  el.className = 'item cols';
  el.dataset.id = id;
  // Same order as COLS
  el.innerHTML = '<div class="nm"><b></b><small></small></div><div class="num sz"></div><div><span class="st"></span></div>' +
    '<div class="num eta"></div><div class="num sp"></div>' +
    '<div class="prog"><div class="bar"><i></i></div><div class="pct"></div></div><div class="dt"></div>';
  return el;
}

// ---- columns: sorting and resizing -------------------------------------------------
// Name, Size, Status and Date sort when their heading is clicked. Every column can be dragged wider or narrower.
const COLS = [
  { key: 'name', label: 'Name', w: 280, sort: true }, { key: 'size', label: 'Size', w: 84, sort: true, r: true },
  { key: 'status', label: 'Status', w: 100, sort: true }, { key: 'eta', label: 'Time left', w: 76, r: true },
  { key: 'speed', label: 'Speed', w: 88, r: true }, { key: 'progress', label: 'Progress', w: 140 },
  { key: 'date', label: 'Date', w: 124, sort: true },
];
const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem('mj.' + k)); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mj.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const savedW = store.get('colw', {});
const colW = Object.fromEntries(COLS.map((c) => [c.key, Math.max(44, Math.min(900, Number(savedW[c.key]) || c.w))]));
let sortBy = store.get('sort', null);   // { key, dir }, or null for newest first
if (sortBy && !COLS.some((c) => c.key === sortBy.key && c.sort)) sortBy = null;

function applyWidths() {
  const t = $('table');
  // The last column takes whatever width is left, so the table never ends in an empty column.
  const last = COLS.length - 1;
  t.style.setProperty('--cols', COLS.map((c, i) => (i === last ? `minmax(${colW[c.key]}px, 1fr)` : colW[c.key] + 'px')).join(' '));
  // 32 for the row padding and 8 for each gap
  t.style.setProperty('--tw', COLS.reduce((a, c) => a + colW[c.key] + 8, 32) + 'px');
}

function buildHead() {
  $('head').innerHTML = COLS.map((c, i) => '<div class="th' + (c.r ? ' r' : '') + (c.sort ? ' sortable' : '') + '" data-k="' + c.key + '"><span>' + c.label + '</span><span class="arrow"></span>' + (i === COLS.length - 1 ? '' : '<i class="rs" data-k="' + c.key + '" title="Drag to resize, double-click to reset"></i>') + '</div>').join('');
  paintHead();
  applyWidths();
}
function paintHead() {
  for (const th of $('head').children) {
    const on = sortBy && sortBy.key === th.dataset.k;
    th.classList.toggle('sorted', !!on);
    th.querySelector('.arrow').textContent = on ? (sortBy.dir === 'asc' ? '▲' : '▼') : '';
  }
}

$('head').addEventListener('click', (e) => {
  if (e.target.closest('.rs')) return;
  const th = e.target.closest('.th.sortable');
  if (!th) return;
  const key = th.dataset.k;
  sortBy = sortBy && sortBy.key === key ? { key, dir: sortBy.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'date' ? 'desc' : 'asc' };
  store.set('sort', sortBy);
  paintHead();
  renderList();
});

$('head').addEventListener('pointerdown', (e) => {
  const h = e.target.closest('.rs');
  if (!h) return;
  e.preventDefault();
  const key = h.dataset.k;
  const startX = e.clientX, startW = colW[key];
  h.classList.add('on');
  document.body.classList.add('resizing');
  // Listen on the window, not the handle: the handle moves while the column changes width.
  const move = (ev) => { colW[key] = Math.max(44, Math.min(900, Math.round(startW + ev.clientX - startX))); applyWidths(); };
  const up = () => {
    h.classList.remove('on');
    document.body.classList.remove('resizing');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    window.removeEventListener('blur', up);
    store.set('colw', colW);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  window.addEventListener('blur', up);
});
$('head').addEventListener('dblclick', (e) => {
  const h = e.target.closest('.rs');
  if (!h) return;
  colW[h.dataset.k] = COLS.find((c) => c.key === h.dataset.k).w;
  applyWidths();
  store.set('colw', colW);
});

// When the download was last tried, whatever came of it. Older entries fall back to when they finished or were added.
const triedAt = (d) => d.lastTriedAt || d.completedAt || d.addedAt;
const fmtDate = (t) => {
  const d = new Date(t), now = new Date();
  const opts = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleString(undefined, opts);
};
const SORTERS = {
  name: (a, b) => (a.filename || a.url).localeCompare(b.filename || b.url, undefined, { numeric: true, sensitivity: 'base' }),
  size: (a, b) => (a.size > 0 ? a.size : a.downloaded || 0) - (b.size > 0 ? b.size : b.downloaded || 0),
  status: (a, b) => (STATUS[a.status] || a.status).localeCompare(STATUS[b.status] || b.status),
  date: (a, b) => triedAt(a) - triedAt(b),
};
buildHead();

// ---- show or hide sidebar items ----------------------------------------------------
// Categories and Downloaders can be trimmed to what the user uses. Ids: cat:<name>, folder:<id>, tool:<id>.
const hiddenItems = new Set(store.get('hidden', []));
function shown(id) { return !hiddenItems.has(id); }
function visItems(group) {
  if (group === 'categories') return [...CATS.map((c) => ({ id: 'cat:' + c, label: c })), ...tools.filter((t) => t.folder).map((t) => ({ id: 'folder:' + t.id, label: t.name + ' folder' }))];
  return enabledDownloaders().map((t) => ({ id: 'tool:' + t.id, label: t.name }));
}
let visGroup = null;
function closeVisMenu() {
  $('visMenu').hidden = true;
  visGroup = null;
  for (const b of document.querySelectorAll('.vis-btn.on')) b.classList.remove('on');
}
function fillVisMenu() {
  const rows = visItems(visGroup);
  $('visMenu').innerHTML = `<div class="vhead">${visGroup === 'categories' ? 'Categories' : 'Downloaders'}</div>` +
    rows.map((r) => `<label><input type="checkbox" data-id="${esc(r.id)}" ${shown(r.id) ? 'checked' : ''}> ${esc(r.label)}</label>`).join('') +
    '<div class="vfoot"><button class="btn" data-all="1">Show all</button></div>';
}
function openVisMenu(btn) {
  if (visGroup === btn.dataset.vis) { closeVisMenu(); return; }
  closeVisMenu();
  visGroup = btn.dataset.vis;
  btn.classList.add('on');
  fillVisMenu();
  const m = $('visMenu');
  m.hidden = false;
  const r = btn.getBoundingClientRect();
  m.style.left = Math.min(r.left, innerWidth - m.offsetWidth - 8) + 'px';
  m.style.top = Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8) + 'px';
}
function applyVisibility() {
  store.set('hidden', [...hiddenItems]);
  // Do not leave the user looking at something that just disappeared from the list.
  let changed = false;
  if (filter.startsWith('cat:') && !shown(filter)) { filter = 'all'; changed = true; }
  if (activeTool && (!shown('tool:' + activeTool) && tools.some((t) => t.id === activeTool && t.kind !== 'tool'))) leaveTool();
  renderSide();
  if (changed) renderList();
  // renderSide rebuilt the buttons, so mark the one whose menu is open
  const b = document.querySelector(`.vis-btn[data-vis="${visGroup}"]`);
  if (b) b.classList.add('on');
}
$('visMenu').addEventListener('change', (e) => {
  const id = e.target.dataset && e.target.dataset.id;
  if (!id) return;
  if (e.target.checked) hiddenItems.delete(id); else hiddenItems.add(id);
  applyVisibility();
});
$('visMenu').addEventListener('click', (e) => {
  if (!e.target.closest('[data-all]')) return;
  for (const r of visItems(visGroup)) hiddenItems.delete(r.id);
  fillVisMenu();
  applyVisibility();
});
document.addEventListener('mousedown', (e) => { if (visGroup && !e.target.closest('#visMenu, .vis-btn')) closeVisMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && visGroup) closeVisMenu(); });

function paintRow(el, d) {
  const pct = d.status === 'completed' ? 100 : d.chunks && d.chunks[1] ? (d.chunks[0] / d.chunks[1]) * 100 : d.size > 0 ? Math.min(100, (d.downloaded / d.size) * 100) : 0;
  el.classList.toggle('sel', d.id === selected);
  el.classList.toggle('done', d.status === 'completed');
  el.classList.toggle('err', d.status === 'error');
  const [b, small] = el.querySelector('.nm').children;
  b.textContent = d.filename || d.url;
  b.title = d.filename || d.url;
  small.textContent = d.status === 'error' ? d.error : hostOf(d.url) + (d.type === 'hls' || d.type === 'dash' ? `  ·  ${d.type.toUpperCase()}${d.quality ? ' ' + d.quality.split(' ')[0] : ''}` : '') + (d.status === 'downloading' ? `  ·  ${d.connections} connections` : '') + (!d.resumable && d.size > 0 ? '  ·  no resume' : '') + (d.comment ? `  ·  ${d.comment}` : '');
  el.querySelector('.sz').textContent = d.size > 0 ? (d.chunks && d.status !== 'completed' ? '~' : '') + bytes(d.size) : (d.downloaded ? bytes(d.downloaded) : '');
  el.querySelector('.bar i').style.width = pct + '%';
  el.querySelector('.pct').textContent = d.chunks && d.chunks[1] ? `${pct.toFixed(1)}%  ·  ${d.chunks[0]}/${d.chunks[1]} chunks` : d.size > 0 ? `${pct.toFixed(1)}%  ·  ${bytes(d.downloaded)}` : bytes(d.downloaded);
  el.querySelector('.sp').textContent = d.speed > 0 ? bytes(d.speed) + '/s' : '';
  el.querySelector('.eta').textContent = dur(d.eta);
  const dt = el.querySelector('.dt');
  dt.textContent = fmtDate(triedAt(d));
  dt.title = new Date(triedAt(d)).toLocaleString();
  const st = el.querySelector('.st');
  st.className = 'st ' + d.status;
  st.textContent = STATUS[d.status] || d.status;
}
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

function visible() {
  const q = query.toLowerCase();
  return [...items.values()]
    .filter((d) => matchesFilter(d) && (!q || (d.filename + ' ' + d.url).toLowerCase().includes(q)))
    .sort((a, b) => {
      if (sortBy) {
        const r = SORTERS[sortBy.key](a, b);
        if (r) return sortBy.dir === 'asc' ? r : -r;
      }
      return b.addedAt - a.addedAt;
    });
}

function renderList() {
  const list = $('list');
  const vis = visible();
  const ids = new Set(vis.map((d) => d.id));
  for (const [id, el] of rows) if (!ids.has(id)) { el.remove(); rows.delete(id); }
  let prev = null;
  for (const d of vis) {
    let el = rows.get(d.id);
    if (!el) { el = makeRow(d.id); rows.set(d.id, el); }
    paintRow(el, d);
    const want = prev ? prev.nextSibling : list.firstChild;
    if (want !== el) list.insertBefore(el, want);
    prev = el;
  }
  $('empty').hidden = vis.length > 0;
  renderStatus();
}

function renderStatus() {
  const all = [...items.values()];
  const active = all.filter((d) => d.status === 'downloading').length;
  $('sCount').textContent = `${all.length} download${all.length === 1 ? '' : 's'}` + (active ? `, ${active} active` : '');
  $('sLimit').textContent = settings.speedLimit ? `Limit ${bytes(settings.speedLimit)}/s` : '';
  const hasSel = !!selected && items.has(selected);
  const s = hasSel ? items.get(selected).status : '';
  $('btnResume').disabled = !hasSel || !['paused', 'error'].includes(s);
  $('btnPause').disabled = !hasSel || !['downloading', 'queued'].includes(s);
  $('btnRemove').disabled = !hasSel;
}

// ---- detail panel ----------------------------------------------------------------
function renderDetail() {
  const d = items.get(selected);
  $('dName').textContent = d ? d.filename || d.url : 'No download selected';
  $('dUrl').textContent = d ? d.url : '';
  $('dConn').textContent = d ? `${d.connections} of ${d.maxConnections}` : '';
  $('dSpeed').textContent = d ? (d.speed > 0 ? bytes(d.speed) + '/s' : '') : '';
  const f = [];
  if (d) {
    f.push(['Size', d.size > 0 ? bytes(d.size) : 'unknown'], ['Done', bytes(d.downloaded)],
      ['Resume', d.resumable ? 'supported' : 'not supported'], ['Type', d.type === 'hls' ? 'HLS video stream' : d.type === 'dash' ? 'DASH video stream' : d.mime || 'unknown'],
      ['Folder', d.dir], [d.chunks ? 'Chunks' : 'Segments', d.chunks ? `${d.chunks[0]} of ${d.chunks[1]}` : String(d.segments.length)], ['Added', new Date(d.addedAt).toLocaleString()]);
    if (d.checksum) f.push(['Checksum', 'checked on finish']);
  }
  $('facts').innerHTML = f.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
  drawSegments(d);
  drawGraph();
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function fit(c) {
  const dpr = devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function drawSegments(d) {
  const { g, w, h } = fit($('segmap'));
  const span = d && (d.mapSize || d.size);
  if (!d || !(span > 0)) return;
  for (const [start, end, pos] of d.segments) {
    const x0 = (start / span) * w, x1 = ((end + 1) / span) * w;
    const xp = (pos / span) * w;
    g.fillStyle = css('--accent');
    g.fillRect(x0, 0, Math.max(0, xp - x0), h);
    if (pos <= end) {
      g.fillStyle = css('--accent-dim');
      g.fillRect(xp, 0, x1 - xp, h);
    }
    g.fillStyle = css('--bg');
    g.fillRect(x0, 0, 1.5, h);   // segment boundary
  }
}

function drawGraph() {
  const { g, w, h } = fit($('graph'));
  const data = selected && history.has(selected) ? history.get(selected) : totalHist;
  if (data.length < 2) return;
  const max = Math.max(...data, 1) * 1.15;
  g.strokeStyle = css('--line'); g.lineWidth = 1;
  for (let i = 1; i < 4; i++) { const y = (h / 4) * i; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  const step = w / 59;
  const pts = data.map((v, i) => [w - (data.length - 1 - i) * step, h - (v / max) * (h - 6) - 3]);
  g.beginPath(); g.moveTo(pts[0][0], h);
  pts.forEach(([x, y]) => g.lineTo(x, y));
  g.lineTo(pts[pts.length - 1][0], h); g.closePath();
  g.fillStyle = 'rgba(91,140,255,.18)'; g.fill();
  g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.strokeStyle = css('--accent'); g.lineWidth = 1.6; g.stroke();
  g.fillStyle = css('--faint'); g.font = '10px sans-serif'; g.fillText(bytes(max / 1.15) + '/s', 6, 12);
}

// ---- selection & actions ---------------------------------------------------------
$('list').addEventListener('click', (e) => {
  const el = e.target.closest('.item');
  select(el ? el.dataset.id : null);
});
$('list').addEventListener('dblclick', (e) => {
  const el = e.target.closest('.item');
  if (!el) return;
  const d = items.get(el.dataset.id);
  if (d.status === 'completed') sg.open(d.id); else if (['paused', 'error'].includes(d.status)) sg.resume(d.id);
});
function select(id) {
  selected = id;
  for (const [rid, el] of rows) el.classList.toggle('sel', rid === id);
  renderStatus();
  renderDetail();
}

$('btnResume').onclick = () => selected && sg.resume(selected);
$('btnPause').onclick = () => selected && sg.pause(selected);
$('btnRemove').onclick = () => selected && removeItem(selected, false);
$('btnResumeAll').onclick = () => sg.resumeAll();
$('btnPauseAll').onclick = () => sg.pauseAll();
$('search').oninput = (e) => { query = e.target.value; renderList(); };

async function removeItem(id, del) {
  await sg.remove(id, del);
  items.delete(id);
  if (selected === id) select(null);
  renderSide(); renderList();
}

// context menu
const menu = $('menu');
$('list').addEventListener('contextmenu', (e) => {
  const el = e.target.closest('.item');
  if (!el) return;
  e.preventDefault();
  select(el.dataset.id);
  const d = items.get(el.dataset.id);
  const run = ['downloading', 'queued'].includes(d.status);
  const entries = [
    d.status === 'completed' && ['Open', () => sg.open(d.id)],
    ['Show in folder', () => sg.reveal(d.id)],
    run && ['Pause', () => sg.pause(d.id)],
    ['paused', 'error'].includes(d.status) && ['Resume', () => sg.resume(d.id)],
    d.status !== 'completed' && ['Limit speed…', () => limitPrompt(d)],
    ['Copy link', () => sg.copyUrl(d.id)],
    '-',
    ['Remove from list', () => removeItem(d.id, false)],
    ['Remove and delete files', () => removeItem(d.id, true), 'danger'],
  ].filter(Boolean);
  menu.innerHTML = '';
  for (const en of entries) {
    if (en === '-') { menu.appendChild(document.createElement('hr')); continue; }
    const row = document.createElement('div');
    row.textContent = en[0];
    if (en[2]) row.className = en[2];
    row.onclick = () => { menu.hidden = true; en[1](); };
    menu.appendChild(row);
  }
  menu.hidden = false;
  menu.style.left = Math.min(e.clientX, innerWidth - 210) + 'px';
  menu.style.top = Math.min(e.clientY, innerHeight - menu.offsetHeight - 8) + 'px';
});
addEventListener('click', () => { menu.hidden = true; });

let limitFor = null;
function limitPrompt(d) {
  limitFor = d.id;
  $('limVal').value = Math.round((d.speedLimit || 0) / 1024);
  $('dlgLimit').showModal();
  $('limVal').select();
}
$('limCancel').onclick = () => $('dlgLimit').close();
$('limOk').onclick = async () => {
  await sg.speedLimit(limitFor, Math.max(0, Number($('limVal').value) || 0) * 1024);
  $('dlgLimit').close();
};

// ---- add dialog ------------------------------------------------------------------
const dlgAdd = $('dlgAdd');
let probeTimer = null;
function fillSelect(sel, from, to, cur) {
  sel.innerHTML = '';
  for (let i = from; i <= to; i++) sel.add(new Option(String(i), String(i), false, i === cur));
}

let lastProbe = null;
async function openAdd(prefill = '', hdrs = {}) {
  leaveTool();
  $('addUrls').value = prefill;
  $('probe').innerHTML = '';
  $('qualRow').hidden = true;
  lastProbe = null;
  ['addRef', 'addCookie', 'addSum', 'addName'].forEach((i) => ($(i).value = ''));
  $('addRef').value = hdrs.referer || '';
  $('addCookie').value = hdrs.cookie || '';
  $('addDir').value = settings.downloadDir || '';
  fillSelect($('addConn'), 1, 32, settings.connections || 8);
  if (!prefill) {
    const clip = (await sg.clipboard()).trim();
    if (/^https?:\/\/\S+$/i.test(clip)) $('addUrls').value = clip;
  }
  if (!dlgAdd.open) dlgAdd.showModal();
  $('addUrls').focus(); $('addUrls').select();
  runProbe();
}
function urlsIn() { return $('addUrls').value.split(/\s+/).map((s) => s.trim()).filter(Boolean); }
$('addUrls').addEventListener('input', () => { clearTimeout(probeTimer); probeTimer = setTimeout(runProbe, 500); });
async function runProbe() {
  const urls = urlsIn();
  const box = $('probe');
  lastProbe = null;
  $('qualRow').hidden = true;
  if (urls.length !== 1) { box.innerHTML = urls.length > 1 ? `<span>${urls.length} links</span>` : ''; return; }
  box.innerHTML = '<span>Checking link…</span>';
  const r = await sg.probe(urls[0], headersFromForm());
  if (urlsIn()[0] !== urls[0]) return;
  if (r.error) { box.innerHTML = `<span class="bad">${esc(r.error)}</span>`; return; }
  lastProbe = r;
  if (r.type === 'hls' || r.type === 'dash') {
    $('addQual').innerHTML = r.variants.map((v, i) => `<option value="${i}">${esc(v.label)}</option>`).join('');
    $('qualRow').hidden = false;
    box.innerHTML = `<span class="ok">${esc(r.filename)}  ·  ${r.type.toUpperCase()} video stream</span>` +
      (r.drm ? '<span class="bad">This stream is DRM protected and cannot be downloaded.</span>' : r.live ? '<span class="bad">This is a live stream. Live recording is not supported yet.</span>' : '<span>Chunks download in parallel and are joined into one file at the end</span>');
    if (!$('addName').value) $('addName').placeholder = r.filename;
    return;
  }
  box.innerHTML = `<span class="ok">${esc(r.filename)}  ·  ${r.size > 0 ? bytes(r.size) : 'size unknown'}</span>` +
    `<span>${r.resumable ? 'Server supports resume and multiple connections' : 'Server does not support resume, one connection will be used'}</span>`;
  if (!$('addName').value) $('addName').placeholder = r.filename;
}
function headersFromForm() {
  const h = {};
  if ($('addRef').value.trim()) h.referer = $('addRef').value.trim();
  if ($('addCookie').value.trim()) h.cookie = $('addCookie').value.trim();
  return h;
}
async function submitAdd(start) {
  const urls = urlsIn();
  if (!urls.length) return;
  const base = { dir: $('addDir').value.trim() !== settings.downloadDir ? $('addDir').value.trim() : undefined, connections: Number($('addConn').value), headers: headersFromForm(), start };
  let batch = urls.map((url) => ({ ...base, url, ...(urls.length === 1 ? { filename: $('addName').value.trim(), checksum: $('addSum').value.trim() } : {}) }));
  if (urls.length === 1 && lastProbe && (lastProbe.type === 'hls' || lastProbe.type === 'dash')) {
    const v = lastProbe.variants[Number($('addQual').value) || 0];
    const name = lastProbe.filename.replace(/\.mp4$/, v.ext || '.mp4');
    batch = [{ ...base, ...v.add, quality: v.label, type: lastProbe.type, filename: $('addName').value.trim() || name }];
  }
  const res = await sg.add(batch);
  const bad = res.filter((r) => r.error);
  res.filter((r) => !r.error).forEach(upsert);
  dlgAdd.close();
  renderSide(); renderList();
  if (bad.length) toast(bad[0].error);
}
// ---- batch download ---------------------------------------------------------------
// One link or ticker per line, all of one kind. Each kind is checked on its own so a mixed list cannot slip through.
const dlgBatch = $('dlgBatch');
let bMode = 'normal';
let bBusy = false;
let bDefaults = { normal: '', screener: '', youtube: '' };   // where each kind saves unless the user picks another place
const bDirs = {};                                            // a place the user picked, per kind
const YT_RE = /^https?:\/\/((www|m|music)\.)?(youtube\.com|youtu\.be)\//i;
const SC_RE = /^https?:\/\/(www\.)?screener\.in\//i;
const BATCH = {
  normal: {
    help: 'Direct links to files of any type, one per line. YouTube and screener.in links do not work here, use their own tabs.',
    ph: 'https://example.com/file.zip\nhttps://example.com/video.mp4\nhttps://example.com/document.pdf',
    check(l) {
      if (YT_RE.test(l)) return 'YouTube link, use the YouTube tab';
      if (SC_RE.test(l)) return 'screener.in link, use the Screener tab';
      if (!/^https?:\/\/[^\s/]+\S*$/i.test(l)) return 'not a web link (needs http:// or https://)';
      if (/\.(m3u8|mpd)(\?|#|$)/i.test(l)) return 'video stream playlist, add it with Add URL to pick a quality';
      return '';
    },
  },
  screener: {
    help: 'Company tickers or screener.in company links, one per line. Each company gets all its annual reports, credit ratings and concalls.',
    ph: 'AVANTEL\nRELIANCE\nhttps://www.screener.in/company/TCS/consolidated/',
    check(l) {
      if (/^https?:\/\//i.test(l)) return /^https?:\/\/(www\.)?screener\.in\/company\/[^/?#]+/i.test(l) ? '' : 'not a screener.in company link';
      return /^[A-Za-z0-9&._-]{1,30}$/.test(l) ? '' : 'not a ticker (no spaces, one per line)';
    },
  },
  youtube: {
    help: 'YouTube video links, one per line. Each downloads at the best quality with your YouTube settings. Playlists are not supported here.',
    ph: 'https://www.youtube.com/watch?v=...\nhttps://youtu.be/...',
    check(l) {
      if (!YT_RE.test(l)) return 'not a YouTube link';
      let u;
      try { u = new URL(l); } catch { return 'not a valid link'; }
      const host = u.hostname.replace(/^(www|m|music)\./, '');
      if (host === 'youtu.be') return u.pathname.length > 1 ? '' : 'no video in this link';
      if (u.pathname === '/watch') return u.searchParams.get('v') ? '' : 'no video in this link';
      if (/^\/(shorts|live)\/[\w-]+/.test(u.pathname)) return '';
      if (u.pathname === '/playlist') return 'playlist, not supported in batch';
      return 'not a video link';
    },
  },
};

// The same video through different links (watch, youtu.be, with a playlist tacked on) is one video.
function ytKey(l) {
  try {
    const u = new URL(l);
    const id = u.hostname.endsWith('youtu.be') ? u.pathname.slice(1).split('/')[0] : u.searchParams.get('v') || u.pathname.split('/')[2] || '';
    return id ? 'yt:' + id : l;
  } catch { return l; }
}

// Same line written twice counts once; the key ignores letter case for tickers.
function batchParse() {
  const cfg = BATCH[bMode];
  const seen = new Set();
  const good = [], bad = [];
  let dup = 0;
  $('bLines').value.split(/\r?\n/).forEach((raw, i) => {
    const l = raw.trim();
    if (!l) return;
    const why = cfg.check(l);
    if (why) { bad.push({ n: i + 1, l, why }); return; }
    const key = bMode === 'screener' ? l.toUpperCase() : bMode === 'youtube' ? ytKey(l) : l;
    if (seen.has(key)) { dup++; return; }
    seen.add(key);
    good.push(l);
  });
  return { good, bad, dup };
}

const pad2 = (n) => String(n).padStart(2, '0');
function batchStamp() {
  const d = new Date();
  return `Mjolnir_Batch_${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function batchRender() {
  const { good, bad, dup } = batchParse();
  const noun = (n) => ({ normal: ['link', 'links'], screener: ['company', 'companies'], youtube: ['video', 'videos'] })[bMode][n === 1 ? 0 : 1];
  const parts = [];
  if (good.length) parts.push(`<span class="ok">${good.length} ${noun(good.length)} ready</span>`);
  if (dup) parts.push(`<span>${dup} repeated line${dup === 1 ? '' : 's'} ignored</span>`);
  for (const b of bad.slice(0, 4)) parts.push(`<span class="bad">Line ${b.n}: ${esc(b.why)}</span>`);
  if (bad.length > 4) parts.push(`<span class="more">and ${bad.length - 4} more ${bad.length - 4 === 1 ? 'line' : 'lines'} with problems</span>`);
  $('bInfo').innerHTML = parts.join('');
  const n = good.length;
  const word = { normal: 'Start', screener: 'Download', youtube: 'Download' }[bMode];
  $('bGo').textContent = n ? `${word} ${n}` : word;
  $('bGo').disabled = bBusy || !n;
  $('bLater').disabled = bBusy || !n;
  $('bLater').style.visibility = bMode === 'normal' ? 'visible' : 'hidden';
  $('bGo').title = bad.length && n ? `${bad.length} line${bad.length === 1 ? '' : 's'} with problems will be skipped` : '';
}

let bWhereSeq = 0;
async function batchWhere() {
  const dir = $('bDir').value.trim() || bDefaults[bMode];
  if ($('bNewFolder').checked) {
    // Same clean-up the app applies when it creates the folder
    let name = $('bFolder').value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
    if (!name) {
      const seq = ++bWhereSeq;
      try { name = await sg.batchFolderName(bMode, $('bDir').value.trim() === bDefaults[bMode] ? '' : $('bDir').value.trim()); } catch { name = batchStamp(); }
      if (seq !== bWhereSeq) return;   // a newer change came in while asking
    }
    $('bWhere').textContent = `Files go in ${dir}\\${name}` + (bMode === 'screener' ? '\\<ticker>' : '');
  } else {
    bWhereSeq++;
    $('bWhere').textContent = bMode === 'screener' ? `Each company gets its own folder in ${dir}` : `Files go in ${dir}`;
  }
}

// Normal is always there. YouTube and Screener only while they are turned on in Settings; with neither, there is no switch.
function batchModesShown() {
  let n = 0;
  for (const b of $('bMode').children) {
    const on = b.dataset.m === 'normal' || dlEnabled(b.dataset.m);
    b.hidden = !on;
    if (on && b.dataset.m !== 'normal') n++;
  }
  $('bMode').hidden = n === 0;
}

function batchMode(m) {
  if (m !== 'normal' && !dlEnabled(m)) m = 'normal';
  bDirs[bMode] = $('bDir').value.trim();
  bMode = m;
  for (const b of $('bMode').children) b.classList.toggle('on', b.dataset.m === m);
  $('bHelp').textContent = BATCH[m].help;
  $('bLines').placeholder = BATCH[m].ph;
  $('bDir').value = bDirs[m] || bDefaults[m] || '';
  $('bForceRow').style.visibility = m === 'screener' ? 'visible' : 'hidden';
  batchRender();
  batchWhere();
}

async function openBatch() {
  leaveTool();
  if (bBusy) { if (!dlgBatch.open) dlgBatch.showModal(); return; }
  try { bDefaults = await sg.batchDefaults(); } catch { /* keep the last known places */ }
  for (const k of Object.keys(bDirs)) delete bDirs[k];
  $('bLines').value = '';
  $('bForce').checked = !!settings.force;
  $('bNewFolder').checked = false;
  $('bFolder').value = '';
  $('bFolder').disabled = true;
  $('bBar').style.visibility = 'hidden';
  bMode = 'normal';
  batchModesShown();
  $('bDir').value = '';
  batchMode('normal');
  if (!dlgBatch.open) dlgBatch.showModal();
  $('bLines').focus();
}

const BATCH_LOCK = ['bLines', 'bDir', 'bBrowse', 'bForce', 'bNewFolder', 'bFolder'];
async function batchGo(start) {
  const { good } = batchParse();
  if (!good.length || bBusy) return;
  bBusy = true;
  const mode = bMode;
  for (const id of BATCH_LOCK) $(id).disabled = true;
  for (const b of $('bMode').children) b.disabled = true;
  $('bBar').style.visibility = 'visible';
  $('bBar').firstElementChild.style.width = '0%';
  $('bInfo').innerHTML = `<span>Adding 0 of ${good.length}…</span>`;
  batchRender();
  let res = [];
  try {
    const dir = $('bDir').value.trim();
    res = await sg.batchRun({
      mode, lines: good, start, force: $('bForce').checked,
      dir: dir && dir !== bDefaults[mode] ? dir : '',
      // null: no new folder. An empty name means "pick one for me".
      folder: $('bNewFolder').checked ? $('bFolder').value.trim() : null,
    });
  } catch (e) {
    res = good.map((line) => ({ line, ok: false, error: e.message }));
  }
  bBusy = false;
  for (const id of BATCH_LOCK) $(id).disabled = false;
  $('bFolder').disabled = !$('bNewFolder').checked;
  for (const b of $('bMode').children) b.disabled = false;
  $('bBar').style.visibility = 'hidden';
  const failed = res.filter((r) => !r.ok);
  const added = res.length - failed.length;
  (await sg.list()).forEach(upsert);
  renderSide(); renderList();
  const where = { normal: 'the download list', screener: 'Screener', youtube: 'YouTube' }[mode];
  if (!failed.length) {
    dlgBatch.close();
    toast(`Added ${added} to ${where}${mode === 'normal' ? '' : '. Click to see progress'}`, mode === 'normal' ? undefined : () => enterTool(mode));
    return;
  }
  // Keep only what failed in the box so it can be fixed and sent again.
  $('bLines').value = failed.map((f) => f.line).join('\n');
  batchRender();
  $('bInfo').innerHTML = (added ? `<span class="ok">${added} added to ${where}</span>` : '') +
    failed.slice(0, 5).map((f) => `<span class="bad">${esc(f.line.length > 60 ? f.line.slice(0, 57) + '…' : f.line)}: ${esc(f.error)}</span>`).join('') +
    (failed.length > 5 ? `<span class="more">and ${failed.length - 5} more failed</span>` : '') +
    '<span>The lines that failed are still in the box.</span>';
}

$('btnBatch').onclick = openBatch;
$('bMode').onclick = (e) => { const b = e.target.closest('button'); if (b && !bBusy) batchMode(b.dataset.m); };
$('bLines').addEventListener('input', batchRender);
$('bDir').addEventListener('input', batchWhere);
$('bFolder').addEventListener('input', batchWhere);
$('bNewFolder').onchange = () => {
  $('bFolder').disabled = !$('bNewFolder').checked;
  if ($('bNewFolder').checked) $('bFolder').focus();
  batchWhere();
};
$('bBrowse').onclick = async () => { const p = await sg.pickFolder(); if (p) { $('bDir').value = p; batchWhere(); } };
$('bCancel').onclick = () => { if (!bBusy) dlgBatch.close(); };
dlgBatch.addEventListener('cancel', (e) => { if (bBusy) e.preventDefault(); });
$('bGo').onclick = () => batchGo(true);
$('bLater').onclick = () => batchGo(false);
sg.on('batch-progress', ({ done, total }) => {
  $('bBar').firstElementChild.style.width = `${Math.round((done / total) * 100)}%`;
  $('bInfo').innerHTML = `<span>Adding ${done} of ${total}…</span>`;
});

$('btnAdd').onclick = () => openAdd();
$('addCancel').onclick = () => dlgAdd.close();
$('addGo').onclick = () => submitAdd(true);
$('addLater').onclick = () => submitAdd(false);
$('addBrowse').onclick = async () => { const p = await sg.pickFolder(); if (p) $('addDir').value = p; };

// ---- settings --------------------------------------------------------------------
const dlgSet = $('dlgSettings');
function openSettings(focusId) {
  leaveTool();
  fillSelect($('sConn'), 1, 32, settings.connections);
  fillSelect($('sConc'), 1, 10, settings.maxConcurrent);
  fillSelect($('sRetry'), 0, 20, settings.autoRetry);
  $('sDir').value = settings.downloadDir;
  $('sLimitIn').value = Math.round((settings.speedLimit || 0) / 1024);
  $('sSort').checked = settings.sortIntoFolders;
  $('sClip').checked = settings.clipboardWatch;
  $('sSched').checked = settings.schedule.enabled;
  $('sStart').value = settings.schedule.start;
  $('sStop').value = settings.schedule.stop;
  $('sDlSet').hidden = !allDownloaders().length;
  $('sDownloaders').innerHTML = allDownloaders().map((t) => `<label class="check"><input type="checkbox" data-dl="${esc(t.id)}" ${dlEnabled(t.id) ? 'checked' : ''}> ${esc(t.name)}</label>`).join('');
  if (!dlgSet.open) dlgSet.showModal();
  if (focusId) $(focusId).focus();
}
$('btnSettings').onclick = () => openSettings();
// $('btnSched').onclick = () => openSettings('sSched');   // scheduler icon is off for now

// ---- browser extension -----------------------------------------------------------
const dlgExt = $('dlgExt');
function renderExt() {
  $('xOn').checked = settings.extensionEnabled !== false;
  $('xMin').value = settings.extensionMinMB ?? 2;
  $('xMin').disabled = !$('xOn').checked;
  $('xOnHint').textContent = $('xOn').checked ? 'Downloads the browser starts are sent here and open a small window to confirm.' : 'Off. The browser downloads files itself. The toolbar icon and right-click menu still work.';
  $('xToken').value = settings.extensionToken;
}
$('btnExt').onclick = () => { leaveTool(); renderExt(); if (!dlgExt.open) dlgExt.showModal(); };
$('xOn').onchange = async () => { settings = await sg.setSettings({ extensionEnabled: $('xOn').checked }); renderExt(); };
$('xMin').onchange = async () => {
  const v = Math.max(0, Math.min(100000, Number($('xMin').value) || 0));
  settings = await sg.setSettings({ extensionMinMB: v });
  renderExt();
};
$('xCopy').onclick = () => { $('xToken').select(); navigator.clipboard.writeText($('xToken').value).then(() => toast('Token copied')).catch(() => {}); };
$('xToken').onfocus = (e) => e.target.select();
$('xClose').onclick = () => dlgExt.close();

// ---- phone link ------------------------------------------------------------------
const dlgPhone = $('dlgPhone');
let phoneTimer = null;
let phoneCountdown = null;
let phoneKnown = 0;      // how many phones were paired when the QR code was made

const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
};

function renderPhone(info) {
  $('phOn').checked = info.enabled;
  $('phOff').hidden = info.enabled;
  $('phBody').hidden = !info.enabled;
  if (!info.enabled) return;
  $('phUrl').textContent = info.url || 'No network found';
  const sel = $('phIp');
  const cur = sel.value;
  $('phNet').hidden = info.addresses.length < 2;
  sel.innerHTML = info.addresses.map((a) => `<option>${esc(a)}</option>`).join('');
  if (info.addresses.includes(cur)) sel.value = cur;
  $('phDevices').innerHTML = info.devices.length
    ? info.devices.map((d) => `<div class="ph-dev"><div><b>${esc(d.name)}</b><small>Last used ${ago(d.lastSeen)}</small></div><button type="button" class="btn sm" data-rev="${d.id}">Remove</button></div>`).join('')
    : '<div class="hint">No phones paired yet.</div>';
  // A new phone showed up while the code was on screen: pairing worked, so hide the code.
  if (!$('phQr').hidden && info.devices.length > phoneKnown) { hideQr(); toast('Phone paired'); }
}

function hideQr() { $('phQr').hidden = true; clearInterval(phoneCountdown); }

async function openPhone() {
  leaveTool();
  $('phMsg').textContent = '';
  hideQr();
  renderPhone(await sg.phoneInfo());
  if (!dlgPhone.open) dlgPhone.showModal();
  clearInterval(phoneTimer);
  phoneTimer = setInterval(async () => { if (dlgPhone.open) renderPhone(await sg.phoneInfo()); }, 2000);
}
$('btnPhone').onclick = openPhone;
$('phClose').onclick = () => dlgPhone.close();
$('phCopy').onclick = async () => {
  const text = $('phUrl').textContent;
  try { await navigator.clipboard.writeText(text); $('phCopy').textContent = 'Copied'; } catch { $('phCopy').textContent = 'Select and copy'; }
  setTimeout(() => { $('phCopy').textContent = 'Copy'; }, 1500);
};
dlgPhone.addEventListener('close', () => { clearInterval(phoneTimer); hideQr(); });
$('phOn').onchange = async (e) => {
  const r = await sg.phoneEnable(e.target.checked);
  $('phMsg').textContent = r.error || '';
  hideQr();
  renderPhone(r);
};
$('phPair').onclick = async () => {
  $('phMsg').textContent = '';
  const info = await sg.phoneInfo();
  phoneKnown = info.devices.length;
  const r = await sg.phonePair($('phIp').value || undefined);
  if (r.error) { $('phMsg').textContent = r.error; return; }
  $('phQrImg').src = r.qr;
  $('phQr').hidden = false;
  clearInterval(phoneCountdown);
  const tick = () => {
    const left = Math.max(0, Math.round((r.expires - Date.now()) / 1000));
    $('phQrNote').textContent = left ? `Scan with your phone camera. Same Wi-Fi as this PC. Code works for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.` : 'This code expired. Press Pair a phone for a new one.';
    if (!left) clearInterval(phoneCountdown);
  };
  tick();
  phoneCountdown = setInterval(tick, 1000);
};
$('phDevices').onclick = async (e) => {
  const b = e.target.closest('[data-rev]');
  if (b) renderPhone(await sg.phoneRevoke(b.dataset.rev));
};
$('sCancel').onclick = () => dlgSet.close();
$('sBrowse').onclick = async () => { const p = await sg.pickFolder(); if (p) $('sDir').value = p; };
$('sSave').onclick = async () => {
  settings = await sg.setSettings({
    downloadDir: $('sDir').value.trim(), connections: Number($('sConn').value), maxConcurrent: Number($('sConc').value),
    autoRetry: Number($('sRetry').value), speedLimit: Math.max(0, Number($('sLimitIn').value) || 0) * 1024,
    sortIntoFolders: $('sSort').checked, clipboardWatch: $('sClip').checked,
    schedule: { enabled: $('sSched').checked, start: $('sStart').value || '02:00', stop: $('sStop').value || '06:00' },
    // Only touch the list when the section was shown, so a failed downloader list never turns everything off.
    ...($('sDlSet').hidden ? {} : { disabledDownloaders: [...$('sDownloaders').querySelectorAll('input[data-dl]')].filter((c) => !c.checked).map((c) => c.dataset.dl) }),
  });
  dlgSet.close();
  // A downloader that was just turned off must not stay open on screen.
  if (activeTool && !dlEnabled(activeTool) && allDownloaders().some((t) => t.id === activeTool)) leaveTool();
  renderSide();
  renderStatus();
};

// ---- toasts, drag-drop, keys -----------------------------------------------------
let toastTimer;
function toast(msg, onClick) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (onClick ? ' link' : '');
  t.onclick = onClick ? () => { t.hidden = true; onClick(); } : null;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), onClick ? 8000 : 3500);
}
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  const t = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (/^https?:\/\//i.test(t)) openAdd(t.trim());
});
addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); openAdd(); }
  if (e.key === 'Delete' && selected && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) removeItem(selected, false);
});
addEventListener('resize', () => renderDetail());

// ---- data feed -------------------------------------------------------------------
function upsert(d) { items.set(d.id, d); }

sg.on('list', (all) => {
  const ids = new Set(all.map((d) => d.id));
  for (const id of [...items.keys()]) if (!ids.has(id)) items.delete(id);
  all.forEach(upsert);
  renderSide(); renderList();
  if (selected && !items.has(selected)) select(null);
  else renderDetail();
});
sg.on('progress', ({ items: active, totalSpeed }) => {
  $('sSpeed').textContent = bytes(totalSpeed) + '/s';
  totalHist.push(totalSpeed); if (totalHist.length > 60) totalHist.shift();
  for (const d of active) {
    upsert(d);
    const h = history.get(d.id) || [];
    h.push(d.speed); if (h.length > 60) h.shift();
    history.set(d.id, h);
    const el = rows.get(d.id);
    if (el) paintRow(el, d);
  }
  if (selected && items.get(selected)?.status === 'downloading') renderDetail();
  else if (!selected) drawGraph();
});
sg.on('added', (d) => { upsert(d); renderSide(); renderList(); });
sg.on('removed', (id) => { items.delete(id); renderSide(); renderList(); });
sg.on('complete', (d) => toast(`Finished ${d.filename}`, () => sg.reveal(d.id)));
sg.on('toast', (m) => toast(m));
sg.on('dl-activity', (a) => { activity = a; renderSide(); });
// Links from a paired phone: say where they went and jump there on click.
sg.on('phone-received', ({ text, targets }) => {
  const first = targets.find((t) => t.key !== 'direct') || targets[0];
  if (!first) { toast(text); return; }
  const where = targets.map((t) => t.where).join(' and ');
  toast(`${text}, to ${where}. Click to see progress`, () => {
    if (first.key === 'direct') { leaveTool(); filter = 'all'; renderSide(); renderList(); } else enterTool(first.key);
  });
});
sg.on('open-add', ({ url, headers }) => openAdd(url, headers || {}));
sg.on('clipboard-url', (u) => toast('Link copied. Click to download it', () => openAdd(u)));

(async function boot() {
  settings = await sg.getSettings();
  tools = await sg.dlList().catch(() => []);
  (await sg.list()).forEach(upsert);
  renderSide(); renderList(); renderDetail();
})();
