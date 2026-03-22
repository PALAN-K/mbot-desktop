import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { runInThisContext } from 'vm';
import type { Express } from 'express';

const REGISTRY_URL = 'https://palank.co.kr/adapters/registry.json';
const ADAPTER_BASE_URL = 'https://palank.co.kr/adapters';

export interface AdapterManifest {
  id: string;
  name: string;
  version: string;
  icon: string;
  description: string;
  author: string;
  package: string;
  appVersion?: string;
  decompiled?: string;
  screens: Record<string, any>;
  apis: Array<{
    method: string;
    path: string;
    description: string;
    params: Record<string, string>;
  }>;
}

export interface RegistryEntry {
  id: string;
  name: string;
  version: string;
  icon: string;
  description: string;
  author: string;
  category: string;
  featured?: boolean;
  comingSoon?: boolean;
}

export interface AdapterInfo {
  id: string;
  name: string;
  icon: string;
  version: string;
  description: string;
  author: string;
  status: 'running' | 'stopped';
  package: string;
}

interface LoadedAdapter {
  manifest: AdapterManifest;
  status: 'running' | 'stopped';
}

export class AdapterManager {
  private adaptersDir: string;
  private loaded: Map<string, LoadedAdapter> = new Map();
  private helpers: Record<string, Function>;
  private expressApp: Express | null = null;

  constructor(userDataPath: string, helpers: Record<string, Function>) {
    this.adaptersDir = path.join(userDataPath, 'adapters');
    this.helpers = helpers;

    if (!existsSync(this.adaptersDir)) {
      mkdirSync(this.adaptersDir, { recursive: true });
    }
  }

  /** Express 앱 참조 설정 */
  setExpressApp(app: Express): void {
    this.expressApp = app;
  }

  /** 웹 레지스트리에서 어댑터 목록 조회 */
  async fetchRegistry(): Promise<RegistryEntry[]> {
    try {
      const res = await fetch(REGISTRY_URL);
      if (!res.ok) throw new Error(`Registry fetch failed: ${res.status}`);
      const data = await res.json() as { adapters: RegistryEntry[] };
      return data.adapters || [];
    } catch (e: any) {
      console.error('[AdapterManager] Registry fetch error:', e.message);
      return [];
    }
  }

