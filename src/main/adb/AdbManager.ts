import { AdbServerClient } from '@yume-chan/adb';
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp';
import { execSync, spawn, ChildProcess } from 'child_process';
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

export class AdbManager {
  private connector: AdbServerNodeTcpConnector;
  private client: AdbServerClient;
  private mirrorProcesses: Map<string, ChildProcess> = new Map();
  private keyboardConfigured: Set<string> = new Set();
  /** mDNS 캐시: name → MdnsDevice (한번 잡히면 유지) */
  private mdnsCache: Map<string, MdnsDevice> = new Map();

  constructor(host = 'localhost', port = 5037) {
    this.connector = new AdbServerNodeTcpConnector({ host, port });
    this.client = new AdbServerClient(this.connector);
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

  /** 무선 디바이스 연결 */
  async connectDevice(ip: string, port: number): Promise<boolean> {
    try {
      const sIP = sanitizeIP(ip);
      const sPort = sanitizePort(port);
      const output = execSync(`adb connect ${sIP}:${sPort}`, { timeout: 10000 }).toString();
      console.log('[Connect]', output);
      return output.includes('connected');
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


  /** mDNS로 주변 ADB 디바이스 자동 탐색 (캐시 병합) */
  async discoverDevices(): Promise<MdnsDevice[]> {
    try {
      const output = execSync('adb mdns services', { timeout: 5000 }).toString();
      const lines = output.split('\n');

      for (const line of lines) {
        // 형식: adb-SERIAL	_adb._tcp	IP:PORT
        // 또는: adb-SERIAL	_adb-tls-connect._tcp	IP:PORT
        const match = line.match(/^(\S+)\s+(_adb[^\t\s]*)\s+(\d+\.\d+\.\d+\.\d+):(\d+)/);
        if (match) {
          const device: MdnsDevice = {
            name: match[1],
            service: match[2],
            ip: match[3],
            port: parseInt(match[4]),
          };
          // 캐시에 저장/갱신 (IP가 바뀔 수 있으므로 항상 최신으로)
          this.mdnsCache.set(device.name, device);
        }
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

  /** 발견된 디바이스에 자동 연결 시도 */
  async autoConnect(ip: string, port: number): Promise<boolean> {
    return this.connectDevice(ip, port);
  }
}
