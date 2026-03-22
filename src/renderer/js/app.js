// === App: Navigation, Init, Version ===

// Navigation
function nav(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('p-' + page);
  if (target) target.classList.add('active');

  document.querySelectorAll('.sidebar-item[data-page]').forEach(item => {
    item.classList.toggle('active', item.dataset.page === page);
  });

  // Hub 페이지 진입 시 레지스트리 조회
  if (page === 'hub' && typeof refreshHub === 'function') {
    refreshHub();
  }
}

// Ctrl+K search focus
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    document.querySelector('.titlebar .search').focus();
  }
});

// Version display
window.mbot.getVersion().then(v => {
  document.getElementById('versionText').textContent = 'v' + v;
  document.getElementById('settingsVersion').textContent = v;
});

// Refresh all
async function refreshAll() {
  await refreshDevices();
  await onScanDevices();
}

// Auto-reconnect saved devices on startup
async function autoReconnect() {
  try {
    const result = await window.mbot.reconnectSavedDevices();
    if (result.total === 0) return;
    if (result.success.length > 0) {
      log('자동 재연결: ' + result.success.join(', '), 'success');
    }
    if (result.failed.length > 0) {
      log('재연결 실패 (USB 재연결 필요): ' + result.failed.join(', '), 'error');
    }
  } catch (e) {
    console.error('Auto-reconnect error:', e);
  }
}

// Event listeners
document.getElementById('scanBtn').addEventListener('click', onScanDevices);

// Boot sequence: reconnect → refresh → scan
autoReconnect().then(() => refreshAll());
