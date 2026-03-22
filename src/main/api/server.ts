import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { networkInterfaces } from 'os';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { pathToFileURL } from 'url';
import path from 'path';
import { app } from 'electron';
import type { AdbManager } from '../adb/AdbManager.js';
import { createScreenRoutes } from './routes/screen.js';
import { createInputRoutes } from './routes/input.js';
import { createDeviceRoutes } from './routes/device.js';
import { createActionsRoutes } from './routes/actions.js';
import { createPcRoutes } from './routes/pc.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createRateLimit } from './middleware/rateLimit.js';
import { AdapterManager } from '../adapters/adapter-manager.js';
import {
  adbShell, getScreen, tap, sleep, typeText,
  findAndTap, launchApp, waitForText, scrollUp, goBack,
} from './routes/helpers/appHelper.js';
import { getCenterPoint } from '../utils/uiParser.js';

export interface ApiServerOptions {
  port?: number;
  adbManager: AdbManager;
}

function getLocalIPs(): string[] {
  const ips: string[] = ['127.0.0.1', '::1'];
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

/**
 * 빌트인 어댑터 자동 스캔 + 등록
 *
 * dist/main/api/routes/adapters/ 내의 모든 .js 파일을 스캔.
 * 각 파일은 create{Name}Routes(adb, config?) 형태의 named export를 제공.
 * 파일명이 어댑터 ID가 됨 (kakao.js → /api/kakao/*).
 * userData/adapters/{id}/config.json이 있으면 remote config로 전달.
 */
function loadBuiltinAdapters(expressApp: ReturnType<typeof express>, adbManager: AdbManager): Set<string> {
  const builtinIds = new Set<string>();

  // dist 기준 경로 (tsc 빌드 후)
  const adaptersDir = path.join(__dirname, 'api', 'routes', 'adapters');
  if (!existsSync(adaptersDir)) {
    console.log('[BuiltinAdapters] No adapters directory found at', adaptersDir);
    return builtinIds;
  }

  const files = readdirSync(adaptersDir).filter(f => f.endsWith('.js'));
  for (const file of files) {
    const adapterId = file.replace('.js', '');
    const filePath = path.join(adaptersDir, file);

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(filePath);

      // create{Name}Routes 형태의 함수 찾기
      const factoryName = Object.keys(mod).find(k => k.startsWith('create') && k.endsWith('Routes'));
      const factory = factoryName ? mod[factoryName] : mod.default;

      if (typeof factory !== 'function') {
        console.warn(`[BuiltinAdapters] ${file}: no factory function found, skipping`);
        continue;
      }

      // remote config 로드 (있으면)
      const configPath = path.join(app.getPath('userData'), 'adapters', adapterId, 'config.json');
      let remoteConfig: any = undefined;
      if (existsSync(configPath)) {
        try {
          remoteConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
        } catch { /* ignore */ }
      }

      const router = factory(adbManager, remoteConfig);
      expressApp.use(`/api/${adapterId}`, router);
      builtinIds.add(adapterId);
      console.log(`[BuiltinAdapters] Loaded: ${adapterId} → /api/${adapterId}/*${remoteConfig ? ' (with remote config)' : ''}`);
    } catch (e: any) {
      console.error(`[BuiltinAdapters] Failed to load ${file}:`, e.message);
    }
  }

  return builtinIds;
}

