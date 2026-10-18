'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const scraper = require('./scraper');

const DEFAULTS = { folder: '', delay: 0.5, force: false, maxParallel: 2 };

function create(ctx) {
  const dataDir = ctx.dataDir;
  const stateFile = path.join(dataDir, 'jobs.json');
  const jobs = new Map();
  const aborts = new Map();
  let settings = { ...DEFAULTS };
  let ready = null;
  let saveTimer = null;
  let pushTimer = null;

  const baseDir = () => settings.folder || path.join(ctx.baseFolder, 'Screener');

  const load = async () => {
    await fsp.mkdir(dataDir, { recursive: true });
    try {
      const raw = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
      settings = { ...DEFAULTS, ...raw.settings };
      for (const j of raw.jobs || []) {
        if (j.status === 'running' || j.status === 'queued') j.status = 'paused';
        for (const s of j.sections) for (const i of s.items) if (i.status === 'downloading') i.status = 'pending';
        jobs.set(j.id, j);
      }
    } catch { /* first run */ }
  };
  const init = () => ready || (ready = load());

  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => fsp.writeFile(stateFile, JSON.stringify({ settings, jobs: [...jobs.values()] })).catch(() => {}), 500);
  };
  const view = (j) => {
    const t = { downloaded: 0, skipped: 0, reference: 0, failed: 0, pending: 0 };
    let total = 0;
    for (const s of j.sections) for (const i of s.items) { total++; t[i.status === 'downloading' ? 'pending' : i.status]++; }
    return { ...j, totals: t, total, finished: total - t.pending };
  };
  const list = () => [...jobs.values()].sort((a, b) => b.added - a.added).map(view);
  const push = () => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => { pushTimer = null; ctx.emit('jobs', list()); }, 200);
  };
  const touch = () => { save(); push(); };

  function pump() {
    const running = [...jobs.values()].filter((j) => j.status === 'running').length;
    let free = settings.maxParallel - running;
    for (const j of [...jobs.values()].sort((a, b) => a.added - b.added)) {
      if (free <= 0) break;
      if (j.status === 'queued') { run(j); free--; }
    }
  }

  async function run(job) {
    job.status = 'running';
    job.error = '';
    const ac = new AbortController();
    aborts.set(job.id, ac);
    touch();
    try {
      for (const sec of job.sections) {
        const dir = path.join(job.dir, sec.name);
        for (const item of sec.items) {
          if (['downloaded', 'skipped', 'reference'].includes(item.status)) continue;   // finished before a pause
          if (ac.signal.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
          item.status = 'downloading';
          item.got = 0; item.total = 0; item.error = '';
          job.current = `${sec.name} / ${item.name}`;
          push();
          const r = await scraper.downloadFile({
            url: item.url, dir, baseName: item.name, force: job.force, delay: job.delay, signal: ac.signal,
            onBytes: (got, total) => { item.got = got; item.total = total; push(); },
          });
          item.status = r.result;
          item.file = r.file || '';
          item.error = r.error || '';
          touch();
        }
      }
      job.status = 'done';
      job.current = '';
      job.finishedAt = Date.now();
      const t = view(job).totals;
      ctx.notify('Screener download complete', `${job.ticker}: ${t.downloaded} downloaded, ${t.reference} links, ${t.failed} failed`);
    } catch (e) {
      if (e.cancelled) { if (job.status === 'running') job.status = 'paused'; } else { job.status = 'error'; job.error = e.message; }
      job.current = '';
    } finally {
      aborts.delete(job.id);
      touch();
      pump();
    }
  }

  const handlers = {
    // Looks the company up and reports what is on its page, plus how much is already on disk.
    async lookup(input) {
      await init();
      const ticker = scraper.parseInput(input);
      if (!ticker) throw new Error('Type a company ticker like AVANTEL, or paste its screener.in link.');
      const page = await scraper.fetchCompanyPage(ticker);
      const dir = path.join(baseDir(), ticker);
      const sections = page.sections.map((s) => ({
        name: s.name,
        items: s.items.map((i) => ({ ...i, have: !!scraper.existingFile(path.join(dir, s.name), scraper.sanitizeFilename(i.name)) })),
      }));
      return { ticker, company: page.company, pageUrl: page.url, dir, sections };
    },
    // For links that arrive without the page (a paired phone): everything on the page, using the saved defaults.
    async quickAdd(url, opts = {}) {
      const f = await handlers.lookup(url);
      const job = await handlers.start({ ticker: f.ticker, company: f.company, pageUrl: f.pageUrl, sections: f.sections, force: opts.force ?? settings.force, delay: settings.delay, source: opts.source || 'phone', base: opts.base || '', subfolder: opts.subfolder || '' });
      return { id: job.id, title: `${f.company || f.ticker} documents` };
    },
    activity() { return { active: [...jobs.values()].filter((j) => j.status === 'running' || j.status === 'queued').length }; },
    peek(id) {
      const j = jobs.get(id);
      if (!j) return null;
      const v = view(j);
      return { status: j.status, percent: v.total ? v.finished / v.total : 0, title: `${j.company || j.ticker} documents`, size: 0 };
    },
    async suggest(q) {
      q = String(q || '').trim();
      if (q.length < 2) return [];
      return scraper.search(q).catch(() => []);
    },
    async start(p) {
      await init();
      const dir = path.join(p.base || baseDir(), p.subfolder || '', p.ticker);
      const job = {
        id: crypto.randomUUID(), ticker: p.ticker, company: p.company || '', pageUrl: p.pageUrl, dir,
        source: p.source || '', force: !!p.force, delay: Number(p.delay) >= 0 ? Number(p.delay) : settings.delay,
        status: 'queued', error: '', current: '', added: Date.now(),
        sections: p.sections.map((s) => ({ name: s.name, items: s.items.map((i) => ({ name: i.name, url: i.url, status: 'pending', file: '', error: '', got: 0, total: 0 })) })),
      };
      jobs.set(job.id, job);
      touch();
      pump();
      return view(job);
    },
    async jobs() { await init(); return list(); },
    async pause(id) {
      const j = jobs.get(id);
      if (!j) return;
      if (j.status === 'queued') j.status = 'paused';
      const ac = aborts.get(id);
      if (ac) ac.abort();
      touch();
    },
    // Resume also retries failed items; finished ones are left alone.
    async resume(id) {
      const j = jobs.get(id);
      if (!j || !['paused', 'error', 'done'].includes(j.status)) return;
      for (const s of j.sections) for (const i of s.items) if (i.status === 'failed') i.status = 'pending';
      j.status = 'queued';
      touch(); pump();
    },
    async remove(id) {
      const j = jobs.get(id);
      if (!j) return;
      const ac = aborts.get(id);
      if (ac) ac.abort();
      jobs.delete(id);
      touch(); pump();
    },
    async clearDone() { for (const [id, j] of jobs) if (j.status === 'done') jobs.delete(id); touch(); },
    async reveal(id) {
      const j = jobs.get(id);
      if (!j) return;
      if (fs.existsSync(j.dir)) ctx.shell.openPath(j.dir);
    },
    async openFile(file) {
      const f = String(file || '');
      // Only files inside this downloader's own output folder.
      if (f && path.resolve(f).startsWith(path.resolve(baseDir())) && fs.existsSync(f)) return ctx.shell.openPath(f);
    },
    async getSettings() { await init(); return { ...settings, folder: baseDir() }; },
    async setSettings(patch) {
      await init();
      for (const k of ['folder', 'delay', 'force']) if (k in patch) settings[k] = patch[k];
      settings.delay = Math.max(0, Math.min(10, Number(settings.delay) || 0));
      save();
      return { ...settings, folder: baseDir() };
    },
    async openFolder() { await init(); await fsp.mkdir(baseDir(), { recursive: true }); return ctx.shell.openPath(baseDir()); },
    pickFolder: () => ctx.pickFolder(),
  };

  return {
    handlers,
    async dispose() {
      for (const ac of aborts.values()) ac.abort();
      clearTimeout(saveTimer);
      await new Promise((r) => setTimeout(r, 100));
      await fsp.mkdir(dataDir, { recursive: true });
      await fsp.writeFile(stateFile, JSON.stringify({ settings, jobs: [...jobs.values()] })).catch(() => {});
    },
  };
}

const matches = (url) => /^https?:\/\/(www\.)?screener\.in\/company\//i.test(url);

// The browser extension's toolbar icon on a screener.in company page: the small window in capture/ takes it from there.
const capture = {
  width: 560, height: 500,
  accept(url) {
    const m = /^https?:\/\/(?:www\.)?screener\.in\/company\/([^/?#]+)/i.exec(String(url || ''));
    return m ? `https://www.screener.in/company/${m[1]}/` : '';
  },
};

module.exports = { id: 'screener', dir: __dirname, matches, capture, hasFolder: true, name: 'Screener', description: 'Annual reports, credit ratings and concall documents from screener.in', create };
