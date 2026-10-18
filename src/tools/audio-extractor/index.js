'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const ff = require('../ffmpeg');

const DEFAULTS = { outputMode: 'beside', folder: '' };
const MAX_PARALLEL = 2;

function create(ctx) {
  const jobs = new Map();
  const aborts = new Map();
  let settings = { ...DEFAULTS };
  let pushTimer = null;

  const push = () => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => { pushTimer = null; ctx.emit('jobs', list()); }, 200);
  };
  const list = () => [...jobs.values()].sort((a, b) => b.added - a.added);

  function pump() {
    let free = MAX_PARALLEL - [...jobs.values()].filter((j) => j.status === 'running').length;
    for (const j of [...jobs.values()].sort((a, b) => a.added - b.added)) {
      if (free <= 0) break;
      if (j.status === 'queued') { run(j); free--; }
    }
  }

  // Copy one track into its own file. Writes to a .part file first so a cancelled run leaves nothing half-made.
  async function copyTrack(job, t, base, ext, format, onP, signal) {
    const final = ff.uniquePath(job.outDir, base, ext);
    const part = final + '.part';
    try {
      await ff.copyStream(ctx.ffmpeg, { input: job.file, streamIndex: t.index, output: part, format, duration: job.duration }, onP, signal);
      await fsp.rename(part, final);
      return final;
    } catch (e) {
      await fsp.rm(part, { force: true }).catch(() => {});
      throw e;
    }
  }

  async function run(job) {
    job.status = 'running';
    job.error = '';
    const ac = new AbortController();
    aborts.set(job.id, ac);
    push();
    try {
      await fsp.mkdir(job.outDir, { recursive: true });
      const stem = ff.clean(path.basename(job.file, path.extname(job.file))) || 'audio';
      for (let i = 0; i < job.tracks.length; i++) {
        const t = job.tracks[i];
        const base = job.tracks.length === 1 ? stem : `${stem} - audio ${t.n + 1}${t.lang ? ` (${t.lang})` : ''}`;
        const onP = (p) => { job.percent = (i + p) / job.tracks.length; push(); };
        let [ext, format] = ff.containerFor(t.codec);
        let file;
        try {
          file = await copyTrack(job, t, base, ext, format, onP, ac.signal);
        } catch (e) {
          if (e.cancelled || ext === '.mka') throw e;
          // That codec will not go into its usual container as-is. Matroska audio takes anything, still without re-encoding.
          [ext, format] = ['.mka', 'matroska'];
          file = await copyTrack(job, t, base, ext, format, onP, ac.signal);
          job.notes.push(`Track ${t.n + 1} was saved as .mka because ${t.codecLabel} does not fit its usual file type unchanged.`);
        }
        // Prove it: the saved file must hold the same codec as the source.
        const out = await ff.probe(ctx.ffprobe, file);
        const same = out.audio.length === 1 && out.audio[0].codec === t.codec;
        if (!same) throw new Error(`Saved file holds a different codec than the original (${out.audio[0] ? out.audio[0].codec : 'none'} instead of ${t.codec}).`);
        job.outputs.push({ file, codec: t.codecLabel, size: (await fsp.stat(file)).size });
        job.percent = (i + 1) / job.tracks.length;
      }
      job.status = 'done';
      job.finishedAt = Date.now();
      ctx.notify('Audio extracted', `${path.basename(job.file)}: ${job.outputs.length} file${job.outputs.length === 1 ? '' : 's'}`);
    } catch (e) {
      job.status = e.cancelled ? 'cancelled' : 'error';
      job.error = e.cancelled ? '' : e.message;
      // Remove what this run already wrote so a failure never leaves a pile of partial results.
      if (e.cancelled) for (const o of job.outputs) await fsp.rm(o.file, { force: true }).catch(() => {});
      if (e.cancelled) job.outputs = [];
    } finally {
      aborts.delete(job.id);
      push();
      pump();
    }
  }

  const handlers = {
    async pickFiles() {
      return ctx.pickFiles({ filters: [{ name: 'Video and audio files', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'm4v', 'ts', 'm2ts', 'mpg', 'mpeg', '3gp', 'ogv', 'mka', 'm4a'] }, { name: 'All files', extensions: ['*'] }] });
    },

    // Reads each file and lists its audio tracks. Nothing is written.
    async inspect(paths) {
      const out = [];
      for (const file of [].concat(paths || [])) {
        const row = { file, name: path.basename(file) };
        try {
          const st = await fsp.stat(file);
          if (!st.isFile()) throw new Error('That is a folder, not a file.');
          Object.assign(row, await ff.probe(ctx.ffprobe, file));
          if (!row.audio.length) row.error = 'This file has no audio track.';
        } catch (e) {
          row.error = e.code === 'ENOENT' ? 'File not found.' : /Invalid data|moov atom|could not find|No such/i.test(e.stderr || e.message) ? 'This does not look like a media file.' : e.message;
        }
        out.push(row);
      }
      return out;
    },

    // items: [{ file, tracks: [track numbers] }]. One job per file.
    async extract({ items }) {
      if (!items || !items.length) throw new Error('Choose a file first.');
      const made = [];
      for (const it of items) {
        const info = await ff.probe(ctx.ffprobe, it.file);
        const picked = info.audio.filter((a) => (it.tracks || []).includes(a.n));
        if (!picked.length) throw new Error(`Pick at least one audio track for ${path.basename(it.file)}.`);
        const outDir = settings.outputMode === 'folder' && settings.folder ? settings.folder : path.dirname(it.file);
        const job = {
          id: crypto.randomUUID(), file: it.file, name: path.basename(it.file), duration: info.duration, outDir,
          tracks: picked, status: 'queued', percent: 0, error: '', outputs: [], notes: [], added: Date.now() + made.length,
        };
        jobs.set(job.id, job);
        made.push(job.id);
      }
      push();
      pump();
      return made;
    },

    async jobs() { return list(); },
    async cancel(id) { const ac = aborts.get(id); if (ac) ac.abort(); },
    async remove(id) {
      const ac = aborts.get(id);
      if (ac) ac.abort();
      jobs.delete(id);
      push();
    },
    async clearDone() { for (const [id, j] of jobs) if (['done', 'error', 'cancelled'].includes(j.status)) jobs.delete(id); push(); },
    async reveal(id) {
      const j = jobs.get(id);
      const f = j && (j.outputs[0] ? j.outputs[0].file : j.file);
      if (f && fs.existsSync(f)) ctx.shell.showItemInFolder(f);
    },
    async open(file) {
      for (const j of jobs.values()) if (j.outputs.some((o) => o.file === file) && fs.existsSync(file)) return ctx.shell.openPath(file);
    },
    activity() { return { active: [...jobs.values()].filter((j) => j.status === 'running' || j.status === 'queued').length }; },
    async getSettings() { return { ...settings }; },
    async setSettings(p) {
      if (p.outputMode === 'beside' || p.outputMode === 'folder') settings.outputMode = p.outputMode;
      if (typeof p.folder === 'string') settings.folder = p.folder;
      return { ...settings };
    },
    pickFolder: () => ctx.pickFolder(),
  };

  return {
    handlers,
    async dispose() { for (const ac of aborts.values()) ac.abort(); },
  };
}

module.exports = { id: 'audio-extractor', kind: 'tool', dir: __dirname, name: 'Audio extractor', description: 'Copy the audio out of a video without re-encoding it', create };
