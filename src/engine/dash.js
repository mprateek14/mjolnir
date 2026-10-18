'use strict';
const { XMLParser } = require('fast-xml-parser');

const ARRAYS = new Set(['Period', 'AdaptationSet', 'Representation', 'S', 'SegmentURL', 'BaseURL', 'ContentProtection']);
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ARRAYS.has(name),
  parseAttributeValue: false,
});

const isDashUrl = (u) => /\.mpd(\?|#|$)/i.test(u);
const isDashMime = (m) => /dash\+xml/i.test(m || '');

function isoDuration(s) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s || '');
  if (!m) return 0;
  return (Number(m[1]) || 0) * 86400 + (Number(m[2]) || 0) * 3600 + (Number(m[3]) || 0) * 60 + (Number(m[4]) || 0);
}

// Fills $RepresentationID$, $Number$, $Bandwidth$, $Time$ including printf-style widths like $Number%05d$.
function fill(tpl, vars) {
  return tpl.replace(/\$(RepresentationID|Number|Bandwidth|Time)(?:%0(\d+)d)?\$/g, (_, k, w) => {
    const v = String(vars[k]);
    return w ? v.padStart(Number(w), '0') : v;
  }).replace(/\$\$/g, '$');
}

const first = (...xs) => xs.find((x) => x !== undefined);
const baseOf = (node, parent) => {
  const b = node.BaseURL && node.BaseURL[0];
  const text = b && (typeof b === 'string' ? b : b['#text']);
  return text ? new URL(text.trim(), parent).href : parent;
};

function range(str) {
  if (!str) return null;
  const [a, b] = str.split('-').map(Number);
  return { start: a, end: b };
}

function buildSegments(rep, ctx) {
  const { base, periodDuration } = ctx;
  const tpl = rep.SegmentTemplate || ctx.set.SegmentTemplate || ctx.period.SegmentTemplate;
  const list = rep.SegmentList || ctx.set.SegmentList;
  const vars = { RepresentationID: rep['@_id'], Bandwidth: rep['@_bandwidth'] || 0 };
  const abs = (u) => new URL(u, base).href;

  if (tpl) {
    const timescale = Number(tpl['@_timescale']) || 1;
    const startNumber = tpl['@_startNumber'] !== undefined ? Number(tpl['@_startNumber']) : 1;
    const init = tpl['@_initialization'] ? abs(fill(tpl['@_initialization'], vars)) : '';
    const media = tpl['@_media'];
    const segs = [];
    const tl = tpl.SegmentTimeline && tpl.SegmentTimeline.S;
    if (tl) {
      let t = 0;
      let n = startNumber;
      for (const s of tl) {
        if (s['@_t'] !== undefined) t = Number(s['@_t']);
        const d = Number(s['@_d']);
        let r = Number(s['@_r']) || 0;
        if (r < 0) r = Math.max(0, Math.ceil(((periodDuration * timescale) - t) / d) - 1);
        for (let i = 0; i <= r; i++) {
          segs.push({ url: abs(fill(media, { ...vars, Number: n, Time: t })), duration: d / timescale });
          t += d;
          n++;
        }
      }
    } else {
      const d = Number(tpl['@_duration']);
      if (!d || !periodDuration) throw new Error('Cannot work out the chunk count for this stream');
      const count = Math.ceil(periodDuration / (d / timescale));
      for (let i = 0; i < count; i++) segs.push({ url: abs(fill(media, { ...vars, Number: startNumber + i, Time: i * d })), duration: d / timescale });
    }
    return { init: init ? { url: init, range: null } : null, segs };
  }

  if (list) {
    const i = list.Initialization;
    const init = i ? { url: abs(i['@_sourceURL'] || base), range: range(i['@_range']) } : null;
    const segs = (list.SegmentURL || []).map((s) => ({
      url: abs(s['@_media'] || base), range: range(s['@_mediaRange']), duration: 0,
    }));
    return { init, segs };
  }

  // SegmentBase or a bare BaseURL: the whole representation is one file, indexed by byte range.
  return { init: null, segs: [{ url: base, duration: periodDuration }] };
}

