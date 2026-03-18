/**
 * Shell injection 방어 유틸리티
 * execSync에 전달되는 사용자 입력을 sanitize
 */

/** ADB serial 검증 (USB: hex, wireless: IP:port) */
export function sanitizeSerial(serial: string): string {
  if (!/^[a-zA-Z0-9._:\-]+$/.test(serial)) {
    throw new Error(`Invalid serial: ${serial}`);
  }
  return serial;
}

/** IP 주소 검증 */
export function sanitizeIP(ip: string): string {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
    throw new Error(`Invalid IP: ${ip}`);
  }
  return ip;
}

/** 포트 번호 검증 */
export function sanitizePort(port: number): number {
  const p = Math.floor(port);
  if (p < 1 || p > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }
  return p;
}

/** 좌표 검증 */
export function sanitizeCoord(val: number): number {
  const n = Math.floor(val);
  if (n < 0 || n > 10000) {
    throw new Error(`Invalid coordinate: ${val}`);
  }
  return n;
}

/** ADB shell 명령용 문자열 이스케이프 — 쉘 메타문자 제거 */
export function sanitizeShellArg(arg: string): string {
  // 쉘 메타문자 완전 제거: ; & | ` $ ( ) { } < > \ ! ~
  return arg.replace(/[;&|`$(){}\\<>!~\n\r]/g, '');
}

/** 패키지명 검증 (com.xxx.yyy 형태) */
export function sanitizePackage(pkg: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9_.]*$/.test(pkg)) {
    throw new Error(`Invalid package: ${pkg}`);
  }
  return pkg;
}

/** keyevent 코드 검증 (숫자 또는 KEYCODE_ 문자열) */
export function sanitizeKeycode(keycode: string | number): string {
  const s = String(keycode);
  if (!/^(KEYCODE_[A-Z0-9_]+|\d{1,3})$/.test(s)) {
    throw new Error(`Invalid keycode: ${keycode}`);
  }
  return s;
}

/** 전화번호 검증 */
export function sanitizePhoneNumber(number: string): string {
  const clean = number.replace(/[^0-9+\-]/g, '');
  if (clean.length < 3 || clean.length > 20) {
    throw new Error(`Invalid phone number: ${number}`);
  }
  return clean;
}

/** 페어링 코드 검증 (6자리 숫자) */
export function sanitizePairingCode(code: string): string {
  if (!/^\d{6}$/.test(code)) {
    throw new Error(`Invalid pairing code: ${code}`);
  }
  return code;
}
