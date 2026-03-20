import { AdbServerClient } from '@yume-chan/adb';
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp';
import { execSync, spawn, ChildProcess } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { sanitizeSerial, sanitizeIP, sanitizePort, sanitizePairingCode } from '../utils/sanitize.js';

export interface DeviceInfo {
  serial: string;
  model: string;
  product: string;
  status: string;
}

export interface StabilityResult {
  wifiSleepPolicy: boolean;
  stayAwake: boolean;
  stayOnPlugged: boolean;
  originalTimeout: string;
}

export interface MdnsDevice {
  name: string;
  service: string;
  ip: string;
  port: number;
}

export interface SavedDevice {
  ip: string;
  port: number;
  type: 'tcpip' | 'wireless-11';
  model: string;
  mdnsName?: string;
  addedAt: string;
}

export interface ReconnectResult {
  total: number;
  success: string[];
  failed: string[];
}

export class AdbManager {
  private connector: AdbServerNodeTcpConnector;
  private client: AdbServerClient;
  private mirrorProcesses: Map<string, ChildProcess> = new Map();
  private keyboardConfigured: Set<string> = new Set();
  /** mDNS 캐시: name → MdnsDevice (한번 잡히면 유지) */
  private mdnsCache: Map<string, MdnsDevice> = new Map();
  /** 영속 저장소 경로 */
  private storePath: string;

  constructor(storagePath: string, host = 'localhost', port = 5037) {
    this.connector = new AdbServerNodeTcpConnector({ host, port });
    this.client = new AdbServerClient(this.connector);
    this.storePath = path.join(storagePath, 'saved-devices.json');
    mkdirSync(storagePath, { recursive: true });
  }

  // ─── 영속 저장소 ─────────────────────────────────

  private loadStore(): Record<string, SavedDevice> {
    try {
      return JSON.parse(readFileSync(this.storePath, 'utf-8'));
    } catch {
      return {};
    }
  }

  private writeStore(store: Record<string, SavedDevice>): void {
    writeFileSync(this.storePath, JSON.stringify(store, null, 2), 'utf-8');
  }

  /** 무선 기기 정보 저장 (key = ip:port) */
  saveDevice(ip: string, port: number, type: 'tcpip' | 'wireless-11', model: string, mdnsName?: string): void {
    const store = this.loadStore();
    const key = `${ip}:${port}`;
    store[key] = { ip, port, type, model, mdnsName, addedAt: new Date().toISOString() };
    this.writeStore(store);
    console.log(`[Store] Saved device: ${key} (${type})`);
  }

  /** 저장된 기기 제거 */
  removeSavedDevice(key: string): void {
    const store = this.loadStore();
    delete store[key];
    this.writeStore(store);
    console.log(`[Store] Removed device: ${key}`);
  }

  /** 저장된 기기 목록 반환 */
  getSavedDevices(): Record<string, SavedDevice> {
    return this.loadStore();
  }

  /** 앱 시작 시 저장된 기기 자동 재연결 */
  async reconnectSavedDevices(): Promise<ReconnectResult> {
    const store = this.loadStore();
    const entries = Object.entries(store);
    const result: ReconnectResult = { total: entries.length, success: [], failed: [] };

    if (entries.length === 0) return result;
    console.log(`[Reconnect] Attempting ${entries.length} saved device(s)...`);

    // mDNS 탐색 (Android 11+ 기기의 포트가 바뀌었을 수 있음)
    const mdnsDevices = await this.discoverDevices();
    const mdnsMap = new Map(mdnsDevices.map(d => [d.name, d]));

    for (const [key, device] of entries) {
      let targetIp = device.ip;
      let targetPort = device.port;

      // Android 11+ 기기는 mDNS에서 최신 포트 조회
      if (device.type === 'wireless-11' && device.mdnsName) {
        const mdns = mdnsMap.get(device.mdnsName);
        if (mdns) {
          targetIp = mdns.ip;
          targetPort = mdns.port;
          // IP/포트가 변경됐으면 저장소 갱신
          if (mdns.ip !== device.ip || mdns.port !== device.port) {
            this.removeSavedDevice(key);
            this.saveDevice(mdns.ip, mdns.port, 'wireless-11', device.model, device.mdnsName);
            console.log(`[Reconnect] Updated ${device.mdnsName}: ${key} → ${mdns.ip}:${mdns.port}`);
          }
        }
      }

      const ok = await this.connectDevice(targetIp, targetPort);
      if (ok) {
        result.success.push(`${device.model} (${targetIp}:${targetPort})`);
      } else {
        result.failed.push(`${device.model} (${targetIp}:${targetPort})`);
      }
    }

    console.log(`[Reconnect] Done: ${result.success.length} connected, ${result.failed.length} failed`);
    return result;
  }

