const BRIDGE = 'http://127.0.0.1:24680';
// Files below this size are left to the browser; a download manager adds nothing there.
const MIN_BYTES = 2 * 1024 * 1024;

// Say why a hand-off failed; a silent fallback to the browser looks like the extension does nothing.
let lastReason = '';
function fail(reason) {
  lastReason = reason;
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#e5484d' });
  chrome.action.setTitle({ title: 'Mjolnir: ' + reason });
  return false;
}

// No token: the app knows a request is ours from the extension's ID, which the browser adds and a web page cannot fake.
async function send(url, referrer, filename, path = '/add') {
  // A page link carries no cookies; the app looks the video up itself.
  const cookies = path === '/link' ? [] : await chrome.cookies.getAll({ url }).catch(() => []);
  const body = {
    url, referrer, filename,
    cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    userAgent: navigator.userAgent,
  };
  try {
    const r = await fetch(`${BRIDGE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 401) return fail('Mjolnir did not accept this extension. Update Mjolnir and the extension to the latest version');
    if (r.status === 423) return fail('this downloader is turned off in the app, Settings, Downloaders');
    if (r.status === 422) return fail('the app has no downloader for this page');
    if (!r.ok) return fail('the app refused the link (' + r.status + ')');
    chrome.action.setBadgeText({ text: 'OK' });
    chrome.action.setBadgeBackgroundColor({ color: '#2fb26a' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
    chrome.action.setTitle({ title: 'Mjolnir' });
    return true;
  } catch {
    return fail('the app is not running'); // let the browser keep the download
  }
}

// The app decides whether to take downloads over and from what size; see the Browser extension dialog in the app.
// If it cannot be reached, fall back to the defaults so send() can report the real problem.
async function getConfig() {
  try {
    const r = await fetch(`${BRIDGE}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

chrome.downloads.onCreated.addListener(async (item) => {
  if (item.state !== 'in_progress' || !/^https?:/.test(item.url)) return;
  const cfg = (await getConfig()) || { enabled: true, minBytes: MIN_BYTES };
  if (!cfg.enabled) return;
  if (item.totalBytes > 0 && item.totalBytes < cfg.minBytes) return;
  const ok = await send(item.finalUrl || item.url, item.referrer, '');
  if (ok) chrome.downloads.cancel(item.id, () => chrome.downloads.erase({ id: item.id }));
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'sg-link', title: 'Download with Mjolnir', contexts: ['link', 'image', 'video', 'audio'] });
  });
});
// What was right-clicked decides where it goes:
// 1. a link to a page one of the app's downloaders handles (a YouTube video, even on a thumbnail in the feed),
// 2. the image, video or audio file itself, 3. any other link, 4. the YouTube video the page is showing.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const page = info.pageUrl || (tab && tab.url) || '';
  const web = (u) => /^https?:/i.test(u || '');
  if (web(info.linkUrl) && hasDownloader(info.linkUrl)) { send(info.linkUrl, '', '', '/link'); return; }
  if (info.mediaType && web(info.srcUrl)) { send(info.srcUrl, page, ''); return; }
  if (web(info.linkUrl)) { send(info.linkUrl, page, ''); return; }
  if (hasDownloader(page)) { send(page, '', '', '/link'); return; }
  fail('nothing to download here, the item has no web address');
});

// Video streams: remember playlists each tab requests, offer them from the toolbar button.
const streams = new Map(); // tabId -> [url]
const badge = (tabId) => {
  const n = (streams.get(tabId) || []).length;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#5b8cff' });
};
chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId < 0) return;
  const list = streams.get(d.tabId) || [];
  if (!list.includes(d.url)) list.push(d.url);
  streams.set(d.tabId, list);
  badge(d.tabId);
}, { urls: ['*://*/*.m3u8', '*://*/*.m3u8?*', '*://*/*.mpd', '*://*/*.mpd?*'] });
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.status === 'loading' && change.url !== undefined) { streams.delete(id); badge(id); }
});
chrome.tabs.onRemoved.addListener((id) => streams.delete(id));
// The toolbar popup (popup.html) asks what the current page offers and sends it to Mjolnir:
// a YouTube video or a screener.in company opens that downloader's window, otherwise a video stream the page loaded
// is sent, and if there is nothing to send, nothing happens.
const hasDownloader = (u) => /^https:\/\/((www|m)\.)?youtube\.com\/(watch\?|shorts\/|live\/)/.test(u || '') || /^https:\/\/youtu\.be\//.test(u || '')
  || /^https?:\/\/(www\.)?screener\.in\/company\//.test(u || '');

const pageKind = (u) => (/youtube\.com|youtu\.be/.test(u || '') && hasDownloader(u) ? 'youtube' : hasDownloader(u) ? 'screener' : '');

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg) return;
  if (msg.type === 'page-info') {
    reply({ kind: pageKind(msg.url), streams: (streams.get(msg.tabId) || []).length });
    return;
  }
  if (msg.type === 'download-page') {
    (async () => {
      let ok = false;
      if (hasDownloader(msg.url)) ok = await send(msg.url, '', '', '/link');
      else {
        const list = streams.get(msg.tabId) || [];
        // A master playlist (all qualities) beats a single-quality one.
        const pick = list.find((u) => /master|index|playlist|manifest/i.test(u)) || list[0];
        if (!pick) { reply({ ok: false, reason: 'Nothing to download on this page.' }); return; }
        ok = await send(pick, msg.url, '', '/stream');
      }
      reply({ ok, reason: ok ? '' : lastReason });
    })();
    return true;   // the answer comes later
  }
});
