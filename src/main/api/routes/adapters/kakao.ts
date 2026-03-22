import { Router } from 'express';
import type { AdbManager } from '../../../adb/AdbManager.js';
import { getCenterPoint, type UiElement } from '../../../utils/uiParser.js';
import {
  adbShell, getScreen, tap, sleep, typeText,
  findAndTap, launchApp, waitForText,
  scrollUp, goBack,
} from '../helpers/appHelper.js';

const KAKAO_PKG = 'com.kakao.talk';

/**
 * Remote config (handler.js에서 내려받는 설정 오버라이드)
 * 카카오톡 버전 업데이트로 UI가 바뀔 때 앱 재빌드 없이 대응
 */
interface KakaoConfig {
  tabAliases: Record<string, string[]>;
  searchSignals: string[];
  chatRoomSignals: string[];
  toolbarTitleIds: string[];
}

const DEFAULT_CONFIG: KakaoConfig = {
  tabAliases: {
    friend: ['친구'],
    chat: ['채팅'],
    openchat: ['오픈채팅', '숏폼과 오픈채팅'],
    shopping: ['쇼핑'],
    more: ['더보기'],
  },
  searchSignals: ['최근 검색', '전체삭제', '자동저장 끄기'],
  chatRoomSignals: ['message_edit_text'],
  toolbarTitleIds: ['toolbar_main_title_text', 'toolbar_default_title', 'title_text'],
};

