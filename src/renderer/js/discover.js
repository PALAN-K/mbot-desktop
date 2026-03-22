// === Nearby Device Discovery & Pairing ===
const discoverGrid = document.getElementById('discoverGrid');

async function onScanDevices() {
  discoverGrid.innerHTML = '<div class="discover-empty">검색 중...</div>';
  try {
    const discovered = await window.mbot.discoverDevices();
    const newDevices = discovered.filter(dev => {
      const serial = dev.name.replace('adb-', '');
      return !connectedSerials.has(serial) && !connectedSerials.has(dev.ip + ':' + dev.port);
    });

    if (newDevices.length === 0) {
      const msg = discovered.length > 0
        ? '주변 기기가 모두 연결되어 있습니다.'
        : '기기를 찾을 수 없습니다. 무선 디버깅이 켜져 있는지 확인하세요.';
      discoverGrid.innerHTML = '<div class="discover-empty">' + msg + '</div>';
      return;
    }

    discoverGrid.innerHTML = '';
    for (const dev of newDevices) {
      const displayName = dev.name.replace('adb-', '').substring(0, 16);
      const isTls = dev.service.includes('tls-connect');
      const cardId = 'card-' + dev.name.replace(/[^a-zA-Z0-9]/g, '');
      const card = document.createElement('div');
      card.className = 'discover-card';
      card.id = cardId;
      card.innerHTML =
        '<div class="discover-info">' +
          '<h4>' + displayName + '</h4>' +
          '<p>' + dev.ip + (isTls ? ' &middot; Android 11+' : '') + '</p>' +
        '</div>' +
        '<button class="btn-primary" onclick="onAutoConnect(\'' + dev.ip + '\', ' + dev.port + ', \'' + dev.name + '\', \'' + dev.service + '\', this, \'' + cardId + '\')">' +
          '연결' +
        '</button>';
      discoverGrid.appendChild(card);
    }
  } catch (e) {
    discoverGrid.innerHTML = '<div class="discover-empty">검색 실패</div>';
  }
}

async function onAutoConnect(ip, port, deviceName, service, btn, cardId) {
  btn.disabled = true;
  btn.textContent = '연결 중...';
  try {
    const ok = await window.mbot.connectDevice(ip, port, deviceName || undefined);
    if (ok) {
      btn.textContent = '연결됨!';
      log(ip + ' 연결 완료 (저장됨)', 'success');
      await refreshDevices();
      setTimeout(onScanDevices, 500);
    } else if (service.includes('tls-connect')) {
      btn.textContent = '페어링 필요';
      btn.disabled = false;
      btn.onclick = () => showPairForm(ip, port, deviceName, cardId, btn);
      showPairForm(ip, port, deviceName, cardId, btn);
    } else {
      btn.textContent = '실패';
      btn.disabled = false;
      if (deviceName) await window.mbot.removeMdnsCache(deviceName);
      setTimeout(() => { btn.textContent = '연결'; }, 2000);
    }
  } catch (e) {
    btn.textContent = '오류';
    btn.disabled = false;
    if (deviceName) await window.mbot.removeMdnsCache(deviceName);
  }
}

function showPairForm(ip, connectPort, deviceName, cardId, originalBtn) {
  const card = document.getElementById(cardId);
  if (!card || card.querySelector('.pair-form')) return;
  originalBtn.style.display = 'none';

  const form = document.createElement('div');
  form.className = 'pair-form';
  form.style.width = '100%';
  form.innerHTML =
    '<p>' +
      '<b>최초 1회 페어링이 필요합니다.</b><br>' +
      '폰 <b>설정 &rarr; 개발자 옵션 &rarr; "무선 디버깅" 글자를 탭</b> &rarr; 상세 화면 진입<br>' +
      '&rarr; <b>"페어링 코드로 기기 페어링"</b> 탭 &rarr; 팝업에 표시된 값 입력' +
    '</p>' +
    '<div class="pair-inputs">' +
      '<input class="pair-port" type="text" placeholder="포트 5자리" maxlength="5" inputmode="numeric" style="width:80px;">' +
      '<input class="pair-code" type="text" placeholder="코드 6자리" maxlength="6" inputmode="numeric" style="width:80px;">' +
      '<button class="btn-primary" id="pairBtn-' + cardId + '">페어링</button>' +
      '<button class="btn-ghost" id="pairCancel-' + cardId + '">취소</button>' +
    '</div>';
  card.appendChild(form);

  const portInput = form.querySelector('.pair-port');
  const codeInput = form.querySelector('.pair-code');
  const pairBtn = form.querySelector('#pairBtn-' + cardId);
  const cancelBtn = form.querySelector('#pairCancel-' + cardId);

  cancelBtn.onclick = () => {
    form.remove();
    originalBtn.style.display = '';
    originalBtn.textContent = '페어링';
  };

  pairBtn.onclick = async () => {
    const pairPort = parseInt(portInput.value.trim());
    const code = codeInput.value.trim();
    if (!pairPort || !code || code.length < 6) {
      log('포트와 6자리 코드를 모두 입력하세요', 'error');
      return;
    }

    pairBtn.disabled = true;
    pairBtn.textContent = '페어링 중...';
    log('페어링 시도: ' + ip + ':' + pairPort);

    try {
      const paired = await window.mbot.pairDevice(ip, pairPort, code);
      if (paired) {
        log('페어링 성공! 연결 중...', 'success');
        pairBtn.textContent = '연결 중...';
        const connected = await window.mbot.connectDevice(ip, connectPort, deviceName);
        if (connected) {
          log(ip + ' 연결 완료 (저장됨)', 'success');
          await refreshDevices();
          setTimeout(onScanDevices, 500);
        } else {
          log('페어링 완료. 검색 후 다시 연결하세요.', 'entry');
          setTimeout(onScanDevices, 1000);
        }
      } else {
        pairBtn.disabled = false;
        pairBtn.textContent = '페어링';
        log('페어링 실패 — 코드를 다시 확인하세요', 'error');
      }
    } catch (e) {
      pairBtn.disabled = false;
      pairBtn.textContent = '페어링';
      log('페어링 오류', 'error');
    }
  };

  portInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') codeInput.focus(); });
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') pairBtn.click(); });
  portInput.focus();
}
