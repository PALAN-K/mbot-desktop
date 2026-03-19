const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mbot', {
  listDevices: () => ipcRenderer.invoke('device:list'),
  getDeviceInfo: (serial: string) => ipcRenderer.invoke('device:info', serial),
  setupStability: (serial: string) => ipcRenderer.invoke('device:setupStability', serial),
  restoreStability: (serial: string, originalTimeout: string) => ipcRenderer.invoke('device:restoreStability', serial, originalTimeout),
  enableWireless: (serial: string) => ipcRenderer.invoke('device:enableWireless', serial),
  pairDevice: (ip: string, port: number, code: string) => ipcRenderer.invoke('device:pair', ip, port, code),
  connectDevice: (ip: string, port: number) => ipcRenderer.invoke('device:connect', ip, port),
  startMirror: (serial: string) => ipcRenderer.invoke('device:mirror', serial),
  stopMirror: (serial: string) => ipcRenderer.invoke('device:stopMirror', serial),
  discoverDevices: () => ipcRenderer.invoke('device:discover'),
  removeMdnsCache: (name: string) => ipcRenderer.invoke('device:removeMdnsCache', name),
  inputText: (serial: string, text: string) => ipcRenderer.invoke('device:inputText', serial, text),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  installUpdate: () => ipcRenderer.invoke('app:installUpdate'),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  onUpdateAvailable: (cb: (version: string) => void) => ipcRenderer.on('update:available', (_e: any, v: string) => cb(v)),
  onUpdateProgress: (cb: (percent: number) => void) => ipcRenderer.on('update:progress', (_e: any, p: number) => cb(p)),
  onUpdateDownloaded: (cb: (version: string) => void) => ipcRenderer.on('update:downloaded', (_e: any, v: string) => cb(v)),
});
