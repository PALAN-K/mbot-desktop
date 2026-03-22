// === Device Management ===
const grid = document.getElementById('deviceGrid');
const emptyState = document.getElementById('emptyState');
const connectedLabel = document.getElementById('connectedLabel');
const sidebarDeviceCount = document.getElementById('sidebarDeviceCount');

const originalTimeouts = {};
let connectedSerials = new Set();

// === Onboarding ===
let onboardingDismissed = localStorage.getItem('onboardingDone') === '1';

function switchGuideTab(tab, btn) {
  document.querySelectorAll('.guide-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('guideWireless').style.display = tab === 'wireless' ? 'block' : 'none';
  document.getElementById('guideUsb').style.display = tab === 'usb' ? 'block' : 'none';
}

function closeOnboarding() {
  onboardingDismissed = true;
  localStorage.setItem('onboardingDone', '1');
  emptyState.style.display = 'none';
  refreshAll();
}

// === Mirror ===
async function onMirror(serial) {
  log('미러링 시작 중...');
  try {
    const ok = await window.mbot.startMirror(serial);
    log(ok ? '미러링 시작됨' : '미러링 실패', ok ? 'success' : 'error');
  } catch (e) {
    log('미러링 오류: ' + e.message, 'error');
  }
}

// === Stability ===
async function onStability(serial) {
  try {
    const result = await window.mbot.setupStability(serial);
    originalTimeouts[serial] = result.originalTimeout;
    const ok = result.stayAwake && result.stayOnPlugged;
    log('안정성 설정: ' + (ok ? '완료' : '일부 적용'), ok ? 'success' : 'entry');
  } catch (e) {
    log('안정성 설정 오류', 'error');
  }
}

// === Go Wireless ===
async function onGoWireless(serial) {
  log('무선 전환 중...');
  try {
    const result = await window.mbot.enableWireless(serial);
    if (result) {
      log('무선 연결 완료 (' + result.ip + ') — USB 분리 가능', 'success');
      setTimeout(refreshAll, 2000);
    } else {
      log('Wi-Fi 연결을 확인하세요', 'error');
    }
  } catch (e) {
    log('무선 전환 오류', 'error');
  }
}

// === Restore ===
async function onRestore(serial) {
  const timeout = originalTimeouts[serial] || '60000';
  try {
    await window.mbot.restoreStability(serial, timeout);
    log('설정 복원 완료', 'success');
  } catch (e) {
    log('설정 복원 실패', 'error');
  }
}

// === Forget ===
async function onForgetDevice(serial) {
  try {
    await window.mbot.forgetDevice(serial);
    log(serial + ' 연결 해제 완료', 'success');
  } catch (e) {
    log('연결 해제 실패', 'error');
  }
  refreshAll();
}

// === Mirror + Stability combo ===
async function onMirrorWithStability(serial) {
  await onStability(serial);
  await onMirror(serial);
}

// === Device List ===
async function refreshDevices() {
  const devices = await window.mbot.listDevices();
  connectedSerials = new Set(devices.map(d => d.serial));

  // Sidebar badge
  if (devices.length > 0) {
    sidebarDeviceCount.textContent = devices.length;
    sidebarDeviceCount.style.display = '';
  } else {
    sidebarDeviceCount.style.display = 'none';
  }

  if (devices.length === 0) {
    grid.style.display = 'none';
    connectedLabel.style.display = 'none';
    emptyState.style.display = 'block';
    return;
  }
  emptyState.style.display = 'none';

  grid.style.display = 'grid';
  connectedLabel.style.display = 'flex';
  grid.innerHTML = '';

  for (const device of devices) {
    const info = await window.mbot.getDeviceInfo(device.serial);
    const isWireless = device.serial.includes(':');
    const name = info?.model || device.serial;
    const android = info?.androidVersion || '?';

    const card = document.createElement('div');
    card.className = 'device-card';
    card.innerHTML =
      '<div class="device-header">' +
        '<div class="device-name">' + name + '</div>' +
        '<span class="device-status ' + (isWireless ? 'status-wireless' : 'status-connected') + '">' +
          (isWireless ? '무선' : 'USB') +
        '</span>' +
      '</div>' +
      '<div class="device-meta">' +
        'Android ' + android +
        (isWireless ? ' <span>&middot; ' + device.serial.split(':')[0] + '</span>' : '') +
      '</div>' +
      '<div class="device-actions">' +
        '<button class="btn-primary" onclick="onMirrorWithStability(\'' + device.serial + '\')">미러링</button>' +
        (!isWireless ? '<button class="btn" onclick="onGoWireless(\'' + device.serial + '\')">무선 전환</button>' : '') +
        (isWireless ? '<button class="btn" onclick="onForgetDevice(\'' + device.serial + '\')">연결 해제</button>' : '') +
        '<button class="btn" onclick="onRestore(\'' + device.serial + '\')">설정 복원</button>' +
      '</div>';
    grid.appendChild(card);
  }

  // Settings: saved count
  try {
    const saved = await window.mbot.getSavedDevices();
    document.getElementById('settingsSavedCount').textContent = Object.keys(saved).length + '대';
  } catch(e) {}
}