  /** ADB shell 명령 실행 (execSync 기반 — 안정적) */
  private adbShell(serial: string, command: string): string {
    try {
      const s = sanitizeSerial(serial);
      return execSync(`adb -s ${s} shell ${command}`, { timeout: 5000 }).toString().trim();
    } catch (e: any) {
      console.error(`[adbShell] Failed: ${command}`, e.message);
      return '';
    }
  }

  async listDevices(): Promise<DeviceInfo[]> {
    try {
      console.log('[AdbManager] Listing devices...');
      const devices = await this.client.getDevices();
      console.log('[AdbManager] Found devices:', devices.length);
      return devices.map(d => ({
        serial: d.serial,
        model: d.model ?? 'unknown',
        product: d.product ?? 'unknown',
        status: 'connected',
      }));
    } catch (error) {
      console.error('[AdbManager] ADB server error:', error);
      return [];
    }
  }

  async getDeviceInfo(serial: string): Promise<Record<string, string>> {
    try {
      console.log('[AdbManager] Getting info for:', serial);
      const model = this.adbShell(serial, 'getprop ro.product.model');
      const androidVersion = this.adbShell(serial, 'getprop ro.build.version.release');
      const sdk = this.adbShell(serial, 'getprop ro.build.version.sdk');

      return {
        serial,
        model: model || 'unknown',
        androidVersion: androidVersion || '?',
        sdk: sdk || '?',
      };
    } catch (error) {
      console.error(`[AdbManager] Failed to get info for ${serial}:`, error);
      return { serial, model: 'unknown', androidVersion: '?', sdk: '?' };
    }
  }

  /** 연결 안정성 설정 */
  async setupStability(serial: string): Promise<StabilityResult> {
    const result: StabilityResult = {
      wifiSleepPolicy: false,
      stayAwake: false,
      stayOnPlugged: false,
      originalTimeout: '60000',
    };

    // 1. 현재 screen_off_timeout 백업
    const currentTimeout = this.adbShell(serial, 'settings get system screen_off_timeout');
    if (currentTimeout && currentTimeout !== 'null') {
      result.originalTimeout = currentTimeout;
    }
    console.log(`[Stability] Original timeout: ${result.originalTimeout}ms`);

    // 2. Wi-Fi sleep policy (Android 9 이하에서만 유효, 10+는 무시됨)
    this.adbShell(serial, 'settings put global wifi_sleep_policy 2');
    const wifiPolicy = this.adbShell(serial, 'settings get global wifi_sleep_policy');
    result.wifiSleepPolicy = wifiPolicy === '2';

    // 3. 화면 타임아웃 30분
    this.adbShell(serial, 'settings put system screen_off_timeout 1800000');
    const newTimeout = this.adbShell(serial, 'settings get system screen_off_timeout');
    result.stayAwake = newTimeout === '1800000';
    console.log(`[Stability] Screen timeout: ${newTimeout}ms`);

    // 4. 충전 중 화면 유지 (1=AC, 2=USB, 3=both)
    this.adbShell(serial, 'settings put global stay_on_while_plugged_in 3');
    const stayOn = this.adbShell(serial, 'settings get global stay_on_while_plugged_in');
    result.stayOnPlugged = stayOn === '3';
    console.log(`[Stability] Stay on plugged: ${stayOn}`);

    return result;
  }

