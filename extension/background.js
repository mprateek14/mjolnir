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

async function send(url, referrer, filename, path = '/add') {
  const { token } = await chrome.storage.local.get('token');
  if (!token) { chrome.runtime.openOptionsPage(); return fail('paste the token in the extension options'); }
  // A page link carries no cookies; the app looks the video up itself.
  const cookies = path === '/link' ? [] : await chrome.cookies.getAll({ url }).catch(() => []);
  const body = {
    url, referrer, filename,
    cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    userAgent: navigator.userAgent,
  };
  try {
    const r = await fetch(`${BRIDGE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mjolnir-token': token }, body: JSON.stringify(body) });
    if (r.status === 401) { chrome.runtime.openOptionsPage(); return fail('token is wrong, copy it again from Settings in the app'); }
    if (r.status === 422) return fail('the app has no downloader for this page');
    if (!r.ok) return fail('the app refused the link (' + r.status + ')');
    chrome.action.setBadgeText({ text: 'OK' });
    chrome.action.setBadgeBackgroundColor({ color: '#2fb26a' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
    chrome.action.setTitle({ title: 'Send video stream to Mjolnir' });
    return true;
  } catch {
    return fail('the app is not running'); // let the browser keep the download
  }
}

// The app decides whether to take downloads over and from what size; see the Browser extension dialog in the app.
// If it cannot be reached, fall back to the defaults so send() can report the real problem.
async function getConfig() {
  try {
    const { token } = await chrome.storage.local.get('token');
    const r = await fetch(`${BRIDGE}/config`, { headers: { 'x-mjolnir-token': token || '' } });
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
// Toolbar icon: on a page the app has a downloader for (a YouTube video, a screener.in company) it opens that
// downloader's window; elsewhere it sends a video stream the page loaded, if there is one. Otherwise it does nothing.
const hasDownloader = (u) => /^https:\/\/((www|m)\.)?youtube\.com\/(watch\?|shorts\/|live\/)/.test(u || '') || /^https:\/\/youtu\.be\//.test(u || '')
  || /^https?:\/\/(www\.)?screener\.in\/company\//.test(u || '');

chrome.action.onClicked.addListener(async (tab) => {
  if (hasDownloader(tab.url)) { await send(tab.url, '', '', '/link'); return; }
  const list = streams.get(tab.id) || [];
  // A master playlist (all qualities) beats a single-quality one.
  const pick = list.find((u) => /master|index|playlist|manifest/i.test(u)) || list[0];
  if (!pick) return;
  await send(pick, tab.url, '', '/stream');
});
