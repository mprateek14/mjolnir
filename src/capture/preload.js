'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (...args) => ipcRenderer.invoke(name, ...args);
contextBridge.exposeInMainWorld('cap', {
  init: call('cap:init'), probe: call('cap:probe'), pickFolder: call('cap:pickFolder'),
  submit: call('cap:submit'), close: call('cap:close'),
});
