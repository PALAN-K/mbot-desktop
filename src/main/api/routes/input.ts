import { Router } from 'express';
import { execSync } from 'child_process';
import type { AdbManager } from '../../adb/AdbManager.js';
import { sanitizeSerial, sanitizeCoord, sanitizeShellArg, sanitizeKeycode, sanitizePackage } from '../../utils/sanitize.js';

export function createInputRoutes(_adb: AdbManager) {
  const router = Router();

  function adbShell(serial: string, cmd: string): string {
    const s = sanitizeSerial(serial);
    return execSync(`adb -s ${s} shell ${cmd}`, { timeout: 5000 }).toString().trim();
  }

  /** POST /api/tap */
  router.post('/tap', (req, res) => {
    const { serial, x, y } = req.body;
    if (!serial || x == null || y == null) {
      res.status(400).json({ error: 'serial, x, y required' });
      return;
    }

    try {
      const sx = sanitizeCoord(x);
      const sy = sanitizeCoord(y);
      adbShell(serial, `input tap ${sx} ${sy}`);
      res.json({ status: 'ok', action: 'tap', x: sx, y: sy });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** POST /api/swipe */
  router.post('/swipe', (req, res) => {
    const { serial, x1, y1, x2, y2, duration = 300 } = req.body;
    if (!serial || x1 == null || y1 == null || x2 == null || y2 == null) {
      res.status(400).json({ error: 'serial, x1, y1, x2, y2 required' });
      return;
    }

    try {
      const args = [x1, y1, x2, y2].map(sanitizeCoord);
      const dur = Math.min(Math.max(Math.floor(duration), 50), 5000);
      adbShell(serial, `input swipe ${args.join(' ')} ${dur}`);
      res.json({ status: 'ok', action: 'swipe' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** POST /api/type */
  router.post('/type', (req, res) => {
    const { serial, text } = req.body;
    if (!serial || !text) {
      res.status(400).json({ error: 'serial, text required' });
      return;
    }

    try {
      const clean = sanitizeShellArg(text).replace(/ /g, '%s');
      adbShell(serial, `input text '${clean}'`);
      res.json({ status: 'ok', action: 'type', text: clean });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** POST /api/keyevent */
  router.post('/keyevent', (req, res) => {
    const { serial, keycode } = req.body;
    if (!serial || !keycode) {
      res.status(400).json({ error: 'serial, keycode required' });
      return;
    }

    try {
      const kc = sanitizeKeycode(keycode);
      adbShell(serial, `input keyevent ${kc}`);
      res.json({ status: 'ok', action: 'keyevent', keycode: kc });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** POST /api/launch */
  router.post('/launch', (req, res) => {
    const { serial, package: pkg, activity, uri } = req.body;
    if (!serial) {
      res.status(400).json({ error: 'serial required' });
      return;
    }

    try {
      if (uri) {
        const cleanUri = sanitizeShellArg(uri);
        adbShell(serial, `am start -a android.intent.action.VIEW -d '${cleanUri}'`);
      } else if (pkg && activity) {
        const cleanPkg = sanitizePackage(pkg);
        const cleanAct = sanitizeShellArg(activity);
        adbShell(serial, `am start -n ${cleanPkg}/${cleanAct}`);
      } else if (pkg) {
        const cleanPkg = sanitizePackage(pkg);
        adbShell(serial, `monkey -p ${cleanPkg} -c android.intent.category.LAUNCHER 1`);
      } else {
        res.status(400).json({ error: 'package or uri required' });
        return;
      }
      res.json({ status: 'ok', action: 'launch' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
