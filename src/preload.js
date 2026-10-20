'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (...args) => ipcRenderer.invoke(name, ...args);
const on = (ch, fn) => {
  const l = (_e, p) => fn(p);
  ipcRenderer.on(ch, l);
  return () => ipcRenderer.removeListener(ch, l);
};

contextBridge.exposeInMainWorld('sg', {
  list: call('list'), probe: call('probe'), add: call('add'),
  pause: call('pause'), resume: call('resume'), remove: call('remove'),
  pauseAll: call('pauseAll'), resumeAll: call('resumeAll'), speedLimit: call('speedLimit'),
  open: call('open'), reveal: call('reveal'), copyUrl: call('copyUrl'),
  pickFolder: call('pickFolder'), clipboard: call('clipboard'),
  dlList: call('dl:list'), dlShow: call('dl:show'), dlHide: call('dl:hide'), dlBounds: call('dl:bounds'), dlOpenFolder: call('dl:openFolder'),
  phoneInfo: call('phone:info'), phoneEnable: call('phone:enable'), phonePair: call('phone:pair'), phoneRevoke: call('phone:revoke'),
  extOpen: call('ext:open'), updateCheck: call('update:check'), updateVersion: call('update:version'), updateSkip: call('update:skip'), updateOpen: call('update:open'),
  batchRun: call('batch:run'), batchDefaults: call('batch:defaults'), batchFolderName: call('batch:folderName'),
  getSettings: call('settings:get'), setSettings: call('settings:set'),
  on,
});
