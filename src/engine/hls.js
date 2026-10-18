'use strict';
const { request } = require('./http');

const resolve = (ref, base) => new URL(ref, base).href;

function attrs(line) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

function parseByteRange(v, prevEnd) {
  const [len, off] = v.split('@');
  const start = off !== undefined ? Number(off) : prevEnd;
  return { start, end: start + Number(len) - 1 };
}

// Returns { master: true, variants } for a master playlist, or { master: false, segments, ... } for a media playlist.
function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines[0] || !lines[0].startsWith('#EXTM3U')) throw new Error('Not an HLS playlist');

  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const media = lines.filter((l) => l.startsWith('#EXT-X-MEDIA:')).map((l) => attrs(l.slice(13)));
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        const a = attrs(l.slice(18));
        const uri = lines.slice(i + 1).find((x) => !x.startsWith('#'));
        if (!uri) continue;
        const audioGroup = media.find((m) => m.TYPE === 'AUDIO' && m['GROUP-ID'] === a.AUDIO && m.URI);
        variants.push({
          url: resolve(uri, baseUrl),
          bandwidth: Number(a.BANDWIDTH) || 0,
          resolution: a.RESOLUTION || '',
          codecs: a.CODECS || '',
          audio: audioGroup ? resolve(audioGroup.URI, baseUrl) : '',
        });
      }
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return { master: true, variants };
  }

  const segments = [];
  const keys = [{ method: 'NONE' }];
  let key = 0;
  let map = null;
  let mediaSeq = 0;
  let dur = 0;
  let range = null;
  let ended = false;
  let lastEnd = 0;
  let lastUri = '';
  let targetDuration = 0;
  let discont = 0;
  for (const l of lines) {
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mediaSeq = Number(l.split(':')[1]) || 0;
    else if (l.startsWith('#EXT-X-TARGETDURATION:')) targetDuration = Number(l.split(':')[1]) || 0;
    else if (l.startsWith('#EXT-X-ENDLIST')) ended = true;
    else if (l.startsWith('#EXT-X-DISCONTINUITY')) discont++;
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = attrs(l.slice(11));
      keys.push({ method: a.METHOD, uri: a.URI ? resolve(a.URI, baseUrl) : '', iv: a.IV || '' });
      key = keys.length - 1;
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = attrs(l.slice(11));
      map = { url: resolve(a.URI, baseUrl), range: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
    } else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8)) || 0;
    else if (l.startsWith('#EXT-X-BYTERANGE:')) range = l.slice(17);
    else if (!l.startsWith('#')) {
      const url = resolve(l, baseUrl);
      let br = null;
      if (range) {
        br = parseByteRange(range, url === lastUri ? lastEnd + 1 : 0);
        lastEnd = br.end;
      }
      lastUri = url;
      segments.push({ url, duration: dur, range: br, key, seq: mediaSeq + segments.length, map: map ? { ...map } : null, discont });
      range = null;
      dur = 0;
    }
  }
  return { master: false, segments, keys, live: !ended, targetDuration, duration: segments.reduce((a, s) => a + s.duration, 0) };
}

async function fetchText(url, headers = {}, signal) {
  const { res, url: finalUrl } = await request(url, { headers, signal });
  if (res.statusCode >= 400) {
    res.resume();
    throw Object.assign(new Error(`Server replied ${res.statusCode}`), { status: res.statusCode, fatal: [401, 403, 404, 410].includes(res.statusCode) });
  }
  let size = 0;
  const chunks = [];
  for await (const c of res) {
    size += c.length;
    if (size > 8e6) { res.destroy(); throw new Error('Playlist is too large'); }
    chunks.push(c);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), url: finalUrl, mime: res.headers['content-type'] || '' };
}

const isHlsUrl = (u) => /\.m3u8(\?|#|$)/i.test(u);
const isHlsMime = (m) => /mpegurl/i.test(m || '');

function label(v) {
  const h = v.resolution ? `${v.resolution.split('x')[1]}p` : '';
  const mbps = v.bandwidth ? `${(v.bandwidth / 1e6).toFixed(1)} Mbps` : '';
  return [h, mbps].filter(Boolean).join('  ·  ') || 'Stream';
}

module.exports = { parsePlaylist, fetchText, isHlsUrl, isHlsMime, label };
