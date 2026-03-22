// === Auto Update UI ===
const updateBanner = document.getElementById('updateBanner');
const updateText = document.getElementById('updateText');
const updateBtn = document.getElementById('updateBtn');
const updateDismiss = document.getElementById('updateDismiss');

window.mbot.onUpdateAvailable((version) => {
  updateText.textContent = '새 버전 v' + version + ' 다운로드 중...';
  updateBanner.style.display = 'flex';
  updateBtn.style.display = 'none';
  updateDismiss.onclick = () => { updateBanner.style.display = 'none'; };
});

window.mbot.onUpdateProgress((percent) => {
  updateText.textContent = '업데이트 다운로드 중... ' + percent + '%';
});

window.mbot.onUpdateDownloaded((version) => {
  updateText.textContent = 'v' + version + ' 다운로드 완료';
  updateBtn.textContent = '재시작';
  updateBtn.style.display = 'inline-block';
  updateBtn.onclick = () => window.mbot.installUpdate();
});

window.mbot.onUpdateError((msg) => {
  updateText.textContent = '업데이트 실패 — 재시작하면 자동 재시도됩니다';
  updateBtn.textContent = '닫기';
  updateBtn.style.display = 'inline-block';
  updateBtn.onclick = () => { updateBanner.style.display = 'none'; };
  console.error('[Update Error]', msg);
});
