'use strict';
const { HlsDownload } = require('./hlsdownload');
const { fetchText } = require('./hls');
const { parseMpd } = require('./dash');

// A DASH stream is chunk-based like HLS, so it reuses that downloader and only changes how the chunk lists are built.
class DashDownload extends HlsDownload {
  constructor(init, deps) {
    super({ type: 'dash', videoId: '', audioId: '', ...init }, deps);
    this.fragmented = true;
  }

  toJSON() {
    return { ...super.toJSON(), videoId: this.videoId, audioId: this.audioId };
  }

  async loadTracks(signal) {
    const { text, url } = await fetchText(this.url, this.headers, signal);
    const mpd = parseMpd(text, url);
    if (mpd.live) throw Object.assign(new Error('Live streams are not supported yet'), { fatal: true });
    const tracks = [];
    for (const id of [this.videoId, this.audioId].filter(Boolean)) {
      const rep = mpd.reps.find((r) => r.id === id);
      if (!rep) throw Object.assign(new Error(`Quality ${id} is no longer in the manifest`), { fatal: true });
      if (rep.protected) throw Object.assign(new Error('This stream is DRM protected and cannot be downloaded'), { fatal: true });
      const { init, segs } = rep.segments();
      if (!segs.length) throw new Error('Stream has no chunks');
      tracks.push({
        keys: [{ method: 'NONE' }], live: false,
        segments: segs.map((s, i) => ({ url: s.url, range: s.range || null, duration: s.duration, key: 0, seq: i, map: i === 0 ? init : null })),
      });
    }
    if (!tracks.length) throw new Error('Nothing selected to download');
    return tracks;
  }
}

module.exports = { DashDownload };
