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
  inputText: (serial: string, text: string) => ipcRenderer.invoke('device:inputText', serial, text),
});
