const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sc', {
  platform: process.platform,
  api: (target, method, body) => ipcRenderer.invoke('sc:api', target, method, body),
  stream: track => ipcRenderer.invoke('sc:stream', track),
  session: () => ipcRenderer.invoke('sc:session'),
  login: () => ipcRenderer.invoke('sc:login'),
  logout: () => ipcRenderer.invoke('sc:logout'),
  pairPhone: () => ipcRenderer.invoke('sc:pairPhone'),
  downloads: {
    save: (track, url) => ipcRenderer.invoke('sc:downloadSave', track, url),
    list: () => ipcRenderer.invoke('sc:downloadList'),
    remove: id => ipcRenderer.invoke('sc:downloadRemove', id),
    get: id => ipcRenderer.invoke('sc:downloadGet', id),
  },
  saveFile: (name, text) => ipcRenderer.invoke('sc:saveFile', name, text),
  sync: {
    info: () => ipcRenderer.invoke('sc:syncInfo'),
    publish: snapshot => ipcRenderer.send('sync:publish', snapshot),
    onApply: callback => ipcRenderer.on('sync:apply', (_event, snapshot) => callback(snapshot)),
  },
  miniMode: on => ipcRenderer.invoke('sc:miniMode', on),
  discord: {
    get: () => ipcRenderer.invoke('sc:discordId'),
    set: id => ipcRenderer.invoke('sc:setDiscordId', id),
  },
  mpris: state => ipcRenderer.send('mpris:state', state),
  onMedia: callback => ipcRenderer.on('media', (_event, action, value) => callback(action, value)),
})
