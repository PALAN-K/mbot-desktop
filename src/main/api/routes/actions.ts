import { Router } from 'express';
import type { AdbManager } from '../../adb/AdbManager.js';
import { findByText, getCenterPoint } from '../../utils/uiParser.js';
import { sanitizeCoord, sanitizePhoneNumber } from '../../utils/sanitize.js';
import { adbShell, getScreen, tap, sleep, typeText } from './helpers/appHelper.js';

export function createActionsRoutes(_adb: AdbManager) {
  const router = Router();

  /**
   * POST /api/sms/send — SMS 전송 (원자적: 실행 + 입력 + 전송 + 검증)
   */
  router.post('/sms/send', async (req, res) => {
    const { serial, number, message, verify = true, timeoutMs = 8000 } = req.body;
    if (!serial || !number || !message) {
      res.status(400).json({ error: 'serial, number, message required' });
      return;
    }
    if (typeof message !== 'string' || message.length > 1000) {
      res.status(400).json({ error: 'message must be string, max 1000 chars' });
      return;
    }

    const stage = { current: 'start' };

    try {
      const cleanNumber = sanitizePhoneNumber(number);

      stage.current = 'launch_sms_app';
      try {
        adbShell(serial, ['am', 'start', '-a', 'android.intent.action.SENDTO', '-d', `sms:${cleanNumber}`]);
      } catch {
        adbShell(serial, ['monkey', '-p', 'com.samsung.android.messaging', '-c', 'android.intent.category.LAUNCHER', '1']);
      }
      sleep(1200);

      stage.current = 'dismiss_panels';
      const preCheck = getScreen(serial);
      const hasAttachPanel = preCheck.some(e =>
        e.text === '카메라' || e.text === '갤러리' || e.text === '음성'
      );
      if (hasAttachPanel) {
        adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
        sleep(500);
      }

      stage.current = 'focus_input';
      const elements = getScreen(serial);
      const inputField = elements.find(e =>
        e.className.includes('EditText') &&
        !e.resourceId.includes('recipient') &&
        !e.resourceId.includes('to')
      );

      if (inputField) {
        const center = getCenterPoint(inputField.bounds);
        tap(serial, center.x, center.y);
      } else {
        tap(serial, 540, 2080);
      }
      sleep(300);

      adbShell(serial, ['input', 'keyevent', 'KEYCODE_MOVE_END']);
      adbShell(serial, ['input', 'keyevent', '--longpress', 'KEYCODE_DEL']);
      sleep(200);

      stage.current = 'type_message';
      typeText(serial, message);
      sleep(500);

      stage.current = 'send_tap';
      const elements2 = getScreen(serial);
      const sendBtn = elements2.find(e =>
        e.contentDesc.includes('보내기') || e.contentDesc.includes('전송') || e.contentDesc.includes('Send') ||
        e.text === '전송' || e.text === '보내기' || e.text === 'Send' ||
        (e.resourceId.includes('send') && e.clickable)
      );

      if (sendBtn) {
        const sendCenter = getCenterPoint(sendBtn.bounds);
        tap(serial, sendCenter.x, sendCenter.y);
      } else {
        tap(serial, 1015, 2080);
        sleep(200);
        adbShell(serial, ['input', 'keyevent', '66']);
      }
      sleep(500);

      if (!verify) {
        res.json({ status: 'sent', number: cleanNumber, message, verified: false, method: 'ui-compose-noverify' });
        return;
      }

      stage.current = 'verify';
      const deadline = Date.now() + Math.min(timeoutMs, 15000);
      let verified = false;
      const snippet = message.substring(0, 20);

      while (Date.now() < deadline) {
        sleep(500);
        const elements3 = getScreen(serial);
        const texts = elements3.filter(e => e.text).map(e => e.text);
        if (texts.some(t => t.includes(snippet))) { verified = true; break; }
      }

      if (verified) {
        res.json({ status: 'sent', number: cleanNumber, message, verified: true, method: 'ui-compose+verify' });
      } else {
        stage.current = 'retry_send';
        adbShell(serial, ['input', 'keyevent', '66']);
        sleep(1000);
        const elements4 = getScreen(serial);
        const texts2 = elements4.filter(e => e.text).map(e => e.text);
        const retryVerified = texts2.some(t => t.includes(snippet));
        if (retryVerified) {
          res.json({ status: 'sent', number: cleanNumber, message, verified: true, method: 'ui-compose+verify+retry' });
        } else {
          res.status(409).json({ status: 'failed', stage: 'verify', error: 'Message not observed on screen within timeout', number: cleanNumber, message, verified: false });
        }
      }
    } catch (error: any) {
      res.status(500).json({ status: 'failed', stage: stage.current, error: error.message, verified: false });
    }
  });

  // 레거시 /api/kakao/read, /api/kakao/send 삭제됨
  // → 외부 어댑터: /api/kakao/read-thread, /api/kakao/send-message 사용

  /** POST /api/call */
  router.post('/call', async (req, res) => {
    const { serial, number } = req.body;
    if (!serial || !number) { res.status(400).json({ error: 'serial, number required' }); return; }
    try {
      const clean = sanitizePhoneNumber(number);
      adbShell(serial, ['am', 'start', '-a', 'android.intent.action.CALL', '-d', `tel:${clean}`]);
      res.json({ status: 'calling', number: clean });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** POST /api/find */
  router.post('/find', async (req, res) => {
    const { serial, text, tap: shouldTap = false } = req.body;
    if (!serial || !text) { res.status(400).json({ error: 'serial, text required' }); return; }
    if (typeof text !== 'string' || text.length > 200) { res.status(400).json({ error: 'text must be string, max 200 chars' }); return; }

    try {
      const elements = getScreen(serial);
      const found = findByText(elements, text);
      if (!found) { res.json({ found: false, text }); return; }

      const center = getCenterPoint(found.bounds);
      if (shouldTap) { tap(serial, center.x, center.y); }
      res.json({ found: true, text: found.text, bounds: found.bounds, center, tapped: shouldTap });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/do — 범용 액션 시퀀스 실행 + 검증
   */
  function runSteps(serial: string, steps: any[]) {
    const log: { step: number; action: string; result: string }[] = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      switch (step.action) {
        case 'find': {
          const elements = getScreen(serial);
          let found;
          if (step.by === 'class') found = elements.find(e => e.className.includes(step.text));
          else if (step.by === 'id') found = elements.find(e => e.resourceId.includes(step.text));
          else if (step.by === 'desc') found = elements.find(e => e.contentDesc.includes(step.text));
          else found = findByText(elements, step.text);
          if (!found) {
            log.push({ step: i, action: 'find', result: `not found: ${step.text}` });
            if (step.optional) continue;
            return { ok: false, failedAt: i, reason: `"${step.text}" not found`, log };
          }
          if (step.tap) {
            const c = getCenterPoint(found.bounds);
            tap(serial, c.x, c.y);
            log.push({ step: i, action: 'find+tap', result: `${step.text} at ${c.x},${c.y}` });
          } else {
            log.push({ step: i, action: 'find', result: `found: ${found.text || found.className}` });
          }
          break;
        }
        case 'tap': {
          tap(serial, sanitizeCoord(step.x), sanitizeCoord(step.y));
          log.push({ step: i, action: 'tap', result: `${step.x},${step.y}` });
          break;
        }
        case 'type': {
          if (!step.text) break;
          typeText(serial, step.text);
          log.push({ step: i, action: 'type', result: step.text.substring(0, 30) });
          break;
        }
        case 'keyevent': {
          adbShell(serial, ['input', 'keyevent', String(step.keycode || 66)]);
          log.push({ step: i, action: 'keyevent', result: `${step.keycode || 66}` });
          break;
        }
        case 'swipe': {
          const x1 = step.x1 || 540, y1 = step.y1 || 1500;
          const x2 = step.x2 || 540, y2 = step.y2 || 500;
          adbShell(serial, ['input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(step.duration || 300)]);
          log.push({ step: i, action: 'swipe', result: 'ok' });
          break;
        }
        case 'launch': {
          if (step.package) {
            adbShell(serial, ['monkey', '-p', step.package, '-c', 'android.intent.category.LAUNCHER', '1']);
            log.push({ step: i, action: 'launch', result: step.package });
          }
          break;
        }
        case 'back': {
          adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
          log.push({ step: i, action: 'back', result: 'ok' });
          break;
        }
        case 'sleep': {
          sleep(step.ms || 500);
          log.push({ step: i, action: 'sleep', result: `${step.ms || 500}ms` });
          break;
        }
        default:
          log.push({ step: i, action: step.action, result: 'unknown action, skipped' });
      }
    }

    return { ok: true, log };
  }

  function verifyScreen(serial: string, text: string, timeout: number): boolean {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const elements = getScreen(serial);
      const texts = elements.filter(e => e.text).map(e => e.text);
      if (texts.some(t => t.includes(text))) return true;
      sleep(500);
    }
    return false;
  }

  router.post('/do', async (req, res) => {
    const { serial, steps, verify, retry } = req.body;
    if (!serial || !Array.isArray(steps) || steps.length === 0) {
      res.status(400).json({ error: 'serial, steps[] required' });
      return;
    }
    if (steps.length > 20) { res.status(400).json({ error: 'max 20 steps' }); return; }

    const maxRetries = Math.min(retry?.count || 1, 5);
    const retryDelay = Math.min(retry?.delayMs || 1000, 5000);
    const allLogs: any[] = [];

    try {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const result = runSteps(serial, steps);
        allLogs.push({ attempt, ...result });

        if (!result.ok) {
          if (attempt < maxRetries) { sleep(retryDelay); continue; }
          res.json({ success: false, attempts: attempt, reason: result.reason, logs: allLogs });
          return;
        }

        if (verify?.text) {
          const timeout = Math.min(verify.timeout || 3000, 10000);
          const verified = verifyScreen(serial, verify.text, timeout);
          if (verified) {
            res.json({ success: true, verified: true, attempts: attempt, verifyText: verify.text, logs: allLogs });
            return;
          }
          if (attempt < maxRetries) { allLogs[allLogs.length - 1].verifyFailed = true; sleep(retryDelay); continue; }
          res.json({ success: false, verified: false, attempts: attempt, verifyText: verify.text, logs: allLogs });
          return;
        }

        const elements = getScreen(serial);
        const texts = elements.filter(e => e.text).map(e => e.text);
        res.json({ success: true, attempts: attempt, screen: texts, logs: allLogs });
        return;
      }
    } catch (error: any) {
      res.json({ success: false, error: error.message, logs: allLogs });
    }
  });

  return router;
}
