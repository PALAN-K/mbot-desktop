import { execFileSync } from 'child_process';
import { parseUiDump, findByText, getCenterPoint, type UiElement } from '../../../utils/uiParser.js';
import { sanitizeSerial, sanitizeCoord } from '../../../utils/sanitize.js';

/** ADB shell 명령 실행 — execFileSync로 cmd.exe 우회 */
export function adbShell(serial: string, cmdArgs: string[], timeoutMs = 5000): string {
  const s = sanitizeSerial(serial);
  return execFileSync('adb', ['-s', s, 'shell', ...cmdArgs], {
    timeout: timeoutMs,
    encoding: 'utf-8',
  }).trim();
}

/** UI dump → 파싱된 요소 배열 — Buffer로 받아 UTF-8 명시 디코딩 */
export function getScreen(serial: string): UiElement[] {
  const s = sanitizeSerial(serial);
  const buf = execFileSync('adb', ['-s', s, 'exec-out', 'uiautomator', 'dump', '/dev/tty'], {
    timeout: 10000,
  });
  const xml = Buffer.isBuffer(buf) ? buf.toString('utf-8') : String(buf);
  return parseUiDump(xml);
}

/** 좌표 탭 */
export function tap(serial: string, x: number, y: number): void {
  adbShell(serial, ['input', 'tap', String(sanitizeCoord(x)), String(sanitizeCoord(y))]);
}

/** 동기 대기 */
export function sleep(ms: number): void {
  const clamped = Math.min(Math.max(ms, 50), 10000);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, clamped);
}

/** 텍스트 입력 — ASCII는 input text, 비ASCII는 ClipboardReceiver(b64) + PASTE */
export function typeText(serial: string, text: string): void {
  const isAsciiOnly = /^[\x20-\x7E]*$/.test(text);
  if (isAsciiOnly) {
    const clean = text.replace(/ /g, '%s');
    adbShell(serial, ['input', 'text', clean]);
  } else {
    const b64 = Buffer.from(text, 'utf-8').toString('base64');
    adbShell(serial, [
      'am', 'broadcast',
      '-a', 'com.palank.mbot.action.CLIPBOARD_SET',
      '-n', 'com.palank.mbot/.receiver.ClipboardReceiver',
      '--es', 'b64', b64,
    ]);
    adbShell(serial, ['input', 'keyevent', '279']);
  }
}

/** 텍스트 찾기 + 탭 (옵션) — 결과 반환 */
export function findAndTap(
  serial: string,
  text: string,
  opts: { tap?: boolean; by?: 'text' | 'class' | 'id' | 'desc' } = {}
): { found: boolean; element?: UiElement; center?: { x: number; y: number } } {
  const elements = getScreen(serial);
  let el: UiElement | undefined;

  if (opts.by === 'class') {
    el = elements.find(e => e.className.includes(text));
  } else if (opts.by === 'id') {
    el = elements.find(e => e.resourceId.includes(text));
  } else if (opts.by === 'desc') {
    el = elements.find(e => e.contentDesc.includes(text));
  } else {
    el = findByText(elements, text) || undefined;
  }

  if (!el) return { found: false };

  const center = getCenterPoint(el.bounds);
  if (opts.tap !== false) {
    tap(serial, center.x, center.y);
  }

  return { found: true, element: el, center };
}

/** 앱 실행 + 로딩 대기 */
export function launchApp(serial: string, pkg: string, waitMs = 1000): void {
  adbShell(serial, ['monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
  sleep(waitMs);
}

/** 특정 텍스트가 화면에 나타날 때까지 대기 */
export function waitForText(serial: string, text: string, timeoutMs = 5000): boolean {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const elements = getScreen(serial);
    if (elements.some(e => e.text.includes(text) || e.contentDesc.includes(text))) {
      return true;
    }
    sleep(500);
  }
  return false;
}

/** 알려진 팝업 자동 닫기 */
export function dismissPopups(serial: string, dismissTexts: string[] = ['확인', '닫기', '다음에', '취소', 'OK', 'Close']): boolean {
  const elements = getScreen(serial);
  for (const text of dismissTexts) {
    const btn = findByText(elements, text);
    if (btn && btn.clickable) {
      const center = getCenterPoint(btn.bounds);
      tap(serial, center.x, center.y);
      sleep(300);
      return true;
    }
  }
  return false;
}

/** 아래로 스크롤 */
export function scrollDown(serial: string, distance = 1000): void {
  adbShell(serial, ['input', 'swipe', '540', '1500', '540', String(1500 - distance), '300']);
}

/** 위로 스크롤 */
export function scrollUp(serial: string, distance = 1000): void {
  adbShell(serial, ['input', 'swipe', '540', '500', '540', String(500 + distance), '300']);
}

/** 뒤로가기 */
export function goBack(serial: string): void {
  adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
}
