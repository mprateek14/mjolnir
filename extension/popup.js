// The toolbar popup: sends the current page to Mjolnir. There is nothing to set up. The app knows a request comes
// from this extension because the browser adds the extension's ID to it, and a web page cannot fake that.
const BRIDGE = 'http://127.0.0.1:24680';
const $ = (id) => document.getElementById(id);
const EXPECTED_ID = 'kmkgfbkfpgliogcihlckmhojihgmppkj';   // the ID the app trusts; the manifest key gives it

let tab = null;
let page = { kind: '', streams: 0 };

// 'ok', 'denied' (the app refuses this extension, usually a version mismatch), 'offline' (not running)
async function connection() {
  try {
    // A POST, because the browser always stamps a POST with this extension's ID, which is what the app checks.
    const r = await fetch(`${BRIDGE}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (r.status === 401) return 'denied';
    if (!r.ok) return 'offline';
    const j = await r.json();
    return j && j.app === 'mjolnir' ? 'ok' : 'offline';   // whatever else may answer on that port is not Mjolnir
  } catch { return 'offline'; }
}

function setState(kind, text) {
  $('state').hidden = !text;
  $('dot').className = 'dot ' + kind;
  $('stateText').textContent = text;
}

function say(text, kind) { $('goMsg').textContent = text || ''; $('goMsg').className = 'msg ' + (kind || ''); }

// What this page offers: a YouTube video, a screener.in company, or a video stream the page loaded.
function describe() {
  if (page.kind === 'youtube') return 'YouTube video found.';
  if (page.kind === 'screener') return 'screener.in company page found.';
  if (page.streams) return `Video stream found (${page.streams}).`;
  return '';
}

async function show() {
  const c = await connection();
  setState(c === 'ok' ? 'ok' : 'bad', c === 'ok' ? 'Connected' : c === 'denied' ? 'Not accepted' : 'Mjolnir is not running');
  const what = describe();
  const wrongId = chrome.runtime.id !== EXPECTED_ID;
  $('go').disabled = !(c === 'ok' && what);
  $('goHint').textContent = c === 'offline' ? 'Start Mjolnir, then open this panel again.'
    : c === 'denied' && wrongId ? 'This copy of the extension has a different ID. Remove it and load the extension folder from the latest release.'
    : c === 'denied' ? 'This extension and Mjolnir are different versions. Update both to the latest release.'
    : what || 'Nothing to download on this page. It works on YouTube videos, screener.in company pages and pages with a video stream.';
}

$('go').onclick = async () => {
  $('go').disabled = true;
  say('Sending…');
  const res = await chrome.runtime.sendMessage({ type: 'download-page', tabId: tab.id, url: tab.url });
  if (res && res.ok) {
    say('Sent to Mjolnir.', 'ok');
    setTimeout(() => window.close(), 700);
  } else {
    say((res && res.reason) || 'Could not send it.', 'bad');
    $('go').disabled = false;
  }
};

(async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) page = (await chrome.runtime.sendMessage({ type: 'page-info', tabId: tab.id, url: tab.url })) || page;
  await show();
})();