  /** 웹에서 어댑터 다운로드 → userData/adapters/{id}/ 에 저장 */
  async install(adapterId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const manifestUrl = `${ADAPTER_BASE_URL}/${adapterId}/manifest.json`;
      const manifestRes = await fetch(manifestUrl);
      if (!manifestRes.ok) return { success: false, error: `manifest.json not found (${manifestRes.status})` };
      const manifestText = await manifestRes.text();
      const manifest = JSON.parse(manifestText);

      const adapterDir = path.join(this.adaptersDir, adapterId);
      if (existsSync(adapterDir)) rmSync(adapterDir, { recursive: true });
      mkdirSync(adapterDir, { recursive: true });

      writeFileSync(path.join(adapterDir, 'manifest.json'), manifestText, 'utf-8');

      // config-only 모드: handler.js 대신 config.json만 다운로드
      if (manifest.mode === 'config-only') {
        const configUrl = `${ADAPTER_BASE_URL}/${adapterId}/config.json`;
        const configRes = await fetch(configUrl);
        if (configRes.ok) {
          writeFileSync(path.join(adapterDir, 'config.json'), await configRes.text(), 'utf-8');
        }
        console.log(`[AdapterManager] Installed (config-only): ${manifest.name} (${adapterId}) v${manifest.version}`);
      } else {
        // 레거시: handler.js 다운로드
        const handlerUrl = `${ADAPTER_BASE_URL}/${adapterId}/handler.js`;
        const handlerRes = await fetch(handlerUrl);
        if (!handlerRes.ok) return { success: false, error: `handler.js not found (${handlerRes.status})` };
        writeFileSync(path.join(adapterDir, 'handler.js'), await handlerRes.text(), 'utf-8');
        console.log(`[AdapterManager] Installed: ${manifest.name} (${adapterId}) v${manifest.version}`);
      }

      return { success: true };
    } catch (e: any) {
      console.error(`[AdapterManager] Install error for ${adapterId}:`, e.message);
      return { success: false, error: e.message };
    }
  }

  /** 설치된 어댑터 ID 목록 */
  getInstalledIds(): string[] {
    if (!existsSync(this.adaptersDir)) return [];
    return readdirSync(this.adaptersDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .filter(d => existsSync(path.join(this.adaptersDir, d.name, 'manifest.json')))
      .map(d => d.name);
  }

  /** 어댑터 manifest 읽기 */
  getManifest(adapterId: string): AdapterManifest | null {
    const manifestPath = path.join(this.adaptersDir, adapterId, 'manifest.json');
    if (!existsSync(manifestPath)) return null;
    return JSON.parse(readFileSync(manifestPath, 'utf-8'));
  }

  /**
   * 어댑터 로드: handler.js가 Express app에 직접 라우트 등록
   *
   * handler.js 인터페이스:
   *   module.exports = function(app, prefix, helpers, manifest) { ... }
   *   - app: Express app (app.get, app.post 직접 호출)
   *   - prefix: '/api/kakao' 등
   *   - helpers: { adbShell, getScreen, tap, ... }
   *   - manifest: { screens, apis, ... }
   */
  load(adapterId: string): boolean {
    if (this.loaded.has(adapterId)) return true;
    if (!this.expressApp) {
      console.error(`[AdapterManager] Express app not set, cannot load ${adapterId}`);
      return false;
    }

    const manifest = this.getManifest(adapterId);
    if (!manifest) return false;

    // config-only 모드: 로직은 빌드타임에 내장되어 있으므로 handler.js 로드 불필요
    if ((manifest as any).mode === 'config-only') {
      this.loaded.set(adapterId, { manifest, status: 'running' });
      console.log(`[AdapterManager] Loaded (config-only): ${manifest.name} (${adapterId}) v${manifest.version}`);
      return true;
    }

    const handlerPath = path.join(this.adaptersDir, adapterId, 'handler.js');
    if (!existsSync(handlerPath)) return false;

    try {
      // Node vm 모듈로 handler.js 실행 (require 캐시와 무관)
      const handlerCode = readFileSync(handlerPath, 'utf-8');
      const handlerModule: any = { exports: {} };
      const cjsRequire = createRequire('file://' + handlerPath.replace(/\\/g, '/'));
      const wrapper = `(function(module, exports, require, __filename, __dirname) { ${handlerCode} \n})`;
      const compiledFn = runInThisContext(wrapper, { filename: handlerPath });
      compiledFn(handlerModule, handlerModule.exports, cjsRequire, handlerPath, path.dirname(handlerPath));
      const handlerFn = handlerModule.exports;
      console.log(`[AdapterManager] handler typeof=${typeof handlerFn}, code size=${handlerCode.length}, has SearchView=${handlerCode.includes('SearchView')}`);
      if (typeof handlerFn !== 'function') {
        console.error(`[AdapterManager] handler.js did not export a function: ${adapterId}`);
        return false;
      }

      const prefix = `/api/${adapterId}`;
      handlerFn(this.expressApp, prefix, this.helpers, manifest);

      this.loaded.set(adapterId, { manifest, status: 'running' });
      console.log(`[AdapterManager] Loaded: ${manifest.name} (${adapterId}) v${manifest.version} → ${prefix}/*`);
      return true;
    } catch (e: any) {
      console.error(`[AdapterManager] Failed to load ${adapterId}:`, e.message);
      return false;
    }
  }

  /** 어댑터 정지 */
  stop(adapterId: string): boolean {
    const adapter = this.loaded.get(adapterId);
    if (!adapter) return false;
    adapter.status = 'stopped';
    console.log(`[AdapterManager] Stopped: ${adapter.manifest.name} (${adapterId})`);
    return true;
  }

  /** 어댑터 시작 */
  start(adapterId: string): boolean {
    const adapter = this.loaded.get(adapterId);
    if (adapter) {
      adapter.status = 'running';
      return true;
    }
    return this.load(adapterId);
  }

  /** 어댑터 제거 */
  uninstall(adapterId: string): boolean {
    this.stop(adapterId);
    this.loaded.delete(adapterId);

    const adapterDir = path.join(this.adaptersDir, adapterId);
    if (existsSync(adapterDir)) {
      rmSync(adapterDir, { recursive: true });
      console.log(`[AdapterManager] Uninstalled: ${adapterId}`);
      return true;
    }
    return false;
  }

  /** 설치된 어댑터 목록 (상태 포함) */
  list(): AdapterInfo[] {
    return this.getInstalledIds().map(id => {
      const manifest = this.getManifest(id);
      const loaded = this.loaded.get(id);
      return {
        id,
        name: manifest?.name || id,
        icon: manifest?.icon || '📦',
        version: manifest?.version || '0.0.0',
        description: manifest?.description || '',
        author: manifest?.author || '',
        status: loaded?.status || 'stopped',
        package: manifest?.package || '',
      };
    });
  }

  /** 설치된 모든 어댑터 로드 (빌트인 ID가 있으면 handler.js 로드 건너뛰고 manifest만 등록) */
  loadAll(builtinIds?: Set<string>): void {
    for (const id of this.getInstalledIds()) {
      if (builtinIds?.has(id)) {
        // 빌트인 어댑터: handler.js 로드 안 함, manifest만 등록 (사이드바 표시용)
        if (!this.loaded.has(id)) {
          const manifest = this.getManifest(id);
          if (manifest) {
            this.loaded.set(id, { manifest, status: 'running' });
            console.log(`[AdapterManager] Registered (builtin): ${manifest.name} (${id}) v${manifest.version}`);
          }
        }
        continue;
      }
      this.load(id);
    }
  }

  /** /api/spec용: 실행 중 어댑터 API 목록 */
  getSpecApis(): Record<string, any[]> {
    const result: Record<string, any[]> = {};
    for (const [id, adapter] of this.loaded) {
      if (adapter.status === 'running') {
        result[`${id}_apis`] = adapter.manifest.apis.map(api => ({
          method: api.method,
          path: `/api/${id}${api.path}`,
          desc: api.description,
          params: api.params,
        }));
      }
    }
    return result;
  }

  /** 어댑터 실행 중 여부 */
  isAdapterRunning(adapterId: string): boolean {
    const adapter = this.loaded.get(adapterId);
    return adapter ? adapter.status === 'running' : false;
  }
}
