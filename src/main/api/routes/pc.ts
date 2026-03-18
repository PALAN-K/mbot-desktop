import { Router } from 'express';
import { mouse, keyboard, screen, Key, Button, Point } from '@nut-tree-fork/nut-js';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { app, clipboard } from 'electron';

export function createPcRoutes() {
  const router = Router();

  /** GET /api/pc/screenshot — PC 화면 캡처 (base64) */
  router.get('/pc/screenshot', async (_req, res) => {
    try {
      const image = await screen.grab();
      const width = await image.width;
      const height = await image.height;
      const data = await image.toRGB();
      // BMP-like raw → base64 (너무 크면 리사이즈)
      res.json({
        width,
        height,
        format: 'rgb',
        size: data.data.length,
        note: 'Use /api/pc/screenshot/file for PNG file',
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** GET /api/pc/screenshot/file — PC 화면 PNG 파일로 저장 후 반환 */
  router.get('/pc/screenshot/file', async (_req, res) => {
    try {
      const filePath = path.join(app.getPath('temp'), 'mbot-pc-screenshot.png');
      // PowerShell로 스크린샷 캡처 (가장 안정적)
      execSync(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | Out-Null; Add-Type -AssemblyName System.Drawing; $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size); $bmp.Save('${filePath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()"`, { timeout: 10000 });
      res.sendFile(filePath);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** POST /api/pc/click — 마우스 클릭 */
  router.post('/pc/click', async (req, res) => {
    const { x, y, button: btn = 'left', double = false } = req.body;
    if (typeof x !== 'number' || typeof y !== 'number') {
      res.status(400).json({ error: 'x, y (number) required' });
      return;
    }
    try {
      await mouse.setPosition(new Point(x, y));
      const mouseBtn = btn === 'right' ? Button.RIGHT : Button.LEFT;
      if (double) {
        await mouse.doubleClick(mouseBtn);
      } else {
        await mouse.click(mouseBtn);
      }
      res.json({ status: 'clicked', x, y, button: btn, double });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** POST /api/pc/move — 마우스 이동 */
  router.post('/pc/move', async (req, res) => {
    const { x, y } = req.body;
    if (typeof x !== 'number' || typeof y !== 'number') {
      res.status(400).json({ error: 'x, y (number) required' });
      return;
    }
    try {
      await mouse.setPosition(new Point(x, y));
      res.json({ status: 'moved', x, y });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** POST /api/pc/scroll — 마우스 스크롤 */
  router.post('/pc/scroll', async (req, res) => {
    const { amount = 3, direction = 'down' } = req.body;
    try {
      const scrollAmount = Math.min(Math.max(Math.floor(amount), 1), 20);
      if (direction === 'up') {
        await mouse.scrollUp(scrollAmount);
      } else {
        await mouse.scrollDown(scrollAmount);
      }
      res.json({ status: 'scrolled', direction, amount: scrollAmount });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** POST /api/pc/type — 키보드 텍스트 입력 */
  router.post('/pc/type', async (req, res) => {
    const { text } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'text (string) required' });
      return;
    }
    if (text.length > 5000) {
      res.status(400).json({ error: 'text max 5000 chars' });
      return;
    }
    try {
      await keyboard.type(text);
      res.json({ status: 'typed', length: text.length });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** POST /api/pc/key — 키보드 단축키 */
  router.post('/pc/key', async (req, res) => {
    const { keys } = req.body;
    if (!keys || !Array.isArray(keys) || keys.length === 0) {
      res.status(400).json({ error: 'keys (string[]) required. e.g. ["control","c"]' });
      return;
    }
    try {
      const keyMap: Record<string, Key> = {
        'enter': Key.Enter, 'return': Key.Enter,
        'tab': Key.Tab, 'escape': Key.Escape, 'esc': Key.Escape,
        'space': Key.Space, 'backspace': Key.Backspace, 'delete': Key.Delete,
        'up': Key.Up, 'down': Key.Down, 'left': Key.Left, 'right': Key.Right,
        'home': Key.Home, 'end': Key.End, 'pageup': Key.PageUp, 'pagedown': Key.PageDown,
        'control': Key.LeftControl, 'ctrl': Key.LeftControl,
        'alt': Key.LeftAlt, 'shift': Key.LeftShift,
        'super': Key.LeftSuper, 'win': Key.LeftSuper, 'meta': Key.LeftSuper,
        'f1': Key.F1, 'f2': Key.F2, 'f3': Key.F3, 'f4': Key.F4,
        'f5': Key.F5, 'f6': Key.F6, 'f7': Key.F7, 'f8': Key.F8,
        'f9': Key.F9, 'f10': Key.F10, 'f11': Key.F11, 'f12': Key.F12,
        'a': Key.A, 'b': Key.B, 'c': Key.C, 'd': Key.D, 'e': Key.E,
        'f': Key.F, 'g': Key.G, 'h': Key.H, 'i': Key.I, 'j': Key.J,
        'k': Key.K, 'l': Key.L, 'm': Key.M, 'n': Key.N, 'o': Key.O,
        'p': Key.P, 'q': Key.Q, 'r': Key.R, 's': Key.S, 't': Key.T,
        'u': Key.U, 'v': Key.V, 'w': Key.W, 'x': Key.X, 'y': Key.Y, 'z': Key.Z,
        '0': Key.Num0, '1': Key.Num1, '2': Key.Num2, '3': Key.Num3, '4': Key.Num4,
        '5': Key.Num5, '6': Key.Num6, '7': Key.Num7, '8': Key.Num8, '9': Key.Num9,
      };
      const mapped = keys.map((k: string) => {
        const key = keyMap[k.toLowerCase()];
        if (!key) throw new Error(`Unknown key: ${k}`);
        return key;
      });
      await keyboard.pressKey(...mapped);
      await keyboard.releaseKey(...mapped);
      res.json({ status: 'pressed', keys });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** POST /api/pc/launch — 앱/URL 실행 */
  router.post('/pc/launch', async (req, res) => {
    const { target } = req.body;
    if (!target || typeof target !== 'string') {
      res.status(400).json({ error: 'target (string) required — app name, path, or URL' });
      return;
    }
    // URL or file path only (보안: 쉘 명령 차단)
    if (target.includes('|') || target.includes('&') || target.includes(';') || target.includes('`')) {
      res.status(400).json({ error: 'Invalid characters in target' });
      return;
    }
    try {
      execSync(`start "" "${target}"`, { shell: 'cmd.exe', timeout: 5000 });
      res.json({ status: 'launched', target });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** GET /api/pc/clipboard — 클립보드 읽기 */
  router.get('/pc/clipboard', async (_req, res) => {
    try {
      const text = clipboard.readText();
      res.json({ text });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** POST /api/pc/clipboard — 클립보드 쓰기 */
  router.post('/pc/clipboard', async (req, res) => {
    const { text } = req.body;
    if (typeof text !== 'string') {
      res.status(400).json({ error: 'text (string) required' });
      return;
    }
    try {
      clipboard.writeText(text);
      res.json({ status: 'copied', length: text.length });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** GET /api/pc/files — 디렉토리 목록 */
  router.get('/pc/files', async (req, res) => {
    const dirPath = (req.query.path as string) || app.getPath('desktop');
    if (!existsSync(dirPath)) {
      res.status(404).json({ error: 'Directory not found' });
      return;
    }
    try {
      const entries = readdirSync(dirPath).slice(0, 100).map(name => {
        try {
          const full = path.join(dirPath, name);
          const stat = statSync(full);
          return { name, isDir: stat.isDirectory(), size: stat.size };
        } catch {
          return { name, isDir: false, size: 0 };
        }
      });
      res.json({ path: dirPath, entries });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** GET /api/pc/file — 파일 읽기 (텍스트) */
  router.get('/pc/file', async (req, res) => {
    const filePath = req.query.path as string;
    if (!filePath || !existsSync(filePath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    try {
      const stat = statSync(filePath);
      if (stat.size > 1024 * 1024) {
        res.status(400).json({ error: 'File too large (max 1MB)' });
        return;
      }
      const content = readFileSync(filePath, 'utf-8');
      res.json({ path: filePath, size: stat.size, content });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** POST /api/pc/file — 파일 쓰기 */
  router.post('/pc/file', async (req, res) => {
    const { path: filePath, content } = req.body;
    if (!filePath || typeof content !== 'string') {
      res.status(400).json({ error: 'path, content required' });
      return;
    }
    if (content.length > 1024 * 1024) {
      res.status(400).json({ error: 'Content too large (max 1MB)' });
      return;
    }
    try {
      writeFileSync(filePath, content, 'utf-8');
      res.json({ status: 'written', path: filePath, size: content.length });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
