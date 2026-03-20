import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import { AdbManager } from './adb/AdbManager.js';
import { startApiServer } from './api/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let adbManager: AdbManager | null = null;

// EPIPE 크래시 방지
process.stdout?.on('error', () => {});
process.stderr?.on('error', () => {});

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 600,
    minHeight: 500,
    title: 'mbot Desktop',
    backgroundColor: '#111827',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

async function initAdb() {
  const storagePath = path.join(app.getPath('userData'), 'adb-store');
  adbManager = new AdbManager(storagePath);

  ipcMain.handle('device:list', async () => {
    return adbManager!.listDevices();
  });

  ipcMain.handle('device:info', async (_event, serial: string) => {
    return adbManager!.getDeviceInfo(serial);
  });

  ipcMain.handle('device:setupStability', async (_event, serial: string) => {
    return adbManager!.setupStability(serial);
  });

  ipcMain.handle('device:restoreStability', async (_event, serial: string, originalTimeout: string) => {
    return adbManager!.restoreStability(serial, originalTimeout);
  });

  ipcMain.handle('device:enableWireless', async (_event, serial: string) => {
    return adbManager!.enableWirelessAdb(serial);
  });

  ipcMain.handle('device:pair', async (_event, ip: string, port: number, code: string) => {
    return adbManager!.pairDevice(ip, port, code);
  });

  ipcMain.handle('device:connect', async (_event, ip: string, port: number, mdnsName?: string) => {
    return adbManager!.connectDevice(ip, port, mdnsName);
  });

  ipcMain.handle('device:mirror', async (_event, serial: string) => {
    return adbManager!.startMirror(serial);
  });

  ipcMain.handle('device:stopMirror', async (_event, serial: string) => {
    return adbManager!.stopMirror(serial);
  });

  ipcMain.handle('device:discover', async () => {
    return adbManager!.discoverDevices();
  });

  ipcMain.handle('device:removeMdnsCache', async (_event, name: string) => {
    adbManager!.removeMdnsCache(name);
  });

  ipcMain.handle('device:savedDevices', async () => {
    return adbManager!.getSavedDevices();
  });

  ipcMain.handle('device:removeSaved', async (_event, key: string) => {
    adbManager!.removeSavedDevice(key);
  });

  ipcMain.handle('device:forget', async (_event, serial: string) => {
    return adbManager!.forgetDevice(serial);
  });

  ipcMain.handle('device:reconnect', async () => {
    return adbManager!.reconnectSavedDevices();
  });

  ipcMain.handle('app:openExternal', async (_event, url: string) => {
    await shell.openExternal(url);
  });

  ipcMain.handle('app:installUpdate', () => {
    autoUpdater.quitAndInstall();
  });

  ipcMain.handle('app:getVersion', () => {
    return app.getVersion();
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  await initAdb();
  await createWindow();

  // Phase 2: HTTP API 서버 시작
  const { token, port } = startApiServer({ adbManager: adbManager! });
  console.log(`[Main] API server on port ${port}, token: ${token}`);

  // 자동 업데이트
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('update:available', info.version);
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('update:progress', Math.round(progress.percent));
  });

  autoUpdater.on('update-downloaded', (info) => {
    mainWindow?.webContents.send('update:downloaded', info.version);
  });

  autoUpdater.on('error', (err) => {
    console.error('[AutoUpdate] Error:', err.message);
    mainWindow?.webContents.send('update:error', err.message);
  });

  autoUpdater.checkForUpdates().catch(() => {});
});

app.on('window-all-closed', () => {
  app.quit();
});