function parseMpd(text, mpdUrl) {
  const doc = parser.parse(text);
  const mpd = doc.MPD;
  if (!mpd) throw new Error('Not a DASH manifest');
  const live = mpd['@_type'] === 'dynamic';
  const periods = mpd.Period || [];
  if (!periods.length) throw new Error('Manifest has no periods');
  if (periods.length > 1) throw new Error('Manifests with several periods (for example ad breaks) are not supported yet');
  const period = periods[0];
  const duration = isoDuration(period['@_duration'] || mpd['@_mediaPresentationDuration']);
  const mpdBase = baseOf(mpd, mpdUrl);
  const pBase = baseOf(period, mpdBase);
  const reps = [];
  let drm = false;

  for (const set of period.AdaptationSet || []) {
    const setBase = baseOf(set, pBase);
    const setProtected = (set.ContentProtection || []).length > 0;
    for (const rep of set.Representation || []) {
      const mime = first(rep['@_mimeType'], set['@_mimeType'], '');
      const codecs = first(rep['@_codecs'], set['@_codecs'], '');
      let type = first(set['@_contentType'], mime.split('/')[0], '');
      if (!type && /avc|hev|hvc|vp0?9|av01/.test(codecs)) type = 'video';
      if (!type && /mp4a|opus|ec-3|ac-3/.test(codecs)) type = 'audio';
      const isProtected = setProtected || (rep.ContentProtection || []).length > 0;
      if (isProtected) drm = true;
      const ctx = { base: baseOf(rep, setBase), periodDuration: duration, set, period };
      let fps = first(rep['@_frameRate'], set['@_frameRate'], '');
      if (/\//.test(fps)) { const [a, b] = fps.split('/').map(Number); fps = b ? Math.round((a / b) * 100) / 100 : a; }
      reps.push({
        id: rep['@_id'], type, mime, codecs, bandwidth: Number(rep['@_bandwidth']) || 0,
        width: Number(first(rep['@_width'], set['@_width'], 0)), height: Number(first(rep['@_height'], set['@_height'], 0)),
        fps: Number(fps) || 0, lang: set['@_lang'] || '', protected: isProtected,
        muxed: type === 'video' && codecs.includes(','),
        segments: () => buildSegments(rep, ctx),
      });
    }
  }
  return { live, duration, reps, drm };
}

const family = (c) => (/av01/.test(c) ? 'AV1' : /vp0?9/.test(c) ? 'VP9' : /hev|hvc/.test(c) ? 'H.265' : /avc/.test(c) ? 'H.264' : '');

// One entry per video quality, each paired with the best audio track. All qualities in the manifest are listed.
function variantsOf(mpd) {
  const audio = mpd.reps.filter((r) => r.type === 'audio').sort((a, b) => b.bandwidth - a.bandwidth)[0];
  const videos = mpd.reps.filter((r) => r.type === 'video').sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  const mbps = (b) => (b ? `${(b / 1e6).toFixed(1)} Mbps` : '');
  const list = videos.map((v) => ({
    label: [v.height ? `${v.height}p${v.fps > 30 ? Math.round(v.fps) : ''}` : 'Video', family(v.codecs), mbps(v.bandwidth)].filter(Boolean).join('  ·  '),
    add: { videoId: v.id, audioId: v.muxed || !audio ? '' : audio.id },
    webm: /webm/.test(v.mime),
    height: v.height,
  }));
  if (!list.length && audio) list.push({ label: `Audio only  ·  ${mbps(audio.bandwidth)}`, add: { videoId: '', audioId: audio.id }, webm: /webm/.test(audio.mime), height: 0 });
  return list;
}

module.exports = { parseMpd, variantsOf, isDashUrl, isDashMime, isoDuration, fill };
