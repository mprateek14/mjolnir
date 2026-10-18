'use strict';
// Shared by every downloader page. A page only ever talks to its own module.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const id = (process.argv.find((a) => a.startsWith('--dl-id=')) || '').slice(8);
// Set for the small pop-up windows the browser extension opens (see host.openCapture).
const capUrl = decodeURIComponent((process.argv.find((a) => a.startsWith('--cap-url=')) || '').slice(10));

contextBridge.exposeInMainWorld('dl', {
  id, capUrl,
  // Where a dragged-in file lives on disk (a page cannot read that from the File object itself).
  pathOf: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  invoke: async (name, ...args) => {
    const r = await ipcRenderer.invoke('dl:call', id, name, args);
    if (r && r.__error) throw new Error(r.__error);
    return r;
  },
  on: (channel, fn) => {
    const l = (_e, ch, payload) => { if (ch === channel) fn(payload); };
    ipcRenderer.on('dl:event', l);
    return () => ipcRenderer.removeListener('dl:event', l);
  },
});
