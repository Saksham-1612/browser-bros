const card        = document.getElementById('statusCard');
const statusText  = document.getElementById('statusText');
const connectBtn  = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const tabsVal     = document.getElementById('tabsVal');
const sessVal     = document.getElementById('sessVal');

let uptimeTimer = null;

// ── Helpers ──────────────────────────────────────────────────

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60)  return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60)  return m + 'm';
  return Math.floor(m / 60) + 'h';
}

function tickEl(el, val) {
  el.textContent = val;
  el.classList.remove('tick');
  void el.offsetWidth; // reflow to retrigger animation
  el.classList.add('tick');
}

function refreshTabCount() {
  chrome.tabs.query({}, tabs => {
    tickEl(tabsVal, tabs.length);
  });
}

function startUptime(connectedAt) {
  if (uptimeTimer) clearInterval(uptimeTimer);
  function tick() { sessVal.textContent = fmt(Date.now() - connectedAt); }
  tick();
  uptimeTimer = setInterval(tick, 1000);
}

function stopUptime() {
  if (uptimeTimer) { clearInterval(uptimeTimer); uptimeTimer = null; }
  sessVal.textContent = '—';
}

// ── State ────────────────────────────────────────────────────

function updateUI(state) {
  // state: 'connected' | 'disconnected' | 'connecting' | 'notfound'
  const isOn = state === 'connected';

  card.classList.toggle('on', isOn);

  const labels = {
    connected:    'Connected',
    disconnected: 'Disconnected',
    connecting:   'Connecting…',
    notfound:     'Server not found',
  };
  statusText.textContent = labels[state] ?? 'Disconnected';

  connectBtn.disabled    = isOn || state === 'connecting';
  disconnectBtn.disabled = !isOn;

  if (isOn) {
    let t = parseInt(sessionStorage.getItem('bmcp_at') || '0');
    if (!t) {
      t = Date.now();
      sessionStorage.setItem('bmcp_at', String(t));
    }
    startUptime(t);
    refreshTabCount();
  } else {
    if (state !== 'connecting') {
      sessionStorage.removeItem('bmcp_at');
      stopUptime();
      tabsVal.textContent = '—';
    }
  }
}

// ── Init ─────────────────────────────────────────────────────

chrome.runtime.sendMessage({ type: 'getStatus' }, response => {
  if (chrome.runtime.lastError) { statusText.textContent = 'Error'; return; }
  updateUI(response?.connected ? 'connected' : 'disconnected');
});

// ── Connect ──────────────────────────────────────────────────

connectBtn.addEventListener('click', () => {
  updateUI('connecting');
  chrome.runtime.sendMessage({ type: 'reconnect' }, () => {
    if (chrome.runtime.lastError) { updateUI('disconnected'); return; }
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      chrome.runtime.sendMessage({ type: 'getStatus' }, res => {
        if (res?.connected) {
          clearInterval(poll);
          updateUI('connected');
        } else if (attempts >= 6) {
          clearInterval(poll);
          updateUI('notfound');
          // reset back to disconnected label after 2s
          setTimeout(() => {
            statusText.textContent = 'Disconnected';
            connectBtn.disabled = false;
          }, 2000);
        }
      });
    }, 800);
  });
});

// ── Disconnect ───────────────────────────────────────────────

disconnectBtn.addEventListener('click', () => {
  disconnectBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'disconnect' }, () => {
    if (chrome.runtime.lastError) { statusText.textContent = 'Error'; return; }
    updateUI('disconnected');
  });
});
