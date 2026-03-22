import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import { AdbManager } from './adb/AdbManager.js';
import { startApiServer } from './api/server.js';
import type { AdapterManager } from './adapters/adapter-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let adbManager: AdbManager | null = null;
let adapterManager: AdapterManager | null = null;
let apiToken = '';
let apiPort = 8765;

// EPIPE 크래시 방지
process.stdout?.on('error', () => {});
process.stderr?.on('error', () => {});

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 700,
    minHeight: 500,
    title: 'mbot Desktop',
    frame: false,
    backgroundColor: '#f3f5f7',
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

  ipcMain.handle('device:installExtension', async (_event, serial: string) => {
    return adbManager!.installApiExtension(serial, apiToken, apiPort);
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

  // Window controls (frameless)
  ipcMain.handle('win:minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.handle('win:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.handle('win:close', () => {
    mainWindow?.close();
  });

  ipcMain.handle('win:isMaximized', () => {
    return mainWindow?.isMaximized() ?? false;
  });

  // Adapter management
  ipcMain.handle('adapter:list', () => {
    return adapterManager?.list() ?? [];
  });

  ipcMain.handle('adapter:registry', async () => {
    return adapterManager?.fetchRegistry() ?? [];
  });

  ipcMain.handle('adapter:install', async (_event, id: string) => {
    const result = await adapterManager?.install(id) ?? { success: false, error: 'not ready' };
    if (result.success && adapterManager) {
      adapterManager.load(id);
    }
    return result;
  });

  ipcMain.handle('adapter:start', (_event, id: string) => {
    return adapterManager?.start(id) ?? false;
  });

  ipcMain.handle('adapter:stop', (_event, id: string) => {
    return adapterManager?.stop(id) ?? false;
  });

  ipcMain.handle('adapter:uninstall', (_event, id: string) => {
    return adapterManager?.uninstall(id) ?? false;
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  await initAdb();
  await createWindow();

  // Phase 2: HTTP API 서버 시작
  const serverResult = startApiServer({ adbManager: adbManager! });
  apiToken = serverResult.token;
  apiPort = serverResult.port;
  adapterManager = serverResult.adapterManager;
  console.log(`[Main] API server on port ${apiPort}, token: ${apiToken}`);

  // Phase 3: 연결된 mbot 기기에 API extension 자동 설치
  try {
    const devices = await adbManager!.listDevices();
    for (const device of devices) {
      adbManager!.installApiExtension(device.serial, apiToken, apiPort).catch(() => {});
    }
  } catch (e) {
    console.error('[Main] Auto-install extension failed:', e);
  }

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