export function createKakaoRoutes(_adb: AdbManager, remoteConfig?: Partial<KakaoConfig>) {
  const router = Router();
  const config: KakaoConfig = { ...DEFAULT_CONFIG, ...remoteConfig };
  // Merge tabAliases deeply
  if (remoteConfig?.tabAliases) {
    for (const [key, values] of Object.entries(remoteConfig.tabAliases)) {
      const existing = new Set(config.tabAliases[key] || []);
      for (const v of values) existing.add(v);
      config.tabAliases[key] = [...existing];
    }
  }

  // ─── 화면 판별 유틸 ───

  /** sliding_tabs 하위 RelativeLayout에서 각 탭 정보 추출 */
  function parseTabs(elements: UiElement[]): { index: number; name: string; selected: boolean; bounds: [number, number, number, number] }[] {
    // sliding_tabs 컨테이너의 y좌표 범위 찾기
    const slidingTabs = elements.find(e => e.resourceId.includes('sliding_tabs') && !e.resourceId.includes('_bg'));
    if (!slidingTabs) return [];

    const tabY1 = slidingTabs.bounds[1];
    const tabY2 = slidingTabs.bounds[3];

    // sliding_tabs 영역 내의 RelativeLayout = 개별 탭
    const tabElements = elements.filter(e =>
      e.className.includes('RelativeLayout') &&
      e.bounds[1] >= tabY1 && e.bounds[3] <= tabY2 &&
      e.contentDesc // 탭에는 content-desc가 항상 있음
    );

    return tabElements.map((e, i) => ({
      index: i,
      name: e.contentDesc,
      selected: e.selected,
      bounds: e.bounds,
    }));
  }

  /** content-desc에서 탭 종류 판별 (aliases 사용) */
  function identifyTab(contentDesc: string): string {
    for (const [tabName, aliases] of Object.entries(config.tabAliases)) {
      if (aliases.some(alias => contentDesc.includes(alias))) {
        return tabName;
      }
    }
    return 'unknown';
  }

  /** 현재 선택된 탭 이름 반환 */
  function getActiveTab(elements: UiElement[]): string {
    const tabs = parseTabs(elements);
    const active = tabs.find(t => t.selected);
    if (!active) return 'unknown';
    return identifyTab(active.name);
  }

  /** toolbar_main_title_text의 텍스트 읽기 */
  function getToolbarTitle(elements: UiElement[]): string {
    for (const id of config.toolbarTitleIds) {
      const el = elements.find(e => e.resourceId.includes(id) && e.text);
      if (el) return el.text;
    }
    return '';
  }

  /** 현재 화면이 카카오톡 채팅방 내부인지 확인 */
  function isInChatRoom(elements: UiElement[]): boolean {
    return elements.some(e =>
      e.className.includes('EditText') &&
      config.chatRoomSignals.some(sig => e.resourceId.includes(sig))
    );
  }

  /** 현재 방 이름이 일치하는지 확인 */
  function isInTargetRoom(elements: UiElement[], roomName: string): boolean {
    return elements.some(e =>
      config.toolbarTitleIds.some(id => e.resourceId.includes(id)) &&
      (e.text.includes(roomName) || e.contentDesc.includes(roomName))
    );
  }

  /** 카카오톡 메인으로 이동 (채팅방이면 나가기) */
  function ensureMainScreen(serial: string): UiElement[] {
    launchApp(serial, KAKAO_PKG, 1500);
    let els = getScreen(serial);

    // 채팅방 안이면 나가기
    if (isInChatRoom(els)) {
      goBack(serial);
      sleep(500);
      els = getScreen(serial);
    }
    return els;
  }

  /** 특정 탭으로 이동 */
  function ensureTab(serial: string, tabName: string): UiElement[] {
    let elements = ensureMainScreen(serial);
    const currentTab = getActiveTab(elements);

    if (currentTab === tabName) return elements;

    // 탭 찾아서 탭
    const tabs = parseTabs(elements);
    const target = tabs.find(t => identifyTab(t.name) === tabName);
    if (target) {
      const center = getCenterPoint(target.bounds);
      tap(serial, center.x, center.y);
      sleep(800);
      elements = getScreen(serial);
    }
    return elements;
  }

  // ─── 현재 화면 상태 분석 ───

  function analyzeScreen(serial: string) {
    const elements = getScreen(serial);
    const pkg = elements.find(e => e.package === KAKAO_PKG);
    if (!pkg) {
      return { screen: 'not_kakao', activeTab: null, toolbarTitle: null, tabs: [] };
    }

    if (isInChatRoom(elements)) {
      const title = getToolbarTitle(elements);
      return { screen: 'chat_room', activeTab: null, toolbarTitle: title, roomName: title, tabs: [] };
    }

    const tabs = parseTabs(elements);
    const activeTabRaw = tabs.find(t => t.selected);
    const activeTab = activeTabRaw ? identifyTab(activeTabRaw.name) : 'unknown';
    const toolbarTitle = getToolbarTitle(elements);

    let screen: string;
    switch (activeTab) {
      case 'friend': screen = 'friend_list'; break;
      case 'chat': screen = 'chat_list'; break;
      case 'openchat': screen = 'openchat_list'; break;
      case 'shopping': screen = 'shopping'; break;
      case 'more': screen = 'more'; break;
      default: screen = 'kakao_main'; break;
    }

    return {
      screen,
      activeTab,
      toolbarTitle,
      tabs: tabs.map(t => ({
        index: t.index,
        type: identifyTab(t.name),
        rawDesc: t.name,
        selected: t.selected,
      })),
    };
  }

  // ─── API 라우트 ───

  /** GET /api/kakao/state — 현재 화면 상태 */
  router.get('/state', (req, res) => {
    const serial = req.query.serial as string;
    if (!serial) { res.status(400).json({ error: 'serial required' }); return; }
    try {
      res.json(analyzeScreen(serial));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** GET /api/kakao/config — 현재 설정 확인 */
  router.get('/config', (_req, res) => {
    res.json(config);
  });

  /** POST /api/kakao/open-room — 검색으로 방 열기 */
  router.post('/open-room', (req, res) => {
    const { serial, roomName } = req.body;
    if (!serial || !roomName) {
      res.status(400).json({ error: 'serial, roomName required' });
      return;
    }

    try {
      // 이미 해당 방에 있으면 skip
      const currentScreen = getScreen(serial);
      if (isInChatRoom(currentScreen) && isInTargetRoom(currentScreen, roomName)) {
        res.json({ status: 'ok', roomName, method: 'already_in_room' });
        return;
      }

      // 채팅 탭으로 이동
      ensureTab(serial, 'chat');

      // 검색 아이콘 탭
      let elements = getScreen(serial);
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
      sleep(1000);

      // 검색 결과에서 방 선택
      const result = findAndTap(serial, roomName);
      if (!result.found) {
        goBack(serial);
        res.status(404).json({ error: `Room "${roomName}" not found in search results` });
        return;
      }
      sleep(800);

      // 방 진입 확인
      elements = getScreen(serial);
      if (isInChatRoom(elements)) {
        res.json({ status: 'ok', roomName, method: 'search' });
      } else {
        res.status(500).json({ error: 'Room entered but chat input not found' });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** GET /api/kakao/rooms — 현재 탭의 방 목록 */
  router.get('/rooms', (req, res) => {
    const serial = req.query.serial as string;
    const tab = (req.query.tab as string) || 'chat';
    const scrollCount = Math.min(parseInt(req.query.scrollCount as string) || 0, 5);
    if (!serial) {
      res.status(400).json({ error: 'serial parameter required' });
      return;
    }

    try {
      // 요청된 탭으로 이동
      ensureTab(serial, tab);

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

      const activeTab = getActiveTab(getScreen(serial));
      res.json({ tab: activeTab, count: allRooms.length, rooms: allRooms });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** POST /api/kakao/read-thread — 채팅방 대화 수집 */
  router.post('/read-thread', (req, res) => {
    const { serial, scrollCount = 3, maxMessages = 100 } = req.body;
    if (!serial) {
      res.status(400).json({ error: 'serial required' });
      return;
    }

    try {
      const elements = getScreen(serial);
      if (!isInChatRoom(elements)) {
        res.status(400).json({ error: 'Not in a chat room. Use /api/kakao/open-room first.' });
        return;
      }

      const sc = Math.min(Math.max(Math.floor(scrollCount), 0), 20);
      const max = Math.min(Math.max(Math.floor(maxMessages), 1), 500);
      const allMessages: { sender: string; text: string; time: string }[] = [];
      const seen = new Set<string>();

      for (let i = 0; i < sc; i++) {
        scrollUp(serial, 800);
        sleep(500);
      }

      const totalScreens = sc + 1;
      for (let i = 0; i < totalScreens && allMessages.length < max; i++) {
        const screenEls = getScreen(serial);
        const messages = parseKakaoMessages(screenEls);

        for (const msg of messages) {
          const key = `${msg.sender}|${msg.text}|${msg.time}`;
          if (!seen.has(key)) {
            seen.add(key);
            allMessages.push(msg);
          }
        }

        if (i < totalScreens - 1) {
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

  /** POST /api/kakao/send-message — 방 이름 지정 메시지 전송 */
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
      // 1. 방 열기
      const currentScreen = getScreen(serial);
      const alreadyInRoom = isInChatRoom(currentScreen) && isInTargetRoom(currentScreen, roomName);

      if (!alreadyInRoom) {
        ensureTab(serial, 'chat');

        let elements = getScreen(serial);
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
        adbShell(serial, ['input', 'keyevent', '66']);
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

  return router;
}

// ─── 파서 유틸 (모듈 스코프) ───

function parseKakaoMessages(elements: UiElement[]): { sender: string; text: string; time: string }[] {
  const messages: { sender: string; text: string; time: string }[] = [];
  const timePattern = /^(오전|오후|AM|PM)\s*\d{1,2}:\d{2}$/;

  const chatArea = elements.filter(e => e.bounds[1] > 350 && e.bounds[3] < 1850);
  const excludeIds = ['notice', 'toolbar', 'send_button', 'emoticon', 'media_send',
    'scroll_down', 'message_edit_text', 'grammar', 'translation', 'chatbot', 'more',
    'expand_button', 'll_notice', 'content_text'];

  let lastSender = '나';
  const sorted = [...chatArea].sort((a, b) => a.bounds[1] - b.bounds[1]);

  for (const el of sorted) {
    if (excludeIds.some(id => el.resourceId.includes(id))) continue;
    if (el.resourceId.endsWith('nickname') && el.text) { lastSender = el.text; continue; }
    if (el.contentDesc.includes('프로필 보기')) continue;
    if (el.resourceId.includes('chat_forward') || el.contentDesc === '공유') continue;
    if (el.text && timePattern.test(el.text)) continue;

    if (el.contentDesc.startsWith('사진')) {
      messages.push({ sender: lastSender, text: `[${el.contentDesc}]`, time: '' });
      continue;
    }

    if (el.text && el.text.length > 0) {
      if (/^\d{1,2}$/.test(el.text)) continue;
      if (el.bounds[0] > 400) lastSender = '나';

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

function parseKakaoRooms(elements: UiElement[]): { name: string; lastMessage: string; time: string; unread: number }[] {
  const rooms: { name: string; lastMessage: string; time: string; unread: number }[] = [];
  const timePattern = /^(오전|오후|AM|PM|어제|월|화|수|목|금|토|일|\d{1,2}\/\d{1,2})/;
  const excludeTexts = new Set(['채팅', '친구', '더보기', '오픈채팅', '#', '+', '검색',
    '전체', '즐겨찾기', '숏폼', '폴더 설정']);

  const listElements = elements.filter(e =>
    e.text &&
    !excludeTexts.has(e.text) &&
    e.bounds[1] > 300 // 상단 toolbar + folder_tab 제외
  );

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
    if (group.length < 2) continue;

    const name = group[0]?.text || '';
    const time = group.find(e => timePattern.test(e.text))?.text || '';
    const unreadEl = group.find(e => /^\d+$/.test(e.text) && parseInt(e.text) > 0);
    const unread = unreadEl ? parseInt(unreadEl.text) : 0;
    const lastMessage = group.find(e =>
      e.text !== name && !timePattern.test(e.text) && !/^\d+$/.test(e.text)
    )?.text || '';

    if (name && name.length < 50) {
      rooms.push({ name, lastMessage, time, unread });
    }
  }

  return rooms;
}
