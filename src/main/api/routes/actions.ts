import { Router } from 'express';
import { execSync } from 'child_process';
import type { AdbManager } from '../../adb/AdbManager.js';
import { parseUiDump, findByText, getCenterPoint } from '../../utils/uiParser.js';
import { sanitizeSerial, sanitizeCoord, sanitizePhoneNumber } from '../../utils/sanitize.js';

export function createActionsRoutes(_adb: AdbManager) {
  const router = Router();

  function adbShell(serial: string, cmd: string): string {
    const s = sanitizeSerial(serial);
    return execSync(`adb -s ${s} shell ${cmd}`, { timeout: 5000 }).toString().trim();
  }

  function getScreen(serial: string) {
    const s = sanitizeSerial(serial);
    const xml = execSync(
      `adb -s ${s} exec-out uiautomator dump /dev/tty`,
      { timeout: 10000 }
    ).toString();
    return parseUiDump(xml);
  }

  function tap(serial: string, x: number, y: number) {
    adbShell(serial, `input tap ${sanitizeCoord(x)} ${sanitizeCoord(y)}`);
  }

  function sleep(ms: number) {
    const clamped = Math.min(Math.max(ms, 100), 5000);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, clamped);
  }

  /** POST /api/kakao/read */
  router.post('/kakao/read', async (req, res) => {
    const { serial, scrollCount = 0 } = req.body;
    if (!serial) {
      res.status(400).json({ error: 'serial required' });
      return;
    }

    try {
      const sc = Math.min(Math.max(Math.floor(scrollCount), 0), 20);
      const allTexts: string[] = [];

      for (let i = 0; i <= sc; i++) {
        const elements = getScreen(serial);
        const texts = elements.filter(e => e.text).map(e => e.text);
        allTexts.push(...texts);

        if (i < sc) {
          adbShell(serial, 'input swipe 540 1500 540 500 300');
          sleep(1000);
        }
      }

      const unique = [...new Set(allTexts)];
      res.json({ count: unique.length, messages: unique });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** POST /api/kakao/send */
  router.post('/kakao/send', async (req, res) => {
    const { serial, message } = req.body;
    if (!serial || !message) {
      res.status(400).json({ error: 'serial, message required' });
      return;
    }
    if (typeof message !== 'string' || message.length > 2000) {
      res.status(400).json({ error: 'message must be string, max 2000 chars' });
      return;
    }

    try {
      const elements = getScreen(serial);
      const inputField = elements.find(e =>
        e.resourceId.includes('message_edit_text') ||
        e.className.includes('EditText')
      );

      if (!inputField) {
        res.status(400).json({ error: 'Chat input field not found' });
        return;
      }

      const center = getCenterPoint(inputField.bounds);
      tap(serial, center.x, center.y);
      sleep(300);

      // base64 인코딩으로 쉘 메타문자 우회
      const base64 = Buffer.from(message, 'utf-8').toString('base64');
      adbShell(serial, `input keyevent 279`); // PASTE

      sleep(500);

      const elements2 = getScreen(serial);
      const sendBtn = elements2.find(e =>
        e.resourceId.includes('send') ||
        e.contentDesc.includes('전송') ||
        e.text === '전송'
      );

      if (sendBtn) {
        const sendCenter = getCenterPoint(sendBtn.bounds);
        tap(serial, sendCenter.x, sendCenter.y);
        res.json({ status: 'sent', message });
      } else {
        adbShell(serial, 'input keyevent 66');
        res.json({ status: 'sent_via_enter', message });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** POST /api/call */
  router.post('/call', async (req, res) => {
    const { serial, number } = req.body;
    if (!serial || !number) {
      res.status(400).json({ error: 'serial, number required' });
      return;
    }

    try {
      const clean = sanitizePhoneNumber(number);
      adbShell(serial, `am start -a android.intent.action.CALL -d tel:${clean}`);
      res.json({ status: 'calling', number: clean });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** POST /api/find */
  router.post('/find', async (req, res) => {
    const { serial, text, tap: shouldTap = false } = req.body;
    if (!serial || !text) {
      res.status(400).json({ error: 'serial, text required' });
      return;
    }
    if (typeof text !== 'string' || text.length > 200) {
      res.status(400).json({ error: 'text must be string, max 200 chars' });
      return;
    }

    try {
      const elements = getScreen(serial);
      const found = findByText(elements, text);

      if (!found) {
        res.json({ found: false, text });
        return;
      }

      const center = getCenterPoint(found.bounds);
      if (shouldTap) {
        tap(serial, center.x, center.y);
      }

      res.json({
        found: true,
        text: found.text,
        bounds: found.bounds,
        center,
        tapped: shouldTap,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
