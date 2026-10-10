// Міст між інтерфейсом конструктора та головним процесом.
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('gui', {
  choose: (opts) => call('app:choose', opts || {}),
  import: (source) => call('app:import', source),
  open: (id) => call('app:open', id),
  list: () => call('app:list'),
  current: () => call('app:current'),
  info: () => call('app:info'),

  readFile: (rel) => call('app:readFile', rel),
  writeFile: (rel, text, snapshot) => call('app:writeFile', { rel, text, snapshot }),
  originalFile: (rel) => call('app:originalFile', rel),
  createFile: (rel, text) => call('app:createFile', { rel, text }),
  history: (rel) => call('app:history', rel),
  restoreHistory: (rel, stamp) => call('app:restoreHistory', { rel, stamp }),

  getSkin: () => call('app:getSkin'),
  saveSkin: (skin) => call('app:saveSkin', skin),
  applySkin: (skin) => call('app:applySkin', skin),
  reloadSkinFromDisk: () => call('app:reloadSkinFromDisk'),

  getMocks: () => call('app:getMocks'),
  saveMocks: (mocks) => call('app:saveMocks', mocks),

  previewOpen: (surfaceId) => call('app:previewOpen', { surfaceId }),
  previewLive: (surfaceId, url) => call('app:previewLive', { surfaceId, url }),
  previewBounds: (bounds) => call('app:previewBounds', bounds),
  previewHide: () => call('app:previewHide'),
  previewReload: () => call('app:previewReload'),
  picker: (on) => call('app:picker', on),
  mode: (next) => call('app:mode', next),
  capture: () => call('app:capture'),
  eval: (code) => call('app:eval', code),

  snapshot: (label) => call('app:snapshot', label),
  snapshots: () => call('app:snapshots'),
  restoreSnapshot: (id) => call('app:restoreSnapshot', id),
  export: () => call('app:export'),
  reveal: (target) => call('app:reveal', target),
  deleteProject: (id) => call('app:deleteProject', id),

  onPicked: (fn) => ipcRenderer.on('preview:picked', (_e, info) => fn(info)),
  onGeom: (fn) => ipcRenderer.on('preview:geom', (_e, info) => fn(info)),
  onMode: (fn) => ipcRenderer.on('preview:mode', (_e, mode) => fn(mode)),
  onEvent: (fn) => ipcRenderer.on('preview:event', (_e, payload) => fn(payload)),
  onReady: (fn) => ipcRenderer.on('preview:ready', () => fn()),
});
