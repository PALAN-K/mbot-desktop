// === Adapter Management UI ===
const sidebarAdapters = document.getElementById('sidebarAdapters');
const adapterRows = document.getElementById('adapterRows');

const hubFeatured = document.querySelector('.hub-featured');
const hubCategories = document.getElementById('hubCategories');

let installedAdapters = [];
let registryAdapters = [];

const ADAPTER_CDN = 'https://palank.co.kr';

/** 아이콘 렌더링: URL이면 <img>, 이모지면 텍스트 */
function renderIcon(icon, size) {
  size = size || 20;
  if (icon && (icon.startsWith('/') || icon.startsWith('http'))) {
    const url = icon.startsWith('/') ? ADAPTER_CDN + icon : icon;
    return '<img src="' + url + '" width="' + size + '" height="' + size + '" style="border-radius:4px;">';
  }
  return '<span style="font-size:' + size + 'px;">' + (icon || '📦') + '</span>';
}

// === Installed Adapters (사이드바 + Adapters 페이지) ===
async function refreshAdapters() {
  installedAdapters = await window.mbot.listAdapters();

  // Sidebar
  sidebarAdapters.innerHTML = '';
  for (const adapter of installedAdapters) {
    const item = document.createElement('div');
    item.className = 'sidebar-item';
    item.onclick = () => nav('adapters');
    item.innerHTML =
      '<span class="s-icon">' + renderIcon(adapter.icon, 18) + '</span> ' + adapter.name +
      '<span class="dot ' + (adapter.status === 'running' ? 'on' : 'off') + '"></span>';
    sidebarAdapters.appendChild(item);
  }

  // Adapters page table
  if (installedAdapters.length === 0) {
    adapterRows.innerHTML =
      '<div style="padding:32px;text-align:center;color:#8b949e;font-size:13px;">' +
      '설치된 어댑터가 없습니다. Adapter Hub에서 설치하세요.</div>';
    return;
  }

  adapterRows.innerHTML = '';
  for (const adapter of installedAdapters) {
    const row = document.createElement('div');
    row.className = 'at-row';
    const isRunning = adapter.status === 'running';
    row.innerHTML =
      '<span class="icon">' + renderIcon(adapter.icon, 24) + '</span>' +
      '<span class="name">' + adapter.name + '<small>' + adapter.description + '</small></span>' +
      '<span class="status"><span class="dot ' + (isRunning ? 'running' : 'stopped') + '"></span> ' +
        (isRunning ? 'Running' : 'Stopped') + '</span>' +
      '<span class="target">-</span>' +
      '<span style="font-size:12px;color:#8b949e;">v' + adapter.version + '</span>';
    adapterRows.appendChild(row);
  }
}

// === Hub 페이지: 레지스트리에서 어댑터 목록 로드 ===
async function refreshHub() {
  registryAdapters = await window.mbot.fetchRegistry();
  installedAdapters = await window.mbot.listAdapters();
  const installedIds = new Set(installedAdapters.map(a => a.id));

  if (!hubCategories) return;

  // Featured
  if (hubFeatured) {
    hubFeatured.innerHTML = '';
    const featured = registryAdapters.filter(a => a.featured);
    for (const adapter of featured) {
      const card = document.createElement('div');
      card.className = 'featured-card';
      card.innerHTML =
        '<div class="fc-label">Featured</div>' +
        '<div class="fc-title">' + renderIcon(adapter.icon, 24) + ' ' + adapter.name + '</div>' +
        '<div class="fc-desc">' + adapter.description + '</div>';
      hubFeatured.appendChild(card);
    }
    const comingSoon = registryAdapters.filter(a => a.comingSoon);
    for (const adapter of comingSoon.slice(0, 2)) {
      const card = document.createElement('div');
      card.className = 'featured-card';
      card.innerHTML =
        '<div class="fc-label">Coming Soon</div>' +
        '<div class="fc-title">' + renderIcon(adapter.icon, 24) + ' ' + adapter.name + '</div>' +
        '<div class="fc-desc">' + adapter.description + '</div>';
      hubFeatured.appendChild(card);
    }
  }

  // Categories
  const categories = {};
  for (const adapter of registryAdapters) {
    const cat = adapter.category || 'other';
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(adapter);
  }

  const catNames = { messaging: '메시징', commerce: '커머스', content: '콘텐츠', other: '기타' };

  hubCategories.innerHTML = '';
  for (const [cat, adapters] of Object.entries(categories)) {
    const section = document.createElement('div');
    section.style.marginBottom = '24px';
    section.innerHTML = '<h3 style="font-size:15px;font-weight:600;color:#1a1a2e;margin-bottom:12px;">' +
      (catNames[cat] || cat) + '</h3>';

    const row = document.createElement('div');
    row.className = 'adapter-row';

    for (const adapter of adapters) {
      const isInstalled = installedIds.has(adapter.id);
      const isComingSoon = adapter.comingSoon;

      const card = document.createElement('div');
      card.className = 'hub-card';
      card.innerHTML =
        '<div class="hub-icon" style="background:#f0f3f6;display:flex;align-items:center;justify-content:center;">' +
          renderIcon(adapter.icon, 28) +
        '</div>' +
        '<div class="hub-info">' +
          '<div class="name">' + adapter.name + '</div>' +
          '<div class="desc">' + adapter.description + '</div>' +
          '<div class="stats">' +
            '<span>' + adapter.author + '</span>' +
            '<span>' + (isComingSoon ? 'Coming Soon' : 'v' + adapter.version) + '</span>' +
          '</div>' +
          '<div style="margin-top:8px;">' +
            (isComingSoon
              ? '<button class="btn" disabled style="opacity:0.4;">준비 중</button>'
              : isInstalled
                ? '<button class="btn" disabled>설치됨</button>'
                : '<button class="btn-primary" onclick="onInstallAdapter(\'' + adapter.id + '\', this)">설치</button>'
            ) +
          '</div>' +
        '</div>';
      row.appendChild(card);
    }

    section.appendChild(row);
    hubCategories.appendChild(section);
  }
}

// === 설치 버튼 클릭 ===
async function onInstallAdapter(adapterId, btn) {
  btn.disabled = true;
  btn.textContent = '설치 중...';

  try {
    const result = await window.mbot.installAdapter(adapterId);
    if (result.success) {
      btn.textContent = '설치됨';
      btn.className = 'btn';
      log(adapterId + ' 어댑터 설치 완료', 'success');
      await refreshAdapters();
      await refreshHub();
    } else {
      btn.textContent = '실패';
      btn.disabled = false;
      log('어댑터 설치 실패: ' + (result.error || 'unknown'), 'error');
      setTimeout(() => { btn.textContent = '설치'; btn.className = 'btn-primary'; }, 2000);
    }
  } catch (e) {
    btn.textContent = '오류';
    btn.disabled = false;
    log('어댑터 설치 오류', 'error');
  }
}

// 초기 로드
refreshAdapters();