export function startApiServer(options: ApiServerOptions) {
  const { port = 8765, adbManager } = options;
  const expressApp = express();

  // 토큰 영구 저장 (앱 재시작해도 유지)
  const tokenPath = path.join(app.getPath('userData'), 'api-token.txt');
  let token: string;
  if (existsSync(tokenPath)) {
    token = readFileSync(tokenPath, 'utf-8').trim();
  } else {
    token = uuidv4();
    writeFileSync(tokenPath, token);
  }
  const localIPs = getLocalIPs();

  // CORS: 동일 네트워크 (로컬 IP) 만 허용
  expressApp.use(cors({
    origin: (origin, callback) => {
      // origin이 없으면 (curl, 같은 머신) 허용
      if (!origin) return callback(null, true);
      const originHost = new URL(origin).hostname;
      if (localIPs.includes(originHost) || originHost === 'localhost') {
        return callback(null, true);
      }
      callback(new Error('Not allowed by CORS'));
    },
  }));

  expressApp.use(express.json());

  // Rate limiting (10 req/sec)
  expressApp.use('/api', createRateLimit(10));

  // Health check (인증 불필요)
  expressApp.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', version: app.getVersion() });
  });

  // API Spec — OpenClaw AI가 자동으로 학습하는 가이드 (인증 불필요)
  expressApp.get('/api/spec', async (_req, res) => {
    const localIP = localIPs.find(ip => ip.startsWith('192.168') || ip.startsWith('10.')) || 'localhost';
    const devices = await adbManager.listDevices();
    const serials = devices.map(d => d.serial);

    res.json({
      name: 'mbot Desktop API',
      version: app.getVersion(),
      server: `http://${localIP}:${port}`,
      auth: `Bearer ${token}`,
      devices: serials,
      guide: `You can control Android phones connected to this PC. Use /api/do to run multi-step actions atomically with verification. No app-specific APIs needed — works with ANY app.`,
      apis: [
        {
          method: 'POST', path: '/api/do',
          desc: 'RECOMMENDED: Run a sequence of actions atomically with optional verification. Replaces all app-specific APIs.',
          body: {
            serial: 'string',
            steps: [
              '{ action: "launch", package: "com.kakao.talk" }',
              '{ action: "sleep", ms: 1000 }',
              '{ action: "find", text: "target text", tap: true }',
              '{ action: "find", text: "EditText", tap: true, by: "class" }',
              '{ action: "type", text: "message" }',
              '{ action: "find", text: "전송", tap: true }',
              '{ action: "back" }',
              '{ action: "swipe", x1: 540, y1: 1500, x2: 540, y2: 500 }',
              '{ action: "keyevent", keycode: 66 }',
              '{ action: "tap", x: 540, y: 960 }',
            ],
            verify: '{ text: "expected text on screen", timeout: 3000 } (optional)',
            retry: '{ count: 3, delayMs: 1000 } (optional, max 5 retries — reruns all steps + verify on failure)',
          },
          find_options: {
            by_text: '{ action: "find", text: "검색" } — default, partial match',
            by_class: '{ action: "find", text: "EditText", by: "class" } — find by class name',
            by_id: '{ action: "find", text: "send_btn", by: "id" } — find by resource ID',
            by_desc: '{ action: "find", text: "전송", by: "desc" } — find by content description',
            optional: '{ action: "find", text: "닫기", tap: true, optional: true } — skip if not found',
          },
          examples: {
            send_kakao: {
              desc: 'Open KakaoTalk room and send message with verification',
              body: {
                serial: serials[0] || 'SERIAL',
                steps: [
                  { action: 'launch', package: 'com.kakao.talk' },
                  { action: 'sleep', ms: 1000 },
                  { action: 'find', text: '내폰모음', tap: true },
                  { action: 'sleep', ms: 500 },
                  { action: 'find', text: 'EditText', tap: true, by: 'class' },
                  { action: 'type', text: '안녕하세요' },
                  { action: 'find', text: '전송', tap: true },
                ],
                verify: { text: '안녕하세요', timeout: 3000 },
              },
            },
            navigate_any_app: {
              desc: 'Generic: open app, find button, tap, verify',
              body: {
                serial: serials[0] || 'SERIAL',
                steps: [
                  { action: 'launch', package: 'com.example.app' },
                  { action: 'sleep', ms: 1000 },
                  { action: 'find', text: 'Login', tap: true },
                ],
                verify: { text: 'Welcome', timeout: 5000 },
              },
            },
          },
        },
        {
          method: 'GET', path: '/api/screen/text', params: 'serial (query)',
          desc: 'Read all visible text on screen. Use to understand current state.',
          example: `GET /api/screen/text?serial=${serials[0] || 'SERIAL'}`,
        },
        {
          method: 'POST', path: '/api/find', body: { serial: 'string', text: 'string', tap: 'boolean' },
          desc: 'Find text on screen and optionally tap it. For single actions.',
        },
        {
          method: 'POST', path: '/api/tap', body: { serial: 'string', x: 'number', y: 'number' },
          desc: 'Tap at exact coordinates.',
        },
        {
          method: 'POST', path: '/api/swipe', body: { serial: 'string', x1: 540, y1: 1500, x2: 540, y2: 500 },
          desc: 'Swipe/scroll.',
        },
        {
          method: 'POST', path: '/api/keyevent', body: { serial: 'string', keycode: 'string' },
          desc: 'Send key event. Common: KEYCODE_BACK, KEYCODE_HOME, 66 (enter).',
        },
        {
          method: 'POST', path: '/api/sms/send', body: { serial: 'string', number: 'string', message: 'string' },
          desc: 'Send SMS. Opens messaging app, types message (Korean supported), and taps send.',
        },
        {
          method: 'POST', path: '/api/call', body: { serial: 'string', number: 'string' },
          desc: 'Make a phone call.',
        },
        {
          method: 'POST', path: '/api/launch', body: { serial: 'string', package: 'string' },
          desc: 'Launch app. e.g. com.kakao.talk, com.naver.app',
        },
      ],
      ...adapterManager.getSpecApis(),
      pc_apis: [
        {
          method: 'GET', path: '/api/pc/screenshot/file',
          desc: 'Take PC screenshot (returns PNG). Use this FIRST to see what is on the PC screen.',
        },
        {
          method: 'POST', path: '/api/pc/click', body: { x: 'number', y: 'number', button: 'left|right', double: 'boolean' },
          desc: 'Click at coordinates on PC screen.',
        },
        {
          method: 'POST', path: '/api/pc/type', body: { text: 'string' },
          desc: 'Type text on PC keyboard.',
        },
        {
          method: 'POST', path: '/api/pc/key', body: { keys: ['ctrl', 'c'] },
          desc: 'Press keyboard shortcut. e.g. ["ctrl","c"], ["alt","tab"], ["enter"]',
        },
        {
          method: 'POST', path: '/api/pc/scroll', body: { amount: 3, direction: 'down|up' },
          desc: 'Scroll mouse wheel.',
        },
        {
          method: 'POST', path: '/api/pc/launch', body: { target: 'notepad|https://google.com' },
          desc: 'Launch app or open URL on PC.',
        },
        {
          method: 'GET', path: '/api/pc/clipboard',
          desc: 'Read PC clipboard text.',
        },
        {
          method: 'POST', path: '/api/pc/clipboard', body: { text: 'string' },
          desc: 'Write text to PC clipboard.',
        },
        {
          method: 'GET', path: '/api/pc/files?path=C:\\Users',
          desc: 'List files in directory (default: Desktop).',
        },
        {
          method: 'GET', path: '/api/pc/file?path=C:\\file.txt',
          desc: 'Read text file content (max 1MB).',
        },
        {
          method: 'POST', path: '/api/pc/file', body: { path: 'string', content: 'string' },
          desc: 'Write text to file.',
        },
      ],
      pattern: [
        '--- Phone Control (BEST) ---',
        '1. POST /api/do — run steps + verify in ONE call (recommended for multi-step tasks)',
        '--- Phone Control (Simple) ---',
        '1. GET /api/screen/text — read phone screen',
        '2. POST /api/find with tap:true — find and tap',
        '3. GET /api/screen/text — verify result',
        '--- PC Control ---',
        '1. GET /api/pc/screenshot/file — see PC screen',
        '2. POST /api/pc/click — click on PC',
        '3. POST /api/pc/type — type on PC',
        '4. POST /api/pc/key — keyboard shortcuts',
        '5. POST /api/pc/launch — open apps/URLs',
      ],
    });
  });

  // 어댑터 매니저 초기화 (웹 다운로드 방식 — palank.co.kr에서 설치)
  const adapterHelpers = { adbShell, getScreen, tap, sleep, typeText, findAndTap, launchApp, waitForText, scrollUp, goBack, getCenterPoint };
  const adapterManager = new AdapterManager(app.getPath('userData'), adapterHelpers);
  adapterManager.setExpressApp(expressApp);

  // 인증 미들웨어
  expressApp.use('/api', createAuthMiddleware(token));

  // 1. 빌트인 어댑터 먼저 등록 (adapters/*.js 자동 스캔)
  //    빌트인이 우선, handler.js는 빌트인이 없는 어댑터만 로드
  const builtinIds = loadBuiltinAdapters(expressApp, adbManager);

  // 2. 설치된 어댑터 로드 (handler.js — 빌트인과 겹치면 handler.js 로드 스킵)
  //    단, 사이드바 표시를 위해 manifest는 loaded 맵에 등록
  adapterManager.loadAll(builtinIds);

  // 라우트 등록
  expressApp.use('/api', createScreenRoutes(adbManager));
  expressApp.use('/api', createInputRoutes(adbManager));
  expressApp.use('/api', createDeviceRoutes(adbManager));
  expressApp.use('/api', createActionsRoutes(adbManager));
  const pcRoutes = createPcRoutes();
  expressApp.use('/api', pcRoutes);
  // 별칭: OpenClaw가 /api/file 등으로 호출할 수 있으므로 /pc/ 없이도 동작
  expressApp.use('/api', (req, res, next) => {
    if (req.path.startsWith('/file') || req.path.startsWith('/clipboard') ||
        req.path.startsWith('/screenshot') || req.path.startsWith('/click') ||
        req.path.startsWith('/move') || req.path.startsWith('/scroll') ||
        req.path.startsWith('/type') || req.path.startsWith('/key') ||
        req.path.startsWith('/launch')) {
      req.url = '/pc' + req.url;
    }
    next();
  }, pcRoutes);

  // 어댑터 관리 API
  expressApp.get('/api/adapters', (_req, res) => {
    res.json({ adapters: adapterManager.list() });
  });

  expressApp.get('/api/adapters/registry', async (_req, res) => {
    const registry = await adapterManager.fetchRegistry();
    res.json({ adapters: registry });
  });

  expressApp.post('/api/adapters/:id/install', async (req, res) => {
    const result = await adapterManager.install(req.params.id);
    if (result.success) {
      adapterManager.load(req.params.id);
    }
    res.json(result);
  });

  expressApp.post('/api/adapters/:id/start', (req, res) => {
    const ok = adapterManager.start(req.params.id);
    res.json({ status: ok ? 'started' : 'failed', id: req.params.id });
  });

  expressApp.post('/api/adapters/:id/stop', (req, res) => {
    const ok = adapterManager.stop(req.params.id);
    res.json({ status: ok ? 'stopped' : 'failed', id: req.params.id });
  });

  expressApp.delete('/api/adapters/:id', (req, res) => {
    const ok = adapterManager.uninstall(req.params.id);
    res.json({ status: ok ? 'uninstalled' : 'not_found', id: req.params.id });
  });

  // 바인딩: 같은 Wi-Fi에서 폰 PRoot가 접근해야 하므로 0.0.0.0 유지
  // 단, Bearer 토큰 + CORS + Rate Limit으로 보호
  const server = expressApp.listen(port, '0.0.0.0', () => {
    const localIP = localIPs.find(ip => ip.startsWith('192.168') || ip.startsWith('10.'));
    console.log(`[API] Server running on http://${localIP || '0.0.0.0'}:${port}`);
    console.log(`[API] Auth token: ${token}`);
  });

  return { server, token, port, adapterManager };
}
