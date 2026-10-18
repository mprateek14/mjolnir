'use strict';
// The page a phone opens. Self-contained so the PC serves one file and nothing else.
module.exports = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f1115">
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Mjolnir">
<title>Send to Mjolnir</title>
<style>
  :root { --bg:#0f1115; --surface:#151820; --raised:#1b1f2a; --line:#242936; --text:#dfe3ec; --dim:#8b93a5; --faint:#5b6376; --accent:#5b8cff; --ok:#3fb97f; --err:#e5605a; --warn:#e0a43a; color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--text); font: 16px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 18px 16px calc(24px + env(safe-area-inset-bottom)); max-width: 560px; margin: 0 auto; }
  h1 { font-size: 20px; font-weight: 600; display: flex; align-items: center; gap: 10px; }
  .logo { width: 26px; height: 26px; object-fit: contain; flex: none; }
  .sub { color: var(--dim); margin: 4px 0 16px; font-size: 14px; }
  textarea { width: 100%; min-height: 110px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; color: var(--text); padding: 12px; font: inherit; font-size: 16px; resize: vertical; outline: none; }
  textarea:focus { border-color: var(--accent); }
  button { font: inherit; border: 0; border-radius: 12px; padding: 13px 18px; background: var(--accent); color: #0a0f1d; font-weight: 600; width: 100%; margin-top: 10px; }
  button:disabled { opacity: .5; }
  .msg { margin-top: 10px; font-size: 14px; min-height: 20px; }
  .msg.err { color: var(--err); }
  .msg.ok { color: var(--ok); }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--faint); margin: 26px 0 8px; font-weight: 600; }
  .item { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 11px 12px; margin-bottom: 8px; }
  .item .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .item .s { color: var(--dim); font-size: 13px; margin-top: 2px; display: flex; justify-content: space-between; gap: 8px; }
  .bar { height: 5px; background: var(--raised); border-radius: 3px; margin-top: 8px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--accent); width: 0; transition: width .4s; }
  .item.done .bar i { background: var(--ok); }
  .item.error .bar i { background: var(--err); }
  .hint { color: var(--faint); font-size: 13px; margin-top: 14px; }
  .tip { background: var(--raised); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; font-size: 14px; color: var(--dim); margin-bottom: 12px; }
  .center { text-align: center; padding-top: 12vh; }
  a { color: var(--accent); }
</style>
</head>
<body>
<div id="app"></div>
<script>
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };
let token = store.get('sg-token');
let timer = null;

async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (token || '') }, body: body ? JSON.stringify(body) : undefined });
  let j = {};
  try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw Object.assign(new Error(j.error || 'Something went wrong'), { status: r.status });
  return j;
}

function bytes(n) { if (!n) return ''; const u = ['B','KB','MB','GB']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return (n >= 100 || !i ? Math.round(n) : n.toFixed(1)) + ' ' + u[i]; }

function shell(inner) { $('#app').innerHTML = '<h1><img class="logo" src="/icon.png" alt="">Mjolnir</h1>' + inner; }

async function pair(code) {
  shell('<p class="sub">Pairing with your PC...</p>');
  try {
    const r = await api('/api/pair', { code });
    token = r.token; store.set('sg-token', token);
    history.replaceState(null, '', '/');
    home(r.name, true);
  } catch (e) {
    shell('<p class="sub">' + esc(e.message) + '</p><p class="hint">Open Mjolnir on your PC, go to Settings, Phone link, and scan the new code.</p>');
  }
}

function home(name, fresh) {
  shell('<p class="sub">' + (fresh ? 'Paired with ' + esc(name || 'your PC') + '. ' : '') + 'Paste links here and they start downloading on your PC.</p>' +
    (fresh ? '<div class="tip">Tip: add this page to your home screen (browser menu, then Add to Home screen) so sending a link is one tap next time.</div>' : '') +
    '<textarea id="urls" placeholder="https://..." spellcheck="false" autocapitalize="off" autocorrect="off"></textarea>' +
    '<button id="send">Send to PC</button><div class="msg" id="msg"></div><div class="msg err" id="net"></div>' +
    '<h2>Sent from this phone</h2><div id="recent"><div class="hint">Nothing yet.</div></div>' +
    '<p class="hint">YouTube and screener.in links go to their own downloaders, using your default settings. Anything else goes to the main downloader.</p>');
  $('#send').onclick = send;
  refresh();
  clearInterval(timer);
  timer = setInterval(refresh, 2000);
}

async function send() {
  const urls = $('#urls').value.split(/\\s+/).map((s) => s.trim()).filter(Boolean);
  const msg = $('#msg');
  if (!urls.length) { msg.className = 'msg err'; msg.textContent = 'Paste a link first.'; return; }
  $('#send').disabled = true;
  msg.className = 'msg'; msg.textContent = 'Sending...';
  try {
    const r = await api('/api/send', { urls });
    const bad = r.results.filter((x) => !x.ok);
    const good = r.results.length - bad.length;
    msg.className = bad.length ? 'msg err' : 'msg ok';
    msg.textContent = (good ? good + ' sent. ' : '') + bad.map((b) => b.error).join(' ');
    if (good) $('#urls').value = bad.map((b) => b.url).join('\\n');
    refresh();
  } catch (e) {
    if (e.status === 401) { store.set('sg-token', ''); token = ''; start(); return; }
    msg.className = 'msg err'; msg.textContent = e.status ? e.message : unreachable();
  } finally { const b = $('#send'); if (b) b.disabled = false; }
}

function unreachable() { return 'Cannot reach your PC at ' + location.host + '. Is Mjolnir running and the phone link on? If the PC address changed, scan a new code in Mjolnir (phone icon, Pair a phone).'; }

async function refresh() {
  try {
    const r = await api('/api/recent');
    const net = $('#net'); if (net) net.textContent = '';
    if (!r.items.length) return;
    $('#recent').innerHTML = r.items.map((i) => {
      const pct = i.status === 'done' ? 100 : Math.round((i.percent || 0) * 100);
      const label = { done: 'Done', error: 'Failed', queued: 'Waiting', paused: 'Paused', running: pct + '%', gone: 'Removed on PC' }[i.status] || i.status;
      return '<div class="item ' + i.status + '"><div class="t">' + esc(i.title || i.url) + '</div><div class="s"><span>' + esc(i.where) + (i.size ? ' · ' + bytes(i.size) : '') + '</span><span>' + label + '</span></div><div class="bar"><i style="width:' + pct + '%"></i></div></div>';
    }).join('');
  } catch (e) {
    if (e.status === 401) { store.set('sg-token', ''); token = ''; start(); return; }
    const net = $('#net'); if (net) net.textContent = unreachable();
  }
}

function start() {
  clearInterval(timer);
  const code = new URLSearchParams(location.search).get('pair');
  if (code) return pair(code);
  if (!token) { shell('<p class="sub">This phone is not paired yet.</p><p class="hint">On your PC, open Mjolnir, go to Settings, Phone link, press Pair a phone, and scan the code with your camera.</p>'); return; }
  api('/api/me').then((r) => home(r.name, false), () => { store.set('sg-token', ''); token = ''; start(); });
}
start();
</script>
</body>
</html>`;