  /** 안정성 설정 원복 */
  async restoreStability(serial: string, originalTimeout: string): Promise<void> {
    this.adbShell(serial, `settings put system screen_off_timeout ${originalTimeout}`);
    this.adbShell(serial, 'settings put global stay_on_while_plugged_in 0');
    console.log('[Stability] Settings restored');
  }

  /** USB → 무선 ADB 전환 */
  async enableWirelessAdb(serial: string): Promise<{ ip: string; port: number } | null> {
    try {
      const ipOutput = this.adbShell(serial, 'ip route');
      const match = ipOutput.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
      if (!match) {
        console.error('[Wireless] Cannot find device IP');
        return null;
      }
      const ip = match[1];
      const model = this.adbShell(serial, 'getprop ro.product.model') || serial;
      execSync(`adb -s ${sanitizeSerial(serial)} tcpip 5555`, { timeout: 5000 });
      console.log(`[Wireless] Switched to tcpip. IP: ${ip}:5555`);

      // tcpip 전환 후 자동 connect (USB 분리해도 유지되도록)
      await new Promise(r => setTimeout(r, 2000));
      try {
        execSync(`adb connect ${sanitizeIP(ip)}:5555`, { timeout: 5000 });
        console.log(`[Wireless] Auto-connected to ${ip}:5555`);
      } catch {
        console.log('[Wireless] Auto-connect failed, manual connect needed');
      }

      // 영속 저장 — 다음 실행 시 자동 재연결용
      this.saveDevice(ip, 5555, 'tcpip', model);

      return { ip, port: 5555 };
    } catch (error) {
      console.error('[Wireless] Setup error:', error);
      return null;
    }
  }

  /** Android 11+ 무선 디버깅 페어링 */
  async pairDevice(ip: string, port: number, code: string): Promise<boolean> {
    try {
      const sIP = sanitizeIP(ip);
      const sPort = sanitizePort(port);
      const sCode = sanitizePairingCode(code);
      const output = execSync(`adb pair ${sIP}:${sPort} ${sCode}`, { timeout: 10000 }).toString();
      console.log('[Pair]', output);
      return output.includes('Successfully paired');
    } catch (error) {
      console.error('[Pair] Failed:', error);
      return false;
    }
  }

  /** 무선 디바이스 연결 (mdnsName 전달 시 Android 11+ 기기로 영속 저장) */
  async connectDevice(ip: string, port: number, mdnsName?: string): Promise<boolean> {
    try {
      const sIP = sanitizeIP(ip);
      const sPort = sanitizePort(port);
      const output = execSync(`adb connect ${sIP}:${sPort}`, { timeout: 10000 }).toString();
      console.log('[Connect]', output);
      const ok = output.includes('connected');

      // Android 11+ 페어링 기기 연결 성공 시 영속 저장
      if (ok && mdnsName) {
        const serial = `${ip}:${port}`;
        const model = this.adbShell(serial, 'getprop ro.product.model') || mdnsName;
        this.saveDevice(ip, port, 'wireless-11', model, mdnsName);
      }

      return ok;
    } catch (error) {
      console.error('[Connect] Failed:', error);
      return false;
    }
  }

