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

  /**
   * POST /api/sms/send — SMS 전송
   * ADB intent로 기본 문자 앱을 열고 전송까지 처리
   */
  router.post('/sms/send', async (req, res) => {
    const { serial, number, message } = req.body;
    if (!serial || !number || !message) {
      res.status(400).json({ error: 'serial, number, message required' });
      return;
    }
    if (typeof message !== 'string' || message.length > 1000) {
      res.status(400).json({ error: 'message must be string, max 1000 chars' });
      return;
    }

    try {
      const cleanNumber = sanitizePhoneNumber(number);

      // 1. 문자 앱 열기 (번호 + 본문 세팅)
      adbShell(serial, `am start -a android.intent.action.SENDTO -d sms:${cleanNumber}`);
      sleep(1000);

      // 2. 입력 필드 찾기
      const elements = getScreen(serial);
      const inputField = elements.find(e =>
        e.className.includes('EditText')
      );

      if (!inputField) {
        res.status(400).json({ error: 'SMS input field not found. Is the messaging app open?' });
        return;
      }

      // 3. 입력 필드 탭
      const center = getCenterPoint(inputField.bounds);
      tap(serial, center.x, center.y);
      sleep(300);

      // 4. 한글 포함 텍스트 입력 (클립보드 방식)
      // 폰 클립보드에 텍스트 설정 후 붙여넣기
      const escaped = message.replace(/'/g, "'\\''");
      adbShell(serial, `am broadcast -a clipper.set -e text '${escaped}'`);
      sleep(200);
      // ADBKeyboard 방식 (fallback)
      const base64 = Buffer.from(message, 'utf-8').toString('base64');
      adbShell(serial, `am broadcast -a ADB_INPUT_B64 --es msg '${base64}'`);
      sleep(500);

      // 5. 전송 버튼 찾기 + 탭
      const elements2 = getScreen(serial);
      const sendBtn = elements2.find(e =>
        e.contentDesc.includes('보내기') || e.contentDesc.includes('전송') || e.contentDesc.includes('Send') ||
        e.text === '전송' || e.text === '보내기' || e.text === 'Send' ||
        (e.resourceId.includes('send') && e.clickable)
      );

      if (sendBtn) {
        const sendCenter = getCenterPoint(sendBtn.bounds);
        tap(serial, sendCenter.x, sendCenter.y);
        sleep(500);

        // 6. 검증 — 메시지 앱에서 전송 확인
        const elements3 = getScreen(serial);
        const texts = elements3.filter(e => e.text).map(e => e.text);
        const sent = texts.some(t => t.includes(message.substring(0, 20)));

        res.json({ status: sent ? 'sent' : 'sent_unverified', number: cleanNumber, message });
      } else {
        // 전송 버튼 못 찾으면 Enter로 시도
        adbShell(serial, 'input keyevent 66');
        res.json({ status: 'sent_via_enter', number: cleanNumber, message });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

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

  /**
   * POST /api/do — 범용 액션 시퀀스 실행 + 검증
   *
   * 여러 단계를 원자적으로 실행하고 결과를 검증합니다.
   * 앱별 API 없이 어떤 앱이든 제어 가능.
   *
   * body: {
   *   serial: string,
   *   steps: [
   *     { action: "find", text: "내폰모음", tap: true },
   *     { action: "sleep", ms: 500 },
   *     { action: "find", text: "EditText", tap: true, by: "class" },
   *     { action: "type", text: "안녕하세요" },
   *     { action: "find", text: "전송", tap: true },
   *   ],
   *   verify?: { text: "안녕하세요", timeout?: 3000 },
   *   retry?: { count?: 3, delayMs?: 1000 }
   * }
   */
  // steps 실행 함수 (재시도에서 재사용)
  function runSteps(serial: string, steps: any[]) {
    const log: { step: number; action: string; result: string }[] = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      switch (step.action) {
        case 'find': {
          const elements = getScreen(serial);
          let found;
          if (step.by === 'class') {
            found = elements.find(e => e.className.includes(step.text));
          } else if (step.by === 'id') {
            found = elements.find(e => e.resourceId.includes(step.text));
          } else if (step.by === 'desc') {
            found = elements.find(e => e.contentDesc.includes(step.text));
          } else {
            found = findByText(elements, step.text);
          }
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
          const base64 = Buffer.from(step.text, 'utf-8').toString('base64');
          adbShell(serial, `am broadcast -a ADB_INPUT_B64 --es msg '${base64}'`);
          log.push({ step: i, action: 'type', result: step.text.substring(0, 30) });
          break;
        }
        case 'keyevent': {
          adbShell(serial, `input keyevent ${step.keycode || 66}`);
          log.push({ step: i, action: 'keyevent', result: `${step.keycode || 66}` });
          break;
        }
        case 'swipe': {
          const x1 = step.x1 || 540, y1 = step.y1 || 1500;
          const x2 = step.x2 || 540, y2 = step.y2 || 500;
          adbShell(serial, `input swipe ${x1} ${y1} ${x2} ${y2} ${step.duration || 300}`);
          log.push({ step: i, action: 'swipe', result: 'ok' });
          break;
        }
        case 'launch': {
          if (step.package) {
            adbShell(serial, `monkey -p ${step.package} -c android.intent.category.LAUNCHER 1`);
            log.push({ step: i, action: 'launch', result: step.package });
          }
          break;
        }
        case 'back': {
          adbShell(serial, 'input keyevent KEYCODE_BACK');
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

  // 화면 텍스트에서 verify.text 존재 확인
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
    if (steps.length > 20) {
      res.status(400).json({ error: 'max 20 steps' });
      return;
    }

    const maxRetries = Math.min(retry?.count || 1, 5);
    const retryDelay = Math.min(retry?.delayMs || 1000, 5000);
    const allLogs: any[] = [];

    try {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const result = runSteps(serial, steps);
        allLogs.push({ attempt, ...result });

        if (!result.ok) {
          // steps 실행 자체가 실패
          if (attempt < maxRetries) {
            sleep(retryDelay);
            continue;
          }
          res.json({ success: false, attempts: attempt, reason: result.reason, logs: allLogs });
          return;
        }

        // 검증
        if (verify?.text) {
          const timeout = Math.min(verify.timeout || 3000, 10000);
          const verified = verifyScreen(serial, verify.text, timeout);

          if (verified) {
            res.json({ success: true, verified: true, attempts: attempt, verifyText: verify.text, logs: allLogs });
            return;
          }

          // 검증 실패 → 재시도
          if (attempt < maxRetries) {
            allLogs[allLogs.length - 1].verifyFailed = true;
            sleep(retryDelay);
            continue;
          }

          // 최종 실패
          res.json({ success: false, verified: false, attempts: attempt, verifyText: verify.text, logs: allLogs });
          return;
        }

        // verify 없으면 성공으로 간주
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
