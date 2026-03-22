// === Log utility ===
const logPanel = document.getElementById('logPanel');
const logToggleBtn = document.getElementById('logToggleBtn');
let logVisible = false;

function log(msg, type = 'entry') {
  logToggleBtn.style.display = 'inline-block';
  const entry = document.createElement('div');
  entry.className = 'log-' + type;
  const time = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  entry.textContent = time + '  ' + msg;
  logPanel.appendChild(entry);
  logPanel.scrollTop = logPanel.scrollHeight;
}

logToggleBtn.addEventListener('click', () => {
  logVisible = !logVisible;
  logPanel.style.display = logVisible ? 'block' : 'none';
  logToggleBtn.textContent = logVisible ? '로그 숨기기' : '로그 보기';
});