  /** scrcpy 미러링 시작 */
  async startMirror(serial: string): Promise<boolean> {
    if (this.mirrorProcesses.has(serial)) {
      console.log('[Mirror] Already running for', serial);
      return true;
    }

    try {
      // UHID 물리 키보드 레이아웃 자동 설정 (최초 1회)
      // 한/영 전환이 되려면 폰의 물리 키보드 설정에서 레이아웃 추가 필요
      if (!this.keyboardConfigured.has(serial)) {
        try {
          const s = sanitizeSerial(serial);
          execSync(
            `adb -s ${s} shell am start -a android.settings.HARD_KEYBOARD_SETTINGS`,
            { timeout: 3000 }
          );
          this.keyboardConfigured.add(serial);
          console.log('[Mirror] Opened physical keyboard settings — add Korean + English layout');
        } catch {
          // 설정 열기 실패해도 미러링은 계속 진행
        }
      }

      const proc = spawn('scrcpy', [
        '-s', serial,
        '--window-title', `mbot 미러링 - ${serial}`,
        '--stay-awake',
        '--turn-screen-off',
        '--window-width', '400',
        '--window-height', '800',
        '--keyboard=uhid',
      ], { stdio: 'ignore', detached: false });

      proc.on('error', (err) => {
        console.error('[Mirror] Process error:', err);
        this.mirrorProcesses.delete(serial);
      });

      proc.on('exit', (code) => {
        console.log(`[Mirror] Process exited with code ${code}`);
        this.mirrorProcesses.delete(serial);
      });

      this.mirrorProcesses.set(serial, proc);
      console.log(`[Mirror] Started for ${serial}`);
      return true;
    } catch (error) {
      console.error('[Mirror] Failed to start:', error);
      return false;
    }
  }

  /** scrcpy 미러링 중지 */
  async stopMirror(serial: string): Promise<void> {
    const proc = this.mirrorProcesses.get(serial);
    if (proc) {
      proc.kill();
      this.mirrorProcesses.delete(serial);
      console.log(`[Mirror] Stopped for ${serial}`);
    }
  }

  /** 미러링 상태 확인 */
  isMirroring(serial: string): boolean {
    return this.mirrorProcesses.has(serial);
  }


  /** mDNS 결과 파싱 */
  private parseMdnsOutput(output: string): MdnsDevice[] {
    const devices: MdnsDevice[] = [];
    for (const line of output.split('\n')) {
      const match = line.match(/^(\S+)\s+(_adb[^\t\s]*)\s+(\d+\.\d+\.\d+\.\d+):(\d+)/);
      if (match) {
        devices.push({ name: match[1], service: match[2], ip: match[3], port: parseInt(match[4]) });
      }
    }
    return devices;
  }

  /** mDNS로 주변 ADB 디바이스 자동 탐색 (캐시 병합 + stale 대응) */
  async discoverDevices(): Promise<MdnsDevice[]> {
    try {
      let output = execSync('adb mdns services', { timeout: 5000 }).toString();
      let found = this.parseMdnsOutput(output);

      // mDNS stale 대응: 저장된 기기가 있는데 mDNS 결과가 비어있으면 ADB 서버 재시작
      if (found.length === 0 && this.mdnsCache.size === 0) {
        const savedCount = Object.keys(this.loadStore()).length;
        if (savedCount > 0) {
          console.log('[mDNS] Empty results with saved devices — restarting ADB server');
          try {
            execSync('adb kill-server', { timeout: 5000 });
            execSync('adb start-server', { timeout: 5000 });
            await new Promise(r => setTimeout(r, 2000));
            output = execSync('adb mdns services', { timeout: 5000 }).toString();
            found = this.parseMdnsOutput(output);
            console.log(`[mDNS] After restart: ${found.length} device(s)`);
          } catch (e: any) {
            console.error('[mDNS] Server restart failed:', e.message);
          }
        }
      }

      for (const device of found) {
        this.mdnsCache.set(device.name, device);
      }
    } catch (error) {
      console.error('[mDNS] Discovery error:', error);
    }

    const devices = Array.from(this.mdnsCache.values());
    console.log(`[mDNS] Returning ${devices.length} device(s) (cached)`);
    return devices;
  }

  /** 캐시에서 특정 기기 제거 (연결 실패 시 호출) */
  removeMdnsCache(name: string): void {
    this.mdnsCache.delete(name);
  }

  /** 무선 디바이스 연결 해제 + 저장소에서 제거 */
  async forgetDevice(serial: string): Promise<void> {
    try {
      execSync(`adb disconnect ${sanitizeSerial(serial)}`, { timeout: 5000 });
      console.log(`[Forget] Disconnected: ${serial}`);
    } catch (e: any) {
      console.error(`[Forget] Disconnect failed: ${e.message}`);
    }
    this.removeSavedDevice(serial);
  }
}
