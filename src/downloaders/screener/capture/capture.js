'use strict';
// The small window the browser extension opens for a screener.in company page. It starts the same job as the
// Screener page does (start), so progress shows in the Screener section and its sidebar badge.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let found = null;
let settings = {};

// busy: show the flying hammer while we wait on something
function say(text, bad, busy) {
  $('sky').hidden = !busy;
  $('state').hidden = false;
  $('main').hidden = true;
  $('stateMsg').textContent = text;
  $('stateMsg').className = 'msg' + (bad ? ' bad' : '');
}

function where() {
  const base = $('dir').value.trim() || settings.folder;
  $('where').textContent = `Files go in ${base}\\${found.ticker}, one folder per kind of document`;
}

async function load() {
  $('sky').hidden = false;   // the page starts in its loading state
  try {
    [found, settings] = await Promise.all([dl.invoke('lookup', dl.capUrl), dl.invoke('getSettings')]);
  } catch (e) {
    say(e.message, true);
    return;
  }
  $('state').hidden = true;
  $('main').hidden = false;
  $('title').textContent = found.company || found.ticker;
  $('sub').textContent = `${found.ticker}  ·  screener.in`;
  $('tiles').innerHTML = found.sections.map((s) => {
    const have = s.items.filter((i) => i.have).length;
    return `<div class="tile"><b>${s.items.length}</b><span>${esc(s.name)}</span><small>${have ? have + ' already saved' : 'none saved yet'}</small></div>`;
  }).join('');
  const total = found.sections.reduce((a, s) => a + s.items.length, 0);
  const saved = found.sections.reduce((a, s) => a + s.items.filter((i) => i.have).length, 0);
  $('filesSum').textContent = `Files (${total})${saved ? `, ${saved} already saved` : ''}`;
  $('list').innerHTML = found.sections.map((s) => s.items.length
    ? `<div class="sec-name">${esc(s.name)}</div>` + s.items.map((i) => `<div class="row"><span title="${esc(i.name)}">${esc(i.name)}</span><span class="tag">${i.have ? 'already saved' : ''}</span></div>`).join('')
    : '').join('');
  $('dir').value = settings.folder || '';
  $('force').checked = !!settings.force;
  $('go').disabled = total === 0;
  $('go').textContent = total ? `Download ${total} file${total === 1 ? '' : 's'}` : 'Nothing to download';
  where();
}

$('dir').addEventListener('input', () => found && where());
$('browse').onclick = async () => { const p = await dl.invoke('pickFolder'); if (p) { $('dir').value = p; where(); } };
$('cancel').onclick = () => window.close();

$('go').onclick = async () => {
  $('go').disabled = true;
  const base = $('dir').value.trim();
  try {
    await dl.invoke('start', {
      ticker: found.ticker, company: found.company, pageUrl: found.pageUrl, sections: found.sections,
      force: $('force').checked, delay: settings.delay, source: 'browser',
      base: base && base !== settings.folder ? base : '',
    });
    window.close();
  } catch (e) {
    $('go').disabled = false;
    $('where').textContent = e.message;
  }
};

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });
load();
