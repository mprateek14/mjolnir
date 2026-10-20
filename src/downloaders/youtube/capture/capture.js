'use strict';
// The small window the browser extension opens for one YouTube video. It hands the choice to the same
// module as the YouTube page (add), so jobs show up in the YouTube section and its sidebar badge.
const $ = (id) => document.getElementById(id);

let info = null;
let settings = {};
let mode = 'video';

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

// busy: show the flying hammer while we wait on something
function say(text, bad, busy) {
  $('sky').hidden = !busy;
  $('state').hidden = false;
  $('main').hidden = true;
  $('stateMsg').textContent = text;
  $('stateMsg').className = 'msg' + (bad ? ' bad' : '');
}

async function load() {
  const st = await dl.invoke('status');
  if (!st.installed) {
    say('The YouTube downloader needs its one-time setup (~18 MB).');
    $('btnInstall').hidden = false;
    return;
  }
  $('btnInstall').hidden = true;
  say('Asking YouTube for the available formats…', false, true);
  try {
    [info, settings] = await Promise.all([dl.invoke('info', dl.capUrl), dl.invoke('getSettings')]);
  } catch (e) {
    say(e.message === 'ENGINE_MISSING' ? 'Set up the YouTube downloader first.' : e.message, true);
    return;
  }
  if (info.kind !== 'video') { say('This link is not a single video.', true); return; }
  $('state').hidden = true;
  $('main').hidden = false;
  $('thumb').src = info.thumbnail || '';
  $('title').textContent = info.title;
  $('meta').textContent = [info.channel, dur(info.duration)].filter(Boolean).join('  ·  ');
  $('cont').value = settings.container || 'compat';
  $('aud').value = settings.audioFormat || 'mp3';
  $('dir').value = settings.folder || '';
  fillQualities();
  setMode(info.qualities.length ? 'video' : 'audio');
}

function fillQualities(keep) {
  const q = $('qual');
  q.innerHTML = '';
  if (!info.qualities.length) { q.add(new Option('Audio only', '0')); return; }
  const c = $('cont').value;
  const label = (x) => {
    const p = x.picks[c];
    return `${x.label}  ·  ${p.codec}${p.size ? '  ·  ~' + bytes(p.size) : ''}`;
  };
  q.add(new Option(`Best  ·  ${label(info.qualities[0])}`, '0'));
  for (const x of info.qualities) q.add(new Option(label(x), String(x.height)));
  if (keep !== undefined) q.value = keep;
}

function currentPick() {
  if (mode !== 'video' || !info.qualities.length) return null;
  const h = Number($('qual').value) || info.qualities[0].height;
  const q = info.qualities.find((x) => x.height === h) || info.qualities[0];
  return q.picks[$('cont').value];
}
function currentSize() {
  if (mode === 'audio') return info.audioSizes ? info.audioSizes.compat : info.audioSize;
  const p = currentPick();
  return p ? p.size : 0;
}
function updateSize() {
  const s = currentSize();
  $('size').textContent = s ? `~${bytes(s)}` : '';
}

function setMode(m) {
  mode = m;
  for (const b of $('modeSeg').children) b.classList.toggle('on', b.dataset.m === m);
  $('vRow').hidden = m !== 'video';
  $('aRow').hidden = m === 'video';
  updateSize();
}

$('modeSeg').onclick = (e) => { if (e.target.dataset.m) setMode(e.target.dataset.m); };
$('cont').onchange = () => { fillQualities($('qual').value); updateSize(); };
$('qual').onchange = updateSize;
$('cancel').onclick = () => window.close();
$('browse').onclick = async () => { const p = await dl.invoke('pickFolder'); if (p) $('dir').value = p; };

$('btnInstall').onclick = async () => {
  $('btnInstall').disabled = true;
  $('installBar').hidden = false;
  try { await dl.invoke('install'); } catch (e) { say(e.message, true); $('btnInstall').disabled = false; $('installBar').hidden = true; return; }
  $('installBar').hidden = true;
  load();
};
dl.on('engine', (p) => {
  if (p.progress !== undefined) {
    $('installBar').firstElementChild.style.width = `${Math.round(p.progress * 100)}%`;
    $('stateMsg').textContent = `${bytes(p.got)} of ${bytes(p.total)}`;
  }
});

$('go').onclick = async () => {
  $('go').disabled = true;
  const opts = {
    mode, playlist: false, height: Number($('qual').value) || 0, container: $('cont').value, audioFormat: $('aud').value,
    thumb: !!settings.thumb, meta: !!settings.meta, subs: false,
  };
  const pick = currentPick();
  if (pick) { opts.formatId = pick.v; opts.audioId = pick.a; }
  const dir = $('dir').value.trim();
  try {
    await dl.invoke('add', {
      url: info.url, title: info.title, channel: info.channel, thumbnail: info.thumbnail, duration: info.duration, count: 0,
      approxSize: currentSize(), audioSize: pick && info.audioSizes ? info.audioSizes[$('cont').value] : 0, opts,
      dir: dir && dir !== settings.folder ? dir : '', source: 'browser',
    });
    window.close();
  } catch (e) {
    $('go').disabled = false;
    $('size').textContent = e.message;
  }
};

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });
load();
