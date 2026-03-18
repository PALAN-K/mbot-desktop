import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { networkInterfaces } from 'os';
import { readFileSync, writeFileSync, existsSync } from 'fs';
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

  // 인증 미들웨어
  expressApp.use('/api', createAuthMiddleware(token));

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

  // 바인딩: 같은 Wi-Fi에서 폰 PRoot가 접근해야 하므로 0.0.0.0 유지
  // 단, Bearer 토큰 + CORS + Rate Limit으로 보호
  const server = expressApp.listen(port, '0.0.0.0', () => {
    const localIP = localIPs.find(ip => ip.startsWith('192.168') || ip.startsWith('10.'));
    console.log(`[API] Server running on http://${localIP || '0.0.0.0'}:${port}`);
    console.log(`[API] Auth token: ${token}`);
  });

  return { server, token, port };
}
