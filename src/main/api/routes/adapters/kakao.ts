import { Router } from 'express';
import type { AdbManager } from '../../../adb/AdbManager.js';
import { parseUiDump, findByText, getCenterPoint, type UiElement } from '../../../utils/uiParser.js';
import {
  adbShell, getScreen, tap, sleep, typeText,
  findAndTap, launchApp, waitForText, dismissPopups,
  scrollUp, goBack,
} from '../helpers/appHelper.js';

const KAKAO_PKG = 'com.kakao.talk';

export function createKakaoRoutes(_adb: AdbManager) {
  const router = Router();

  /** 현재 화면이 카카오톡 채팅방 내부인지 확인 */
  function isInChatRoom(elements: UiElement[]): boolean {
    return elements.some(e =>
      e.className.includes('EditText') &&
      e.resourceId.includes('message_edit_text')
    );
  }

  /** 현재 방 이름이 일치하는지 확인 (toolbar title의 text 또는 contentDesc) */
  function isInTargetRoom(elements: UiElement[], roomName: string): boolean {
    return elements.some(e =>
      (e.resourceId.includes('toolbar_default_title') || e.resourceId.includes('title_text')) &&
      (e.text.includes(roomName) || e.contentDesc.includes(roomName))
    );
  }

  /** 카카오톡 채팅 탭으로 이동 */
  function ensureChatTab(serial: string): void {
    launchApp(serial, KAKAO_PKG, 1500);

    // 이미 채팅방 안이면 먼저 나가기
    const els = getScreen(serial);
    if (isInChatRoom(els)) {
      goBack(serial);
      sleep(500);
    }

    // 채팅 탭 확인 — 하단 네비게이션에서 "채팅" 탭 탐색
    const elements = getScreen(serial);
    const chatTab = elements.find(e =>
      e.contentDesc === '채팅' || e.text === '채팅'
    );
    if (chatTab) {
      const center = getCenterPoint(chatTab.bounds);
      tap(serial, center.x, center.y);
      sleep(500);
    }
    // 채팅 탭을 못 찾아도 이미 채팅 목록일 수 있으므로 계속 진행
  }

  /**
   * POST /api/kakao/open-room — 특정 채팅방 열기
   *
   * body: { serial, roomName }
   * 동작: 카카오톡 → 검색 → 방 이름 입력 → 방 진입
   */
  router.post('/open-room', (req, res) => {
    const { serial, roomName } = req.body;
    if (!serial || !roomName) {
      res.status(400).json({ error: 'serial, roomName required' });
      return;
    }

    try {
      // 이미 해당 방에 있는지 확인
      const currentScreen = getScreen(serial);
      if (isInChatRoom(currentScreen) && isInTargetRoom(currentScreen, roomName)) {
        res.json({ status: 'ok', roomName, method: 'already_in_room' });
        return;
      }

      ensureChatTab(serial);

      // 검색 아이콘 탭 (돋보기)
      const elements = getScreen(serial);
      const searchBtn = elements.find(e =>
        e.contentDesc.includes('검색') || e.contentDesc.includes('Search') ||
        e.resourceId.includes('search')
      );
      if (searchBtn) {
        const center = getCenterPoint(searchBtn.bounds);
        tap(serial, center.x, center.y);
        sleep(500);
      }

      // 검색 입력창에 방 이름 입력
      const searchInput = findAndTap(serial, 'EditText', { by: 'class' });
      if (!searchInput.found) {
        res.status(500).json({ error: 'Search input not found' });
        return;
      }
      sleep(200);
      typeText(serial, roomName);
      sleep(1000); // 검색 결과 로딩 대기

      // 검색 결과에서 방 선택
      const result = findAndTap(serial, roomName);
      if (!result.found) {
        // 뒤로가기로 검색 해제
        goBack(serial);
        res.status(404).json({ error: `Room "${roomName}" not found` });
        return;
      }
      sleep(800);

      // 방 진입 확인
      if (isInChatRoom(serial)) {
        res.json({ status: 'ok', roomName, method: 'search' });
      } else {
        res.status(500).json({ error: 'Room entered but chat input not found' });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/kakao/read-thread — 채팅방 대화 스크롤 수집
   *
   * body: { serial, scrollCount?: 3, maxMessages?: 100 }
   * 응답: { count, messages: [{ sender, text, time }] }
   */
  router.post('/read-thread', (req, res) => {
    const { serial, scrollCount = 3, maxMessages = 100 } = req.body;
    if (!serial) {
      res.status(400).json({ error: 'serial required' });
      return;
    }

    try {
      if (!isInChatRoom(getScreen(serial))) {
        res.status(400).json({ error: 'Not in a chat room. Use /api/kakao/open-room first.' });
        return;
      }

      const sc = Math.min(Math.max(Math.floor(scrollCount), 0), 20);
      const max = Math.min(Math.max(Math.floor(maxMessages), 1), 500);
      const allMessages: { sender: string; text: string; time: string }[] = [];
      const seen = new Set<string>();

      // 먼저 위로 스크롤해서 이전 메시지 로딩, 그 다음 아래로 읽기
      for (let i = 0; i < sc; i++) {
        scrollUp(serial, 800);
        sleep(500);
      }

      // 스크롤 다운하면서 메시지 수집
      const totalScreens = sc + 1;
      for (let i = 0; i < totalScreens && allMessages.length < max; i++) {
        const elements = getScreen(serial);
        const messages = parseKakaoMessages(elements);

        for (const msg of messages) {
          const key = `${msg.sender}|${msg.text}|${msg.time}`;
          if (!seen.has(key)) {
            seen.add(key);
            allMessages.push(msg);
          }
        }

        if (i < totalScreens - 1) {
          // 아래로 스크롤하여 다음 화면
          adbShell(serial, ['input', 'swipe', '540', '1500', '540', '700', '300']);
          sleep(500);
        }
      }

      res.json({
        count: Math.min(allMessages.length, max),
        messages: allMessages.slice(0, max),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/kakao/send-message — 방 이름 지정 메시지 전송 (원자적)
   *
   * body: { serial, roomName, message }
   * 응답: { status, roomName, message, verified }
   */
  router.post('/send-message', (req, res) => {
    const { serial, roomName, message } = req.body;
    if (!serial || !roomName || !message) {
      res.status(400).json({ error: 'serial, roomName, message required' });
      return;
    }
    if (typeof message !== 'string' || message.length > 2000) {
      res.status(400).json({ error: 'message must be string, max 2000 chars' });
      return;
    }

    try {
      // 1. 방 열기 — 이미 맞는 방이면 skip
      const currentScreen = getScreen(serial);
      const alreadyInRoom = isInChatRoom(currentScreen) && isInTargetRoom(currentScreen, roomName);

      if (!alreadyInRoom) {
        // open-room 로직 인라인
        ensureChatTab(serial);

        const elements = getScreen(serial);
        const searchBtn = elements.find(e =>
          e.contentDesc.includes('검색') || e.resourceId.includes('search')
        );
        if (searchBtn) {
          tap(serial, getCenterPoint(searchBtn.bounds).x, getCenterPoint(searchBtn.bounds).y);
          sleep(500);
        }

        findAndTap(serial, 'EditText', { by: 'class' });
        sleep(200);
        typeText(serial, roomName);
        sleep(1000);

        const found = findAndTap(serial, roomName);
        if (!found.found) {
          goBack(serial);
          res.status(404).json({ error: `Room "${roomName}" not found` });
          return;
        }
        sleep(800);
      }

      // 2. 입력창 포커스
      const chatElements = getScreen(serial);
      const inputField = chatElements.find(e =>
        e.className.includes('EditText') &&
        (e.resourceId.includes('message_edit_text') || e.package === KAKAO_PKG)
      );
      if (inputField) {
        tap(serial, getCenterPoint(inputField.bounds).x, getCenterPoint(inputField.bounds).y);
      }
      sleep(300);

      // 3. 메시지 입력
      typeText(serial, message);
      sleep(300);

      // 4. 전송
      const elements2 = getScreen(serial);
      const sendBtn = elements2.find(e =>
        e.resourceId.includes('send') ||
        e.contentDesc.includes('전송') ||
        e.text === '전송'
      );
      if (sendBtn) {
        tap(serial, getCenterPoint(sendBtn.bounds).x, getCenterPoint(sendBtn.bounds).y);
      } else {
        adbShell(serial, ['input', 'keyevent', '66']); // Enter fallback
      }
      sleep(500);

      // 5. 검증
      const snippet = message.substring(0, 20);
      const verified = waitForText(serial, snippet, 3000);

      res.json({
        status: verified ? 'sent' : 'sent_unverified',
        roomName,
        message,
        verified,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/kakao/rooms — 최근 채팅방 목록 조회
   *
   * query: serial, scrollCount? (default 0)
   * 응답: { rooms: [{ name, lastMessage, time, unread }] }
   */
  router.get('/rooms', (req, res) => {
    const serial = req.query.serial as string;
    const scrollCount = Math.min(parseInt(req.query.scrollCount as string) || 0, 5);
    if (!serial) {
      res.status(400).json({ error: 'serial parameter required' });
      return;
    }

    try {
      ensureChatTab(serial);

      const allRooms: { name: string; lastMessage: string; time: string; unread: number }[] = [];
      const seen = new Set<string>();

      for (let i = 0; i <= scrollCount; i++) {
        const elements = getScreen(serial);
        const rooms = parseKakaoRooms(elements);

        for (const room of rooms) {
          if (!seen.has(room.name)) {
            seen.add(room.name);
            allRooms.push(room);
          }
        }

        if (i < scrollCount) {
          adbShell(serial, ['input', 'swipe', '540', '1500', '540', '500', '300']);
          sleep(800);
        }
      }

      res.json({ count: allRooms.length, rooms: allRooms });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

/**
 * 카카오톡 채팅 메시지 파싱 (resourceId 기반)
 *
 * 카카오톡 실제 UI 구조 (uiautomator dump 기반):
 * - 발신자 이름: resourceId 끝이 "nickname", text에 이름
 * - 메시지 텍스트: text에 내용, resourceId 없음, className=TextView
 * - 사진 메시지: contentDesc="사진" 또는 "사진, 1/2" 등
 * - 시간: 작은 텍스트 (오후/오전 X:XX)
 * - 내 메시지: 왼쪽 x좌표가 화면 중앙 이상 (오른쪽 정렬)
 * - 공지/프로필/검색 등 UI 요소는 resourceId로 구분
 */
function parseKakaoMessages(elements: UiElement[]): { sender: string; text: string; time: string }[] {
  const messages: { sender: string; text: string; time: string }[] = [];
  const timePattern = /^(오전|오후|AM|PM)\s*\d{1,2}:\d{2}$/;

  // UI 영역 필터: 상단 네비(~200) / 하단 입력창(~1850) 제외
  const chatArea = elements.filter(e => e.bounds[1] > 350 && e.bounds[3] < 1850);

  // resourceId로 제외할 요소
  const excludeIds = ['notice', 'toolbar', 'send_button', 'emoticon', 'media_send',
    'scroll_down', 'message_edit_text', 'grammar', 'translation', 'chatbot', 'more',
    'expand_button', 'll_notice', 'content_text'];

  let lastSender = '나';

  // y좌표 순서로 순회
  const sorted = [...chatArea].sort((a, b) => a.bounds[1] - b.bounds[1]);

  for (const el of sorted) {
    // resourceId로 UI 요소 제외
    if (excludeIds.some(id => el.resourceId.includes(id))) continue;

    // 프로필 버튼 옆의 닉네임 (다음 메시지의 발신자)
    if (el.resourceId.endsWith('nickname') && el.text) {
      lastSender = el.text;
      continue;
    }

    // 프로필 보기 버튼 skip
    if (el.contentDesc.includes('프로필 보기')) continue;

    // 공유 버튼 skip
    if (el.resourceId.includes('chat_forward') || el.contentDesc === '공유') continue;

    // 시간 텍스트 skip (별도 추출)
    if (el.text && timePattern.test(el.text)) continue;

    // 사진 메시지
    if (el.contentDesc.startsWith('사진')) {
      messages.push({ sender: lastSender, text: `[${el.contentDesc}]`, time: '' });
      continue;
    }

    // 텍스트 메시지: text가 있고 의미있는 내용
    if (el.text && el.text.length > 0) {
      // 너무 짧고 숫자만인 건 읽음 표시일 수 있음
      if (/^\d{1,2}$/.test(el.text)) continue;

      // 오른쪽 정렬이면 내 메시지
      if (el.bounds[0] > 400) {
        lastSender = '나';
      }

      // 가장 가까운 시간 찾기
      const time = chatArea
        .filter(t => t.text && timePattern.test(t.text))
        .reduce<{ text: string; dist: number }>(
          (best, t) => {
            const dist = Math.abs(t.bounds[1] - el.bounds[1]);
            return dist < best.dist ? { text: t.text, dist } : best;
          },
          { text: '', dist: 9999 }
        ).text;

      messages.push({ sender: lastSender, text: el.text, time });
    }
  }

  return messages;
}

/**
 * 카카오톡 채팅방 목록 파싱
 *
 * 채팅 목록 UI 구조:
 * - 방 이름: 볼드 텍스트
 * - 마지막 메시지: 회색 텍스트
 * - 시간: 작은 텍스트
 * - 안읽음 수: 빨간 배지 숫자
 */
function parseKakaoRooms(elements: UiElement[]): { name: string; lastMessage: string; time: string; unread: number }[] {
  const rooms: { name: string; lastMessage: string; time: string; unread: number }[] = [];
  const timePattern = /^(오전|오후|AM|PM|어제|월|화|수|목|금|토|일|\d{1,2}\/\d{1,2})/;
  const excludeTexts = new Set(['채팅', '친구', '더보기', '오픈채팅', '#', '+', '검색']);

  // 목록 요소를 y좌표 순서로 그룹화
  const listElements = elements.filter(e =>
    e.text &&
    !excludeTexts.has(e.text) &&
    e.bounds[1] > 200 // 상단 네비 제외
  );

  // 연속된 요소를 y 근접도로 그룹화 (같은 행 = 같은 방)
  const groups: UiElement[][] = [];
  let currentGroup: UiElement[] = [];
  let lastY = -1;

  for (const el of listElements) {
    const y = el.bounds[1];
    if (lastY >= 0 && Math.abs(y - lastY) > 100) {
      if (currentGroup.length > 0) groups.push(currentGroup);
      currentGroup = [];
    }
    currentGroup.push(el);
    lastY = y;
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  for (const group of groups) {
    if (group.length < 2) continue; // 최소 이름 + 메시지

    const name = group[0]?.text || '';
    const time = group.find(e => timePattern.test(e.text))?.text || '';
    const unreadEl = group.find(e => /^\d+$/.test(e.text) && parseInt(e.text) > 0);
    const unread = unreadEl ? parseInt(unreadEl.text) : 0;

    // 마지막 메시지: 이름/시간/안읽음이 아닌 텍스트
    const lastMessage = group.find(e =>
      e.text !== name &&
      !timePattern.test(e.text) &&
      !/^\d+$/.test(e.text)
    )?.text || '';

    if (name && name.length < 50) {
      rooms.push({ name, lastMessage, time, unread });
    }
  }

  return rooms;
}
