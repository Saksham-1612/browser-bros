const dot = document.getElementById("statusDot");
const text = document.getElementById("statusText");
const connectBtn = document.getElementById("connectBtn");
const disconnectBtn = document.getElementById("disconnectBtn");

function updateUI(isConnected) {
  dot.classList.toggle("connected", isConnected);
  dot.classList.toggle("disconnected", !isConnected);
  text.classList.toggle("active", isConnected);
  text.textContent = isConnected ? "Connected" : "Disconnected";
  connectBtn.disabled = isConnected;
  disconnectBtn.disabled = !isConnected;
}

// Initial status
chrome.runtime.sendMessage({ type: "getStatus" }, (response) => {
  if (chrome.runtime.lastError) { text.textContent = "Error"; return; }
  updateUI(response?.connected);
});

// Connect
connectBtn.addEventListener("click", () => {
  connectBtn.disabled = true;
  text.textContent = "Connecting…";
  text.classList.remove("active");
  chrome.runtime.sendMessage({ type: "reconnect" }, () => {
    if (chrome.runtime.lastError) { text.textContent = "Error"; connectBtn.disabled = false; return; }
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      chrome.runtime.sendMessage({ type: "getStatus" }, (res) => {
        if (res?.connected) { clearInterval(poll); updateUI(true); }
        else if (attempts >= 5) { clearInterval(poll); updateUI(false); text.textContent = "Server not found"; }
      });
    }, 800);
  });
});

// Disconnect
disconnectBtn.addEventListener("click", () => {
  disconnectBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "disconnect" }, () => {
    if (chrome.runtime.lastError) { text.textContent = "Error"; return; }
    updateUI(false);
  });
});
