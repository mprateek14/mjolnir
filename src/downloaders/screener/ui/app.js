'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let found = null;
let settings = {};
let jobs = [];
let openJobs = new Set();   // jobs whose file list is expanded, so refreshes do not collapse them

function bytes(n) {
  if (!(n > 0)) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
function showMsg(t, info) {
  const m = $('msg');
  m.textContent = t || '';
  m.className = 'msg' + (info ? ' info' : '');
  m.hidden = !t;
}

// ---- find ------------------------------------------------------------------------
async function find(input) {
  const text = (input ?? $('q').value).trim();
  if (!text) return;
  hideSuggest();
  $('btnFind').disabled = true;
  $('btnFind').textContent = 'Finding…';
  showMsg('Loading the screener.in page…', true);
  $('preview').hidden = true;
  try {
    found = await dl.invoke('lookup', text);
    showMsg('');
    renderPreview();
  } catch (e) {
    found = null;
    showMsg(e.message);
    // A name that is not a ticker: offer matches instead of a dead end.
    if (!/^https?:/i.test(text)) suggest(text, true);
  } finally {
    $('btnFind').disabled = false;
    $('btnFind').textContent = 'Find';
  }
}

function renderPreview() {
  const f = found;
  $('preview').hidden = false;
  $('pTitle').textContent = `${f.company || f.ticker}  ·  ${f.ticker}`;
  const link = $('pLink');
  link.textContent = f.pageUrl;
  link.onclick = (e) => { e.preventDefault(); };
  $('tiles').innerHTML = f.sections.map((s) => {
    const have = s.items.filter((i) => i.have).length;
    return `<div class="tile"><b>${s.items.length}</b><span>${esc(s.name)}</span><small>${have ? have + ' already saved' : 'none saved yet'}</small></div>`;
  }).join('');
  $('pItems').innerHTML = f.sections.map((s) => s.items.length
    ? `<div class="sec-name">${esc(s.name)}</div>` + s.items.map((i) => `<div class="item-row"><span>${esc(i.name)}</span><span class="hint">${i.have ? 'saved' : ''}</span></div>`).join('')
    : '').join('');
  const total = f.sections.reduce((a, s) => a + s.items.length, 0);
  $('oForce').checked = !!settings.force;
  $('oDelay').value = String(settings.delay ?? 0.5);
  $('btnStart').disabled = total === 0;
  $('btnStart').textContent = total ? `Download ${total} file${total === 1 ? '' : 's'}` : 'Nothing to download';
  $('pWhere').textContent = `Saves to ${f.dir}`;
}

// Drop what was fetched without starting anything.
$('btnCancelFind').onclick = () => {
  found = null;
  $('preview').hidden = true;
  $('q').value = '';
  showMsg('');
  $('q').focus();
};
$('btnFind').onclick = () => find();
$('q').addEventListener('keydown', (e) => {
  const rows = [...$('suggest').children];
  const cur = rows.findIndex((r) => r.classList.contains('on'));
  if (e.key === 'ArrowDown' && rows.length) { e.preventDefault(); mark(rows, (cur + 1) % rows.length); }
  else if (e.key === 'ArrowUp' && rows.length) { e.preventDefault(); mark(rows, (cur - 1 + rows.length) % rows.length); }
  else if (e.key === 'Enter') { e.preventDefault(); if (cur >= 0) rows[cur].click(); else find(); }
  else if (e.key === 'Escape') hideSuggest();
});
const mark = (rows, i) => rows.forEach((r, k) => r.classList.toggle('on', k === i));

// ---- suggestions as you type ------------------------------------------------------
let sTimer = null;
function hideSuggest() { $('suggest').hidden = true; $('suggest').innerHTML = ''; }
async function suggest(q, force) {
  if (!force && (q.length < 3 || /^https?:/i.test(q))) { hideSuggest(); return; }
  try {
    const rows = await dl.invoke('suggest', q);
    if ($('q').value.trim() !== q) return;
    if (!rows.length) { hideSuggest(); return; }
    const box = $('suggest');
    box.innerHTML = rows.slice(0, 8).map((r) => `<div data-t="${esc(r.ticker)}"><span>${esc(r.name)}</span><small>${esc(r.ticker)}</small></div>`).join('');
    box.hidden = false;
  } catch { hideSuggest(); }
}
$('q').addEventListener('input', () => { clearTimeout(sTimer); const v = $('q').value.trim(); sTimer = setTimeout(() => suggest(v), 250); });
$('suggest').onclick = (e) => {
  const row = e.target.closest('[data-t]');
  if (!row) return;
  $('q').value = row.dataset.t;
  find(row.dataset.t);
};
document.addEventListener('click', (e) => { if (!e.target.closest('.fetch')) hideSuggest(); });

// ---- start -----------------------------------------------------------------------
$('btnStart').onclick = async () => {
  if (!found) return;
  try {
    await dl.invoke('start', {
      ticker: found.ticker, company: found.company, pageUrl: found.pageUrl, sections: found.sections,
      force: $('oForce').checked, delay: Number($('oDelay').value),
    });
    $('preview').hidden = true;
    $('q').value = '';
    found = null;
  } catch (e) { showMsg(e.message); }
};

// ---- jobs ------------------------------------------------------------------------
const CHIP = { pending: 'Waiting', downloading: 'Downloading', downloaded: 'Saved', skipped: 'Already had', reference: 'Link only', failed: 'Failed' };

function statusLine(j) {
  const t = j.totals;
  const sum = `<b>${t.downloaded}</b> saved, ${t.skipped} already had, ${t.reference} link only, ${t.failed} failed`;
  if (j.status === 'running') {
    const cur = j.sections.flatMap((s) => s.items).find((i) => i.status === 'downloading');
    const prog = cur && cur.got ? `  ·  ${bytes(cur.got)}${cur.total ? ' of ' + bytes(cur.total) : ''}` : '';
    return `${esc(j.current || 'Starting')}${prog}`;
  }
  if (j.status === 'queued') return 'Waiting to start';
  if (j.status === 'error') return esc(j.error);
  return (j.status === 'paused' ? 'Paused  ·  ' : '') + sum;
}

function renderJobs() {
  $('empty').hidden = jobs.length > 0;
  $('jobList').innerHTML = jobs.map((j) => {
    const pct = j.total ? Math.round((j.finished / j.total) * 100) : 0;
    const act = [];
    if (j.status === 'running' || j.status === 'queued') act.push(`<button class="btn sm" data-a="pause" data-id="${j.id}">Pause</button>`);
    if (j.status === 'paused') act.push(`<button class="btn sm" data-a="resume" data-id="${j.id}">Resume</button>`);
    if (j.status === 'error' || (j.status === 'done' && j.totals.failed)) act.push(`<button class="btn sm" data-a="resume" data-id="${j.id}">Retry failed</button>`);
    act.push(`<button class="btn sm" data-a="reveal" data-id="${j.id}">Folder</button>`);
    act.push(`<button class="btn sm" data-a="remove" data-id="${j.id}">Remove</button>`);
    const files = j.sections.map((s) => s.items.length
      ? `<div class="sec-name">${esc(s.name)}</div>` + s.items.map((i) => `<div class="item-row"><span class="nm ${i.file ? 'open' : ''}" ${i.file ? `data-file="${esc(i.file)}"` : ''} title="${esc(i.error || i.url)}">${esc(i.name)}</span><span class="chip ${i.status}">${CHIP[i.status]}</span></div>`).join('')
      : '').join('');
    return `<div class="job ${j.status}">
      <div class="j-top"><div class="j-title">${esc(j.ticker)}<small>${esc(j.company)}${j.source === 'phone' ? '  ·  Sent from phone' : ''}</small></div><div class="j-act">${act.join('')}</div></div>
      <div class="bar"><i style="width:${j.status === 'done' ? 100 : pct}%"></i></div>
      <div class="j-stat ${j.status === 'error' ? 'err' : ''}">${statusLine(j)}${j.status === 'running' ? `  ·  ${j.finished} of ${j.total}` : ''}</div>
      <details data-id="${j.id}" ${openJobs.has(j.id) ? 'open' : ''}><summary>Files</summary>${files}</details></div>`;
  }).join('');
}

$('jobList').addEventListener('toggle', (e) => {
  const d = e.target;
  if (d.tagName === 'DETAILS' && d.dataset.id) d.open ? openJobs.add(d.dataset.id) : openJobs.delete(d.dataset.id);
}, true);
$('jobList').onclick = async (e) => {
  const nm = e.target.closest('.nm.open');
  if (nm) { dl.invoke('openFile', nm.dataset.file).catch(() => {}); return; }
  const b = e.target.closest('button');
  if (!b) return;
  try { await dl.invoke(b.dataset.a, b.dataset.id); } catch (err) { showMsg(err.message); }
};
$('btnClear').onclick = () => dl.invoke('clearDone');
dl.on('jobs', (list) => { jobs = list; renderJobs(); });

// ---- settings --------------------------------------------------------------------
const dlg = $('dlgSet');
$('btnGear').onclick = () => {
  $('sFolder').value = settings.folder || '';
  $('sDelay').value = settings.delay ?? 0.5;
  $('sForce').checked = !!settings.force;
  dlg.showModal();
};
$('sCancel').onclick = () => dlg.close();
$('sBrowse').onclick = async () => { const p = await dl.invoke('pickFolder'); if (p) $('sFolder').value = p; };
$('sSave').onclick = async () => {
  settings = await dl.invoke('setSettings', { folder: $('sFolder').value.trim(), delay: Number($('sDelay').value), force: $('sForce').checked });
  dlg.close();
  if (found) renderPreview();
};

(async function boot() {
  try {
    settings = await dl.invoke('getSettings');
    jobs = await dl.invoke('jobs');
    renderJobs();
  } catch (e) { showMsg(e.message); }
})();
