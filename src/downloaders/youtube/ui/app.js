'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let info = null;
let mode = 'video';
let settings = {};
let engine = { installed: false, version: null };
let jobs = [];

function bytes(n) {
  if (!(n > 0)) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
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
const eta = (s) => (s > 0 ? (s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`) : '');

// ---- engine ----------------------------------------------------------------------
function renderEngine() {
  const chip = $('engineChip');
  $('setup').hidden = engine.installed;
  $('fetch').hidden = !engine.installed;
  $('btnUpdate').hidden = !engine.installed;
  if (engine.installed) { chip.textContent = `yt-dlp ${engine.version || ''}`; chip.className = 'chip ok'; }
  else { chip.textContent = 'Engine not installed'; chip.className = 'chip bad'; }
}

async function refreshEngine() {
  engine = await dl.invoke('status');
  renderEngine();
}

async function installEngine(label = 'Downloading') {
  $('btnInstall').disabled = true;
  $('installBar').hidden = false;
  $('installMsg').textContent = `${label}…`;
  try {
    await dl.invoke('install');
    $('installMsg').textContent = '';
  } catch (e) {
    $('installMsg').textContent = e.message;
  } finally {
    $('btnInstall').disabled = false;
    $('installBar').hidden = true;
    await refreshEngine();
  }
}
$('btnInstall').onclick = () => installEngine();
dl.on('engine', (p) => {
  if (p.progress !== undefined) {
    $('installBar').firstElementChild.style.width = `${Math.round(p.progress * 100)}%`;
    $('installMsg').textContent = `${bytes(p.got)} of ${bytes(p.total)}`;
  }
});

$('btnUpdate').onclick = async () => {
  const b = $('btnUpdate');
  b.disabled = true;
  b.textContent = 'Checking…';
  try {
    const u = await dl.invoke('checkUpdate');
    if (!u.outdated) { b.textContent = 'Up to date'; setTimeout(() => { b.textContent = 'Check for updates'; b.disabled = false; }, 2000); return; }
    b.textContent = `Updating to ${u.latest}…`;
    await dl.invoke('install');
    await refreshEngine();
    b.textContent = 'Updated';
  } catch (e) {
    b.textContent = 'Update failed';
    showMsg(e.message);
  }
  setTimeout(() => { b.textContent = 'Check for updates'; b.disabled = false; }, 2500);
};

// ---- fetch & preview -------------------------------------------------------------
function showMsg(t, isInfo) {
  const m = $('fetchMsg');
  m.textContent = t || '';
  m.className = 'msg' + (isInfo ? ' info' : '');
  m.hidden = !t;
}

async function fetchInfo() {
  const url = $('url').value.trim();
  if (!url) return;
  $('btnFetch').disabled = true;
  $('btnFetch').textContent = 'Fetching…';
  showMsg('Asking YouTube for the available formats…', true);
  $('preview').hidden = true;
  $('plCard').hidden = true;
  try {
    info = await dl.invoke('info', url);
    showMsg('');
    renderPreview();
  } catch (e) {
    info = null;
    if (e.message === 'ENGINE_MISSING') { await refreshEngine(); showMsg('Download the engine first.'); }
    else showMsg(e.message);
  } finally {
    $('btnFetch').disabled = false;
    $('btnFetch').textContent = 'Get video';
  }
}
// Drop what was fetched without starting anything.
$('btnCancelInfo').onclick = () => {
  info = null;
  $('preview').hidden = true;
  $('plCard').hidden = true;
  $('url').value = '';
  showMsg('');
  $('url').focus();
};
$('btnFetch').onclick = fetchInfo;
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchInfo(); });
$('url').addEventListener('paste', () => setTimeout(() => { if (/^https?:\/\//.test($('url').value.trim())) fetchInfo(); }, 50));

function renderPreview() {
  const i = info;
  $('preview').hidden = false;
  $('pThumb').src = i.thumbnail || '';
  $('pTitle').textContent = i.title;
  const isList = i.kind === 'playlist';
  $('pMeta').textContent = isList
    ? [i.channel, `Playlist, ${i.count} videos`, dur(i.duration)].filter(Boolean).join('  ·  ')
    : [i.channel, dur(i.duration)].filter(Boolean).join('  ·  ');
  $('subRow').hidden = isList || !i.subs;
  document.querySelectorAll('.plOnly').forEach((el) => { el.hidden = !isList; });
  $('btnPlaylist').hidden = isList || !i.playlistUrl;
  if (!isList) { $('btnDownload').textContent = 'Download'; $('btnDownload').disabled = false; }
  $('plCard').hidden = !isList;
  if (isList) {
    $('oFolder').checked = true;
    $('oNumber').checked = true;
    $('plFilter').value = '';
    plSel = new Set(i.entries.filter((e) => !e.unavailable).map((e) => e.id));
    plLast = -1;
    renderPl();
  }
  $('oThumb').checked = !!settings.thumb;
  $('oMeta').checked = !!settings.meta;
  $('oSubs').checked = false;
  $('oCont').value = settings.container || 'compat';
  $('oAudio').value = settings.audioFormat || 'mp3';

  fillQualities();
  setMode(i.kind === 'video' && !i.qualities.length ? 'audio' : 'video');
  $('pNote').textContent = i.live ? 'This is a live stream. Live recording is not supported, the download may not finish.' : '';
}

// The size and codec depend on the container: MP4 prefers H.264, MKV prefers the smallest codec.
function fillQualities(keep) {
  const q = $('oQual');
  q.innerHTML = '';
  if (!info) return;
  if (info.kind === 'playlist') {
    for (const [v, l] of [[0, 'Best available'], [2160, 'Up to 2160p (4K)'], [1440, 'Up to 1440p'], [1080, 'Up to 1080p'], [720, 'Up to 720p'], [480, 'Up to 480p'], [360, 'Up to 360p']]) q.add(new Option(l, String(v)));
    return;
  }
  if (!info.qualities.length) { q.add(new Option('Audio only', '0')); return; }
  const c = $('oCont').value;
  const label = (x) => {
    const p = x.picks[c];
    return `${x.label}  ·  ${p.codec}${p.size ? '  ·  ~' + bytes(p.size) : ''}`;
  };
  q.add(new Option(`Best  ·  ${label(info.qualities[0])}`, '0'));
  for (const x of info.qualities) q.add(new Option(label(x), String(x.height)));
  if (keep !== undefined) q.value = keep;
}
$('oCont').onchange = () => { fillQualities($('oQual').value); updateSize(); };

function setMode(m) {
  mode = m;
  for (const b of $('modeSeg').children) b.classList.toggle('on', b.dataset.m === m);
  const v = m === 'video';
  $('qRow').hidden = !v;
  $('cRow').hidden = !v;
  $('aRow').hidden = v;
  $('oSubs').parentElement.hidden = !v || !info || info.kind === 'playlist' || !info.subs;
  updateSize();
}
$('modeSeg').onclick = (e) => { if (e.target.dataset.m) setMode(e.target.dataset.m); };
$('oQual').onchange = updateSize;

function currentPick() {
  if (!info || info.kind !== 'video' || mode !== 'video' || !info.qualities.length) return null;
  const h = Number($('oQual').value) || info.qualities[0].height;
  const q = info.qualities.find((x) => x.height === h) || info.qualities[0];
  return q.picks[$('oCont').value];
}
function currentSize() {
  if (!info || info.kind !== 'video') return 0;
  if (mode === 'audio') return info.audioSizes ? info.audioSizes.compat : info.audioSize;
  const p = currentPick();
  return p ? p.size : 0;
}
function updateSize() {
  const s = currentSize();
  $('pSize').textContent = s ? `~${bytes(s)}` : '';
}

// ---- playlist picker -------------------------------------------------------------
let plSel = new Set();
let plLast = -1;   // last clicked row, for shift-click ranges

const plVisible = () => {
  const q = $('plFilter').value.trim().toLowerCase();
  return info.entries.filter((e) => !q || e.title.toLowerCase().includes(q));
};

function renderPl() {
  if (!info || info.kind !== 'playlist') return;
  const rows = plVisible();
  $('plList').innerHTML = rows.map((e) => `<div class="pl-row ${e.unavailable ? 'off' : ''}" data-id="${esc(e.id)}">
    <input type="checkbox" ${plSel.has(e.id) ? 'checked' : ''} ${e.unavailable ? 'disabled' : ''}>
    <span class="ix">${e.index}</span>
    <img src="https://i.ytimg.com/vi/${esc(e.id)}/default.jpg" loading="lazy" alt="">
    <span class="tt" title="${esc(e.title)}">${esc(e.title)}</span>
    <span class="du">${e.unavailable ? 'Private' : dur(e.duration)}</span></div>`).join('') || '<div class="empty">No videos match.</div>';
  updatePlCount();
}

function updatePlCount() {
  if (!info || info.kind !== 'playlist') return;
  const picked = info.entries.filter((e) => plSel.has(e.id));
  const total = picked.reduce((a, e) => a + e.duration, 0);
  $('plCount').textContent = `${picked.length} of ${info.count} selected${total ? '  ·  ' + dur(total) : ''}`;
  $('btnDownload').textContent = picked.length ? `Download ${picked.length} video${picked.length === 1 ? '' : 's'}` : 'Pick videos first';
  $('btnDownload').disabled = !picked.length;
}

$('plList').addEventListener('click', (e) => {
  const row = e.target.closest('.pl-row');
  if (!row || row.classList.contains('off')) return;
  const rows = plVisible();
  const idx = rows.findIndex((x) => x.id === row.dataset.id);
  const turnOn = !plSel.has(row.dataset.id);
  if (e.shiftKey && plLast >= 0) {
    const [a, b] = [Math.min(plLast, idx), Math.max(plLast, idx)];
    for (const x of rows.slice(a, b + 1)) if (!x.unavailable) turnOn ? plSel.add(x.id) : plSel.delete(x.id);
  } else turnOn ? plSel.add(row.dataset.id) : plSel.delete(row.dataset.id);
  plLast = idx;
  e.preventDefault();
  renderPl();
});
$('plAll').onclick = () => { for (const x of plVisible()) if (!x.unavailable) plSel.add(x.id); renderPl(); };
$('plNone').onclick = () => { for (const x of plVisible()) plSel.delete(x.id); renderPl(); };
$('plFilter').addEventListener('input', renderPl);
$('btnPlaylist').onclick = () => { if (info && info.playlistUrl) { $('url').value = info.playlistUrl; fetchInfo(); } };

$('btnDownload').onclick = async () => {
  if (!info) return;
  const isList = info.kind === 'playlist';
  if (isList) { await downloadPlaylist(); return; }
  const opts = {
    mode, playlist: isList, height: Number($('oQual').value) || 0, container: $('oCont').value, audioFormat: $('oAudio').value,
    thumb: $('oThumb').checked, meta: $('oMeta').checked, subs: $('oSubs').checked && !$('oSubs').parentElement.hidden,
  };
  const pick = currentPick();
  if (pick) { opts.formatId = pick.v; opts.audioId = pick.a; }
  try {
    await dl.invoke('add', {
      url: info.url, title: info.title, channel: info.channel, thumbnail: info.thumbnail, duration: info.duration,
      count: info.count || 0, approxSize: currentSize(), audioSize: pick && info.audioSizes ? info.audioSizes[$('oCont').value] : 0, opts,
    });
    $('preview').hidden = true;
    $('url').value = '';
    info = null;
  } catch (e) {
    showMsg(e.message);
  }
};

// ---- jobs ------------------------------------------------------------------------
const STAGE = { preparing: 'Preparing', downloading: 'Downloading', merging: 'Joining video and audio', converting: 'Converting', finishing: 'Finishing up' };

// "1.2 GB of ~2.1 GB". The total is an estimate until every stream has reported its size.
function sizeText(j) {
  if (!(j.done > 0) && !(j.total > 0)) return '';
  if (j.count > 1) return '';
  return j.total > 0 ? `  ·  ${bytes(j.done)} of ~${bytes(j.total)}` : `  ·  ${bytes(j.done)}`;
}

function statusText(j) {
  if (j.status === 'done') return `Done  ·  ${(j.files || []).length > 1 ? j.files.length + ' files' : 'saved'}${j.size ? '  ·  ' + bytes(j.size) : ''}`;
  if (j.status === 'paused') return `Paused  ·  ${Math.round((j.percent || 0) * 100)}%${sizeText(j)}`;
  if (j.status === 'queued') return 'Waiting';
  if (j.status === 'error') return j.error;
  const parts = [STAGE[j.stage] || 'Downloading'];
  if (j.count > 1) parts.push(`video ${j.index} of ${j.count}`);
  if (j.stage === 'downloading' || !j.stage) {
    parts.push(`${Math.round((j.percent || 0) * 100)}%${sizeText(j)}`);
    if (j.speed > 0) parts.push(`${bytes(j.speed)}/s`);
    if (j.eta > 0) parts.push(`${eta(j.eta)} left`);
  }
  return parts.join('  ·  ');
}

function describe(j) {
  const o = j.opts;
  if (o.mode === 'audio') return `Audio, ${o.audioFormat.toUpperCase()}`;
  return `${o.height ? 'Up to ' + o.height + 'p' : 'Best quality'}, ${o.container === 'best' ? 'MKV' : 'MP4'}`;
}

async function downloadPlaylist() {
  const items = info.entries.filter((e) => plSel.has(e.id) && !e.unavailable);
  if (!items.length) return;
  const opts = {
    mode, playlist: false, height: Number($('oQual').value) || 0, container: $('oCont').value, audioFormat: $('oAudio').value,
    thumb: $('oThumb').checked, meta: $('oMeta').checked, subs: false,
  };
  try {
    await dl.invoke('addMany', {
      playlist: { title: info.title, url: info.url, count: info.count },
      items: items.map((e) => ({ id: e.id, title: e.title, duration: e.duration, index: e.index })),
      opts, folder: $('oFolder').checked, number: $('oNumber').checked,
    });
    $('preview').hidden = true;
    $('plCard').hidden = true;
    $('url').value = '';
    info = null;
  } catch (e) {
    showMsg(e.message);
  }
}

function jobHtml(j, mini) {
  const pct = Math.round((j.percent || 0) * 100);
  const act = [];
  if (j.status === 'running' || j.status === 'queued') act.push(`<button class="btn sm" data-a="pause" data-id="${j.id}">Pause</button>`);
  if (j.status === 'paused') act.push(`<button class="btn sm" data-a="resume" data-id="${j.id}">Resume</button>`);
  if (j.status === 'error') {
    if (j.hint === 'update') act.push(`<button class="btn sm" data-a="update" data-id="${j.id}">Update engine and retry</button>`);
    act.push(`<button class="btn sm" data-a="resume" data-id="${j.id}">Retry</button>`);
  }
  if (j.status === 'done') act.push(`<button class="btn sm" data-a="open" data-id="${j.id}">Play</button>`);
  if (!mini) act.push(`<button class="btn sm" data-a="reveal" data-id="${j.id}">Folder</button>`);
  act.push(`<button class="btn sm" data-a="remove" data-id="${j.id}" title="Remove from list">Remove</button>`);
  const sub = (mini ? [describe(j)] : [j.channel, describe(j)]).concat(j.source === 'phone' ? ['Sent from phone'] : []).filter(Boolean).join('  ·  ');
  const stat = j.note && j.status === 'done' ? j.note : statusText(j);
  return `<div class="job ${j.status} ${mini ? 'mini' : ''}">
    <img src="${esc(j.thumbnail)}" alt="" loading="lazy">
    <div class="j-main">
      <div class="j-title" title="${esc(j.title)}">${esc(j.title)}</div>
      <div class="j-sub">${esc(sub)}</div>
      <div class="bar"><i style="width:${j.status === 'done' ? 100 : pct}%"></i></div>
      <div class="j-stat ${j.status === 'error' ? 'err' : ''}">${esc(stat)}</div>
    </div>
    <div class="j-act">${act.join('')}</div></div>`;
}

const openGroups = new Set();   // expanded playlists survive the constant refreshes

function groupHtml(g, items) {
  const n = items.length;
  const count = (s) => items.filter((j) => j.status === s).length;
  const done = count('done');
  const failed = count('error');
  const running = items.filter((j) => j.status === 'running');
  const speed = running.reduce((a, j) => a + (j.speed || 0), 0);
  const pct = Math.round((items.reduce((a, j) => a + (j.status === 'done' ? 1 : j.percent || 0), 0) / n) * 100);
  const active = running.length + count('queued');
  const parts = [`${done} of ${n} done`];
  if (running.length) parts.push(`${running.length} downloading`);
  if (count('queued')) parts.push(`${count('queued')} waiting`);
  if (count('paused')) parts.push(`${count('paused')} paused`);
  if (failed) parts.push(`${failed} failed`);
  if (speed > 0) parts.push(`${bytes(speed)}/s`);
  const act = [];
  if (active) act.push(`<button class="btn sm" data-a="pauseGroup" data-id="${g}">Pause all</button>`);
  if (count('paused') || failed) act.push(`<button class="btn sm" data-a="resumeGroup" data-id="${g}">${failed && !count('paused') ? 'Retry failed' : 'Resume all'}</button>`);
  act.push(`<button class="btn sm" data-a="revealGroup" data-id="${g}">Folder</button>`);
  act.push(`<button class="btn sm" data-a="removeGroup" data-id="${g}" title="Remove all from the list">Remove</button>`);
  const open = openGroups.has(g);
  const sorted = items.slice().sort((a, b) => a.group.position - b.group.position);
  return `<div class="group ${done === n ? 'done' : ''}">
    <div class="g-top"><div class="g-title" title="${esc(items[0].group.title)}">${esc(items[0].group.title)}<small>Playlist</small></div><div class="j-act">${act.join('')}</div></div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <div class="j-stat">${esc(parts.join('  ·  '))}</div>
    <details data-g="${g}" ${open ? 'open' : ''}><summary>Videos</summary>${open ? sorted.map((j) => jobHtml(j, true)).join('') : ''}</details></div>`;
}

function renderJobs() {
  $('empty').hidden = jobs.length > 0;
  const groups = new Map();
  const blocks = [];   // [addedTime, html], newest first like before
  for (const j of jobs) {
    if (j.group) {
      if (!groups.has(j.group.id)) groups.set(j.group.id, []);
      groups.get(j.group.id).push(j);
    } else blocks.push([j.added, jobHtml(j, false)]);
  }
  for (const [g, items] of groups) blocks.push([Math.max(...items.map((j) => j.added)), groupHtml(g, items)]);
  blocks.sort((a, b) => b[0] - a[0]);
  $('jobList').innerHTML = blocks.map((b) => b[1]).join('');
}

$('jobList').addEventListener('toggle', (e) => {
  const d = e.target;
  if (d.tagName === 'DETAILS' && d.dataset.g) {
    if (d.open === openGroups.has(d.dataset.g)) return;   // a re-render announcing itself, not a click
    if (d.open) openGroups.add(d.dataset.g); else openGroups.delete(d.dataset.g);
    renderJobs();   // rows are only built while a group is open
  }
}, true);

$('jobList').onclick = async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const { a, id } = b.dataset;
  try {
    if (a === 'update') {
      b.disabled = true; b.textContent = 'Updating…';
      await dl.invoke('install');
      await refreshEngine();
      await dl.invoke('resume', id);
    } else if (a === 'remove') await dl.invoke('remove', id, false);
    else await dl.invoke(a, id);
  } catch (err) { showMsg(err.message); }
};
$('btnClear').onclick = () => dl.invoke('clearDone');
dl.on('jobs', (list) => { jobs = list; renderJobs(); });

// ---- settings --------------------------------------------------------------------
const dlg = $('dlgSet');
$('btnGear').onclick = () => {
  $('sFolder').value = settings.folder || '';
  $('sCookies').value = settings.cookiesFrom || '';
  $('sPar').value = String(settings.maxParallel || 2);
  dlg.showModal();
};
$('sCancel').onclick = () => dlg.close();
$('sBrowse').onclick = async () => { const p = await dl.invoke('pickFolder'); if (p) $('sFolder').value = p; };
$('sSave').onclick = async () => {
  settings = await dl.invoke('setSettings', { folder: $('sFolder').value.trim(), cookiesFrom: $('sCookies').value, maxParallel: Number($('sPar').value) });
  dlg.close();
};

(async function boot() {
  try {
    settings = await dl.invoke('getSettings');
    jobs = await dl.invoke('jobs');
    renderJobs();
    await refreshEngine();
    if (engine.installed) {
      // Quietly note when yt-dlp is old, since YouTube changes break old versions.
      dl.invoke('checkUpdate').then((u) => { if (u.outdated) $('btnUpdate').textContent = `Update to ${u.latest}`; }).catch(() => {});
    }
  } catch (e) {
    showMsg(e.message);
  }
})();
