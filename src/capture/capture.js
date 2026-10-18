'use strict';
const $ = (id) => document.getElementById(id);
const extOf = (n) => ((n || '').match(/\.([A-Za-z0-9]{1,5})$/) || [])[1] || '';
function bytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

let job = null;
let probed = null;

async function main() {
  job = await cap.init();
  $('capType').textContent = (extOf(job.filename) || 'FILE').toUpperCase();
  $('capName').textContent = job.filename || 'Checking link…';
  $('capUrl').textContent = job.url;
  $('capFile').value = job.filename;
  $('capDir').value = job.dir;
  const r = await cap.probe(job.url, job.headers);
  if (r.error) { $('capLine').textContent = r.error; $('capLine').classList.add('bad'); return; }
  probed = r;
  $('capType').textContent = (extOf(r.filename) || 'FILE').toUpperCase();
  $('capName').textContent = r.filename;
  if (!$('capFile').value) $('capFile').value = r.filename;
  $('capLine').textContent = [r.category, r.size > 0 ? bytes(r.size) : 'size unknown'].join('  ·  ');
  const b = $('capBadge');
  b.textContent = r.resumable ? 'Resumable' : 'Not resumable';
  b.className = 'badge ' + (r.resumable ? 'ok' : 'bad');
  b.hidden = false;
}

async function submit(start) {
  const name = $('capFile').value.trim();
  const dir = $('capDir').value.trim();
  const item = { url: job.url, headers: job.headers, start, dir: dir && dir !== job.dir ? dir : undefined };
  if (name && (!probed || name !== probed.filename)) item.filename = name;
  const res = await cap.submit(item);
  if (res && res.error) { $('capLine').textContent = res.error; $('capLine').classList.add('bad'); return; }
  cap.close();
}

$('capGo').onclick = () => submit(true);
$('capLater').onclick = () => submit(false);
$('capCancel').onclick = () => cap.close();
$('capBrowse').onclick = async () => { const p = await cap.pickFolder(); if (p) $('capDir').value = p; };
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cap.close();
  if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') submit(true);
});
main();
