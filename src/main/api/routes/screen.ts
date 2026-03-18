import { Router } from 'express';
import { execSync } from 'child_process';
import type { AdbManager } from '../../adb/AdbManager.js';
import { parseUiDump } from '../../utils/uiParser.js';
import { sanitizeSerial } from '../../utils/sanitize.js';

export function createScreenRoutes(adb: AdbManager) {
  const router = Router();

  /** GET /api/screen — UI 요소 목록 (JSON) */
  router.get('/screen', async (req, res) => {
    const serial = req.query.serial as string;
    if (!serial || typeof serial !== 'string') {
      res.status(400).json({ error: 'serial parameter required' });
      return;
    }

    try {
      const s = sanitizeSerial(serial);
      const xml = execSync(
        `adb -s ${s} exec-out uiautomator dump /dev/tty`,
        { timeout: 10000 }
      ).toString();

      const elements = parseUiDump(xml);
      const packageName = elements[0]?.package || 'unknown';

      res.json({ package: packageName, count: elements.length, elements });
    } catch (error: any) {
      res.status(500).json({ error: 'Screen dump failed', detail: error.message });
    }
  });

  /** GET /api/screen/text — 텍스트만 추출 (간결) */
  router.get('/screen/text', async (req, res) => {
    const serial = req.query.serial as string;
    if (!serial || typeof serial !== 'string') {
      res.status(400).json({ error: 'serial parameter required' });
      return;
    }

    try {
      const s = sanitizeSerial(serial);
      const xml = execSync(
        `adb -s ${s} exec-out uiautomator dump /dev/tty`,
        { timeout: 10000 }
      ).toString();

      const elements = parseUiDump(xml);
      const texts = elements
        .filter(e => e.text)
        .map(e => ({ text: e.text, bounds: e.bounds, clickable: e.clickable }));

      res.json({ count: texts.length, texts });
    } catch (error: any) {
      res.status(500).json({ error: 'Screen dump failed', detail: error.message });
    }
  });

  /** GET /api/screenshot — base64 PNG */
  router.get('/screenshot', async (req, res) => {
    const serial = req.query.serial as string;
    if (!serial || typeof serial !== 'string') {
      res.status(400).json({ error: 'serial parameter required' });
      return;
    }

    try {
      const s3 = sanitizeSerial(serial);
      const buffer = execSync(
        `adb -s ${s3} exec-out screencap -p`,
        { timeout: 10000, maxBuffer: 10 * 1024 * 1024 }
      );

      const base64 = buffer.toString('base64');
      res.json({ image: `data:image/png;base64,${base64}`, size: buffer.length });
    } catch (error: any) {
      res.status(500).json({ error: 'Screenshot failed', detail: error.message });
    }
  });

  return router;
}
