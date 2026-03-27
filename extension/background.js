// BrowserMCP — Background Service Worker
// Connects to the local MCP server via WebSocket and executes browser commands.

const WS_URL = "ws://localhost:12800";
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5000;
const KEEPALIVE_INTERVAL_MS = 25000;
const FAST_POLL_INTERVAL_MS = 1500; // fast reconnect polling when disconnected

let ws = null;
let connected = false;
let connecting = false; // guard against concurrent connect() calls
let reconnectDelay = RECONNECT_BASE_MS;
let keepaliveTimer = null;
let fastPollTimer = null;

// ============================================================
// WebSocket Connection
// ============================================================

const HEALTH_URL = WS_URL.replace("ws://", "http://") + "/health";

async function connect() {
  if (connecting) return; // another connect() is already in flight
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

  connecting = true;

  // Probe /health endpoint first — avoids ERR_CONNECTION_REFUSED spam from WebSocket
  try {
    const resp = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
    if (!resp.ok) { connecting = false; return; }
  } catch {
    // Server not running — skip WebSocket entirely, no error logged
    connecting = false;
    return;
  }

  // Double-check after async gap — another call may have connected while we awaited
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    connecting = false;
    return;
  }

  // Server is alive — safe to connect WebSocket
  try { ws = new WebSocket(WS_URL); } catch (e) { connecting = false; return; }

  ws.onerror = () => {};

  ws.onopen = () => {
    connected = true;
    connecting = false;
    reconnectDelay = RECONNECT_BASE_MS;
    console.log("[BrowserMCP] Connected");
    updateBadge(true);
    startKeepalive();
    stopFastPoll();
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.id && msg.action) {
        const response = await handleCommand(msg);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(response));
        }
      }
    } catch (e) {
      if (e?.message?.includes("null")) return; // connection closed mid-command
      console.error("[BrowserMCP] Message error:", e);
    }
  };

  ws.onclose = () => {
    connected = false; connecting = false; ws = null;
    updateBadge(false); stopKeepalive();
    reconnectDelay = RECONNECT_BASE_MS;
    startFastPoll();
  };
}

function scheduleReconnect() {
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  chrome.alarms.create("browserMcpReconnect", { delayInMinutes: delay / 60000 });
}

function startFastPoll() {
  stopFastPoll();
  // Poll every 1.5s to detect when server comes back up
  fastPollTimer = setInterval(() => {
    if (!connected) connect();
  }, FAST_POLL_INTERVAL_MS);
  // Also use alarm as MV3 backup (service worker may sleep)
  chrome.alarms.create("browserMcpFastPoll", { periodInMinutes: 0.05 }); // ~3s
}

function stopFastPoll() {
  if (fastPollTimer) { clearInterval(fastPollTimer); fastPollTimer = null; }
  chrome.alarms.clear("browserMcpFastPoll");
}

function startKeepalive() {
  stopKeepalive();
  keepaliveTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
  }, KEEPALIVE_INTERVAL_MS);
  chrome.alarms.create("browserMcpKeepalive", { periodInMinutes: 0.4 });
}

function stopKeepalive() {
  if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
  chrome.alarms.clear("browserMcpKeepalive");
}

function updateBadge(isConnected) {
  chrome.action.setBadgeText({ text: isConnected ? "ON" : "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: isConnected ? "#22c55e" : "#ef4444" });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "browserMcpReconnect") connect();
  if (alarm.name === "browserMcpKeepalive" && !connected) connect();
  if (alarm.name === "browserMcpFastPoll" && !connected) connect();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "getStatus") { sendResponse({ connected }); return true; }
  if (msg.type === "reconnect") { reconnectDelay = RECONNECT_BASE_MS; connect(); sendResponse({ ok: true }); return true; }
  if (msg.type === "disconnect") {
    stopFastPoll();
    stopKeepalive();
    chrome.alarms.clear("browserMcpReconnect");
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    connected = false; connecting = false;
    updateBadge(false);
    sendResponse({ ok: true });
    return true;
  }
});

// ============================================================
// Helpers
// ============================================================

async function getTargetTab(tabId) {
  if (tabId != null) return await chrome.tabs.get(tabId);
  const focusedWindow = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
  const [tab] = await chrome.tabs.query({ active: true, windowId: focusedWindow.id });
  if (!tab) throw new Error("No active tab found in focused window");
  return tab;
}

function waitForTabLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error("Tab load timed out")); }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(); }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function isInjectableUrl(url) {
  if (!url) return false;
  return url.startsWith("http://") || url.startsWith("https://");
}

function requireInjectable(tab) {
  if (!isInjectableUrl(tab.url)) throw new Error(`Cannot interact with restricted URL: ${tab.url}`);
}

async function extractContent(tabId, format = "text") {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (fmt) => {
      const c = { title: document.title, url: location.href, text: "", html: "", meta: {} };
      c.text = document.body ? document.body.innerText : "";
      if (fmt === "html" || fmt === "full") c.html = document.documentElement.outerHTML;
      if (fmt === "full" || fmt === "text") {
        document.querySelectorAll("meta[name], meta[property]").forEach((m) => {
          const k = m.getAttribute("name") || m.getAttribute("property");
          const v = m.getAttribute("content");
          if (k && v) c.meta[k] = v;
        });
      }
      return c;
    },
    args: [format],
  });
  if (!results?.length) throw new Error("Failed to extract page content");
  return results[0].result;
}

async function injectAndRun(tabId, func, args = [], world = "ISOLATED") {
  const tab = await getTargetTab(tabId);
  requireInjectable(tab);
  const opts = { target: { tabId: tab.id }, func, args };
  if (world === "MAIN") opts.world = "MAIN";
  const results = await chrome.scripting.executeScript(opts);
  if (results[0]?.error) throw new Error(results[0].error.message || "Script execution failed");
  return results[0]?.result;
}

// ============================================================
// Animated Cursor Helper
// ============================================================

// Cursor CSS + SVG injected into page (shared by all cursor helpers)
const CURSOR_CSS = `
.__bmcp-cursor{
  position:fixed;z-index:2147483647;pointer-events:none;
  width:28px;height:28px;
  filter:drop-shadow(0 3px 10px rgba(0,0,0,.4));
  transition:left .42s cubic-bezier(.34,1.56,.64,1),top .42s cubic-bezier(.34,1.56,.64,1),opacity .22s ease,transform .12s ease;
  transform-origin:4px 2px;
}
.__bmcp-cursor.--press{transform:scale(.72) rotate(-6deg)}
.__bmcp-ripple{position:fixed;z-index:2147483646;pointer-events:none;border-radius:50%;transform:translate(-50%,-50%)}
.__bmcp-ripple.--fill{width:0;height:0;background:radial-gradient(circle,rgba(59,130,246,.48) 0%,rgba(59,130,246,0) 70%);animation:__bmcp-rf .52s ease-out forwards}
.__bmcp-ripple.--ring{width:0;height:0;border:2px solid rgba(59,130,246,.5);animation:__bmcp-rr .6s ease-out .05s forwards}
@keyframes __bmcp-rf{0%{width:0;height:0;opacity:1}100%{width:72px;height:72px;opacity:0}}
@keyframes __bmcp-rr{0%{width:0;height:0;opacity:.75}100%{width:58px;height:58px;opacity:0}}
`;
const CURSOR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28"><path d="M5 2L5 24L11 18L18 26L22 23L15 15L23 15Z" fill="#fff" stroke="#222" stroke-width="1.5" stroke-linejoin="round"/></svg>';

// Inject cursor that glides to the target element from the previous cursor position
async function injectCursor(tabId, selector, selectorType = "css") {
  await injectAndRun(tabId, (sel, selType, css, svg) => {
    let el;
    if (selType === "text") {
      const [text, elTypeFilter] = sel.split("::__ELTYPE__::");
      const candidates = document.querySelectorAll(elTypeFilter || "*");
      el = Array.from(candidates).find(e => { const t = e.textContent?.trim(); return t === text || t?.includes(text); });
    } else if (selType === "xpath") {
      el = document.evaluate(sel, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    } else {
      el = document.querySelector(sel);
    }
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const tx = rect.left + rect.width / 2, ty = rect.top + rect.height / 2;

    document.querySelectorAll(".__bmcp-cursor, .__bmcp-ripple, .__bmcp-cursor-style").forEach(e => e.remove());
    const s = document.createElement("style"); s.className = "__bmcp-cursor-style";
    s.textContent = css; document.head.appendChild(s);

    // Glide from last known cursor position, or from above the target if first time
    const prev = window.__bmcp_cursorPos || { x: tx, y: Math.max(ty - 100, 0) };
    window.__bmcp_cursorPos = { x: tx, y: ty };

    const c = document.createElement("div"); c.className = "__bmcp-cursor";
    c.innerHTML = svg;
    c.style.left = (prev.x - 5) + "px"; c.style.top = (prev.y - 2) + "px";
    c.style.opacity = "0";
    document.body.appendChild(c);

    requestAnimationFrame(() => {
      c.style.opacity = "1";
      c.style.left = (tx - 5) + "px"; c.style.top = (ty - 2) + "px";
    });

    // Element pulse highlight
    el.style.outline = "2px solid rgba(59,130,246,0.65)"; el.style.outlineOffset = "2px";
    setTimeout(() => { el.style.outline = ""; el.style.outlineOffset = ""; }, 500);

    setTimeout(() => { c.style.opacity = "0"; }, 580);
    setTimeout(() => { document.querySelectorAll(".__bmcp-cursor, .__bmcp-ripple, .__bmcp-cursor-style").forEach(e => e.remove()); }, 820);
  }, [selector, selectorType, CURSOR_CSS, CURSOR_SVG]).catch(() => {});
  // Wait enough for glide to visually land before the action fires
  await new Promise(r => setTimeout(r, 280));
}

// Fire-and-forget version for non-navigating actions (type, hover, select)
function showClickCursor(tabId, selector, selectorType = "css") {
  injectCursor(tabId, selector, selectorType);
}

// ============================================================
// Handler Registry
// ============================================================

const handlers = {};

// --- CORE ---

handlers.navigate = async ({ url, waitMs = 1000 }) => {
  const tab = await chrome.tabs.create({ url, active: true });
  if (tab.status !== "complete") await waitForTabLoad(tab.id);
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  if (!isInjectableUrl(url)) return { title: tab.title || url, url, text: `[Cannot extract content from ${url}]`, meta: {} };
  return await extractContent(tab.id, "text");
};

handlers.read_page = async ({ tabId, format = "text" }) => {
  const tab = await getTargetTab(tabId);
  if (!isInjectableUrl(tab.url)) return { title: tab.title || "", url: tab.url || "", text: `[Cannot extract — restricted URL: ${tab.url}]`, meta: {} };
  return await extractContent(tab.id, format);
};

handlers.list_tabs = async () => {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({ id: t.id, url: t.url || "", title: t.title || "", active: t.active || false, windowId: t.windowId }));
};

handlers.close_tab = async ({ tabId }) => { await chrome.tabs.remove(tabId); return { success: true }; };

handlers.click = async ({ selector, tabId }) => {
  return await injectAndRun(tabId, (sel, css, svg) => {
    const el = document.querySelector(sel); if (!el) throw new Error(`Element not found: ${sel}`);
    const rect = el.getBoundingClientRect();
    const tx = rect.left + rect.width / 2, ty = rect.top + rect.height / 2;

    document.querySelectorAll(".__bmcp-cursor, .__bmcp-ripple, .__bmcp-cursor-style").forEach(e => e.remove());
    const s = document.createElement("style"); s.className = "__bmcp-cursor-style"; s.textContent = css; document.head.appendChild(s);

    // Glide from last known position
    const prev = window.__bmcp_cursorPos || { x: tx, y: Math.max(ty - 100, 0) };
    window.__bmcp_cursorPos = { x: tx, y: ty };

    const c = document.createElement("div"); c.className = "__bmcp-cursor"; c.innerHTML = svg;
    c.style.left = (prev.x - 5) + "px"; c.style.top = (prev.y - 2) + "px";
    c.style.opacity = "0";
    document.body.appendChild(c);

    return new Promise(resolve => {
      requestAnimationFrame(() => {
        // Fade in + glide to target
        c.style.opacity = "1";
        c.style.left = (tx - 5) + "px"; c.style.top = (ty - 2) + "px";

        // After glide lands (~300ms): press squish → click → release
        setTimeout(() => {
          c.classList.add("--press");

          // Dual-ring ripple at click point
          const r1 = document.createElement("div"); r1.className = "__bmcp-ripple --fill";
          r1.style.left = tx + "px"; r1.style.top = ty + "px"; document.body.appendChild(r1);
          const r2 = document.createElement("div"); r2.className = "__bmcp-ripple --ring";
          r2.style.left = tx + "px"; r2.style.top = ty + "px"; document.body.appendChild(r2);

          setTimeout(() => {
            c.classList.remove("--press");
            el.click();
            resolve(true);
          }, 110);

          setTimeout(() => { c.style.opacity = "0"; }, 380);
          setTimeout(() => { document.querySelectorAll(".__bmcp-cursor,.__bmcp-ripple,.__bmcp-cursor-style").forEach(e => e.remove()); }, 750);
        }, 300);
      });
    });
  }, [selector, CURSOR_CSS, CURSOR_SVG]);
};

handlers.type = async ({ selector, text, tabId }) => {
  showClickCursor(tabId, selector);
  return await injectAndRun(tabId, (sel, txt) => {
    const el = document.querySelector(sel); if (!el) throw new Error(`Element not found: ${sel}`);
    el.focus();
    // Use native setter to bypass React/Vue/Angular controlled inputs
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
    if (nativeSetter) {
      nativeSetter.call(el, txt);
    } else {
      el.value = txt;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, [selector, text]);
};

handlers.screenshot = async ({ tabId }) => {
  const tab = await getTargetTab(tabId);
  return await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
};

handlers.execute_js = async ({ code, tabId }) => {
  return await injectAndRun(tabId, (jsCode) => (0, eval)(jsCode), [code], "MAIN");
};

// --- NAVIGATION ---

handlers.scroll = async ({ direction, pixels = 500, selector, tabId }) => {
  return await injectAndRun(tabId, (dir, px, sel) => {
    if (sel) {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`Element not found: ${sel}`);
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      const map = { up: [0, -px], down: [0, px], left: [-px, 0], right: [px, 0] };
      const [x, y] = map[dir] || map.down;
      window.scrollBy(x, y);
    }
    return { scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) };
  }, [direction || "down", pixels, selector || null]);
};

handlers.back = async ({ tabId }) => {
  await injectAndRun(tabId, () => { history.back(); }, []);
  await new Promise((r) => setTimeout(r, 500));
  const tab = await getTargetTab(tabId);
  return { url: tab.url, title: tab.title };
};

handlers.forward = async ({ tabId }) => {
  await injectAndRun(tabId, () => { history.forward(); }, []);
  await new Promise((r) => setTimeout(r, 500));
  const tab = await getTargetTab(tabId);
  return { url: tab.url, title: tab.title };
};

handlers.switch_tab = async ({ tabId }) => {
  const tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return { tabId: tab.id, title: tab.title, url: tab.url };
};

handlers.keyboard = async ({ key, modifiers = [], selector, tabId }) => {
  return await injectAndRun(tabId, (k, mods, sel) => {
    const target = sel ? document.querySelector(sel) : document.activeElement || document.body;
    if (sel && !target) throw new Error(`Element not found: ${sel}`);
    if (sel) target.focus();
    // Build key code: single char → "Key" + upper, special keys stay as-is
    const code = k.length === 1 ? "Key" + k.toUpperCase() : k;
    const opts = { key: k, code, bubbles: true, cancelable: true, ctrlKey: mods.includes("ctrl"), shiftKey: mods.includes("shift"), altKey: mods.includes("alt"), metaKey: mods.includes("meta") };
    target.dispatchEvent(new KeyboardEvent("keydown", opts));
    target.dispatchEvent(new KeyboardEvent("keypress", opts));
    target.dispatchEvent(new KeyboardEvent("keyup", opts));
    // For single chars in input/textarea, also insert the character
    if (k.length === 1 && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? start;
      target.value = target.value.slice(0, start) + k + target.value.slice(end);
      target.selectionStart = target.selectionEnd = start + 1;
      target.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return true;
  }, [key, modifiers || [], selector || null]);
};

handlers.hover = async ({ selector, tabId }) => {
  showClickCursor(tabId, selector);
  return await injectAndRun(tabId, (sel) => {
    const el = document.querySelector(sel); if (!el) throw new Error(`Element not found: ${sel}`);
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    return true;
  }, [selector]);
};

handlers.select = async ({ selector, value, tabId }) => {
  showClickCursor(tabId, selector);
  return await injectAndRun(tabId, (sel, val) => {
    const el = document.querySelector(sel); if (!el) throw new Error(`Element not found: ${sel}`);
    el.value = val;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    const opt = el.options?.[el.selectedIndex];
    return { selectedValue: el.value, selectedText: opt?.textContent || "" };
  }, [selector, value]);
};

// --- UTILITIES ---

handlers.wait_for = async ({ selector, timeout = 10000, tabId }) => {
  return await injectAndRun(tabId, (sel, tout) => {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(sel);
      if (existing) return resolve({ found: true, tagName: existing.tagName, text: existing.textContent?.slice(0, 200) || "" });
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`Timeout: element "${sel}" not found within ${tout}ms`)); }, tout);
      const observer = new MutationObserver(() => {
        const el = document.querySelector(sel);
        if (el) { clearTimeout(timer); observer.disconnect(); resolve({ found: true, tagName: el.tagName, text: el.textContent?.slice(0, 200) || "" }); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }, [selector, timeout]);
};

handlers.new_tab = async ({ url }) => {
  const tab = await chrome.tabs.create({ url: url || "about:blank", active: true });
  return { tabId: tab.id, url: tab.url || url || "about:blank" };
};

handlers.reload = async ({ tabId, hard = false }) => {
  const tab = await getTargetTab(tabId);
  await chrome.tabs.reload(tab.id, { bypassCache: hard });
  await waitForTabLoad(tab.id);
  return { success: true };
};

handlers.set_storage = async ({ type, key, value, tabId }) => {
  return await injectAndRun(tabId, (t, k, v) => { window[t].setItem(k, v); return true; }, [type, key, value]);
};

handlers.find_text = async ({ text, tabId }) => {
  return await injectAndRun(tabId, (searchText) => {
    const results = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const lower = searchText.toLowerCase();
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const content = node.textContent || "";
      const idx = content.toLowerCase().indexOf(lower);
      if (idx !== -1) {
        const start = Math.max(0, idx - 50);
        const end = Math.min(content.length, idx + searchText.length + 50);
        results.push({ match: content.slice(idx, idx + searchText.length), context: content.slice(start, end).trim(), element: node.parentElement?.tagName || "UNKNOWN" });
        if (results.length >= 50) break;
      }
    }
    return results;
  }, [text]);
};

// --- DATA EXTRACTION ---

handlers.get_links = async ({ tabId, filter }) => {
  return await injectAndRun(tabId, (f) => {
    const links = Array.from(document.querySelectorAll("a[href]")).map((a) => ({ href: a.href, text: a.textContent?.trim().slice(0, 200) || "", rel: a.getAttribute("rel") || "" }));
    if (!f) return links;
    const fl = f.toLowerCase();
    return links.filter((l) => l.href.toLowerCase().includes(fl) || l.text.toLowerCase().includes(fl));
  }, [filter || null]);
};

handlers.get_elements = async ({ selector, attributes = ["textContent", "href", "src", "alt", "value", "class", "id"], limit = 50, tabId }) => {
  return await injectAndRun(tabId, (sel, attrs, lim) => {
    const els = Array.from(document.querySelectorAll(sel)).slice(0, lim);
    return els.map((el) => {
      const obj = { tagName: el.tagName };
      for (const attr of attrs) {
        if (attr === "textContent") obj[attr] = el.textContent?.trim().slice(0, 500) || "";
        else if (attr in el) obj[attr] = el[attr] ?? "";
        else obj[attr] = el.getAttribute(attr) ?? "";
      }
      return obj;
    });
  }, [selector, attributes, limit]);
};

handlers.extract_table = async ({ selector = "table", tabId }) => {
  return await injectAndRun(tabId, (sel) => {
    const table = document.querySelector(sel);
    if (!table) throw new Error(`Table not found: ${sel}`);
    const headers = [];
    const headerRow = table.querySelector("thead tr") || table.querySelector("tr");
    if (headerRow) headerRow.querySelectorAll("th, td").forEach((c) => headers.push(c.textContent?.trim() || ""));
    const rows = [];
    const bodyRows = table.querySelectorAll("tbody tr");
    const dataRows = bodyRows.length ? bodyRows : table.querySelectorAll("tr");
    dataRows.forEach((tr, i) => {
      if (i === 0 && !table.querySelector("thead") && headers.length) return;
      const row = [];
      tr.querySelectorAll("td, th").forEach((c) => row.push(c.textContent?.trim() || ""));
      rows.push(row);
    });
    return { headers, rows };
  }, [selector]);
};

handlers.get_cookies = async ({ url }) => {
  return await chrome.cookies.getAll({ url });
};

handlers.get_storage = async ({ type, key, tabId }) => {
  return await injectAndRun(tabId, (t, k) => {
    const storage = window[t];
    if (k) return { [k]: storage.getItem(k) };
    const all = {};
    for (let i = 0; i < storage.length; i++) { const sk = storage.key(i); all[sk] = storage.getItem(sk); }
    return all;
  }, [type, key || null]);
};

// --- ADVANCED INTERACTION ---

handlers.right_click = async ({ selector, tabId }) => {
  return await injectAndRun(tabId, (sel, css, svg) => {
    const el = document.querySelector(sel); if (!el) throw new Error(`Element not found: ${sel}`);
    const rect = el.getBoundingClientRect();
    const tx = rect.left + rect.width / 2, ty = rect.top + rect.height / 2;

    document.querySelectorAll(".__bmcp-cursor, .__bmcp-ripple, .__bmcp-cursor-style").forEach(e => e.remove());
    const s = document.createElement("style"); s.className = "__bmcp-cursor-style"; s.textContent = css; document.head.appendChild(s);

    const prev = window.__bmcp_cursorPos || { x: tx, y: Math.max(ty - 100, 0) };
    window.__bmcp_cursorPos = { x: tx, y: ty };

    const c = document.createElement("div"); c.className = "__bmcp-cursor"; c.innerHTML = svg;
    c.style.left = (prev.x - 5) + "px"; c.style.top = (prev.y - 2) + "px";
    c.style.opacity = "0"; document.body.appendChild(c);

    return new Promise(resolve => {
      requestAnimationFrame(() => {
        c.style.opacity = "1";
        c.style.left = (tx - 5) + "px"; c.style.top = (ty - 2) + "px";
        setTimeout(() => {
          c.classList.add("--press");
          const r1 = document.createElement("div"); r1.className = "__bmcp-ripple --fill";
          r1.style.left = tx + "px"; r1.style.top = ty + "px"; document.body.appendChild(r1);
          const r2 = document.createElement("div"); r2.className = "__bmcp-ripple --ring";
          r2.style.left = tx + "px"; r2.style.top = ty + "px"; document.body.appendChild(r2);
          setTimeout(() => {
            c.classList.remove("--press");
            el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
            resolve(true);
          }, 110);
          setTimeout(() => { c.style.opacity = "0"; }, 380);
          setTimeout(() => { document.querySelectorAll(".__bmcp-cursor,.__bmcp-ripple,.__bmcp-cursor-style").forEach(e => e.remove()); }, 750);
        }, 300);
      });
    });
  }, [selector, CURSOR_CSS, CURSOR_SVG]);
};

handlers.double_click = async ({ selector, tabId }) => {
  return await injectAndRun(tabId, (sel, css, svg) => {
    const el = document.querySelector(sel); if (!el) throw new Error(`Element not found: ${sel}`);
    const rect = el.getBoundingClientRect();
    const tx = rect.left + rect.width / 2, ty = rect.top + rect.height / 2;

    document.querySelectorAll(".__bmcp-cursor, .__bmcp-ripple, .__bmcp-cursor-style").forEach(e => e.remove());
    const s = document.createElement("style"); s.className = "__bmcp-cursor-style"; s.textContent = css; document.head.appendChild(s);

    const prev = window.__bmcp_cursorPos || { x: tx, y: Math.max(ty - 100, 0) };
    window.__bmcp_cursorPos = { x: tx, y: ty };

    const c = document.createElement("div"); c.className = "__bmcp-cursor"; c.innerHTML = svg;
    c.style.left = (prev.x - 5) + "px"; c.style.top = (prev.y - 2) + "px";
    c.style.opacity = "0"; document.body.appendChild(c);

    return new Promise(resolve => {
      requestAnimationFrame(() => {
        c.style.opacity = "1";
        c.style.left = (tx - 5) + "px"; c.style.top = (ty - 2) + "px";
        setTimeout(() => {
          // First press
          c.classList.add("--press");
          const r1 = document.createElement("div"); r1.className = "__bmcp-ripple --fill";
          r1.style.left = tx + "px"; r1.style.top = ty + "px"; document.body.appendChild(r1);
          setTimeout(() => { c.classList.remove("--press"); }, 90);
          // Second press
          setTimeout(() => {
            c.classList.add("--press");
            const r2 = document.createElement("div"); r2.className = "__bmcp-ripple --fill";
            r2.style.left = tx + "px"; r2.style.top = ty + "px"; document.body.appendChild(r2);
            setTimeout(() => {
              c.classList.remove("--press");
              el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
              resolve(true);
            }, 90);
            setTimeout(() => { c.style.opacity = "0"; }, 350);
            setTimeout(() => { document.querySelectorAll(".__bmcp-cursor,.__bmcp-ripple,.__bmcp-cursor-style").forEach(e => e.remove()); }, 750);
          }, 160);
        }, 300);
      });
    });
  }, [selector, CURSOR_CSS, CURSOR_SVG]);
};

handlers.drag_drop = async ({ fromSelector, toSelector, tabId }) => {
  return await injectAndRun(tabId, (from, to) => {
    const src = document.querySelector(from); if (!src) throw new Error(`Drag source not found: ${from}`);
    const dst = document.querySelector(to); if (!dst) throw new Error(`Drop target not found: ${to}`);
    const dataTransfer = new DataTransfer();
    src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
    dst.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer }));
    dst.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer }));
    dst.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer }));
    src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));
    return true;
  }, [fromSelector, toSelector]);
};

// --- MONITORING ---

handlers.get_computed_style = async ({ selector, properties, tabId }) => {
  return await injectAndRun(tabId, (sel, props) => {
    const el = document.querySelector(sel); if (!el) throw new Error(`Element not found: ${sel}`);
    const cs = getComputedStyle(el);
    if (props && props.length) {
      const result = {};
      for (const p of props) result[p] = cs.getPropertyValue(p);
      return result;
    }
    const common = ["color", "background-color", "font-size", "font-family", "font-weight", "width", "height", "margin", "padding", "display", "position", "border", "opacity", "z-index", "overflow"];
    const result = {};
    for (const p of common) result[p] = cs.getPropertyValue(p);
    return result;
  }, [selector, properties || null]);
};

handlers.inject_css = async ({ css, tabId }) => {
  const tab = await getTargetTab(tabId);
  requireInjectable(tab);
  await chrome.scripting.insertCSS({ target: { tabId: tab.id }, css });
  return { success: true };
};

handlers.network_log = async ({ action, filter, tabId }) => {
  if (action === "start") {
    return await injectAndRun(tabId, () => {
      if (window.__bmcpNetLog) return { status: "already_running" };
      window.__bmcpNetLog = [];
      const origFetch = window.fetch;
      window.__bmcpOrigFetch = origFetch;
      window.fetch = async function (...args) {
        const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
        const method = args[1]?.method || "GET";
        const start = Date.now();
        try {
          const resp = await origFetch.apply(this, args);
          window.__bmcpNetLog.push({ url, method, status: resp.status, type: "fetch", duration: Date.now() - start, timestamp: start });
          if (window.__bmcpNetLog.length > 1000) window.__bmcpNetLog.shift();
          return resp;
        } catch (e) {
          window.__bmcpNetLog.push({ url, method, status: 0, type: "fetch", error: e.message, duration: Date.now() - start, timestamp: start });
          if (window.__bmcpNetLog.length > 1000) window.__bmcpNetLog.shift();
          throw e;
        }
      };
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      window.__bmcpOrigXhrOpen = origOpen;
      window.__bmcpOrigXhrSend = origSend;
      XMLHttpRequest.prototype.open = function (method, url) {
        this.__bmcpInfo = { method, url: String(url), start: 0 };
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        if (this.__bmcpInfo) {
          this.__bmcpInfo.start = Date.now();
          this.addEventListener("loadend", () => {
            window.__bmcpNetLog.push({ url: this.__bmcpInfo.url, method: this.__bmcpInfo.method, status: this.status, type: "xhr", duration: Date.now() - this.__bmcpInfo.start, timestamp: this.__bmcpInfo.start });
            if (window.__bmcpNetLog.length > 1000) window.__bmcpNetLog.shift();
          });
        }
        return origSend.apply(this, arguments);
      };
      return { status: "started" };
    }, [], "MAIN");
  }
  if (action === "stop") {
    return await injectAndRun(tabId, () => {
      if (window.__bmcpOrigFetch) { window.fetch = window.__bmcpOrigFetch; delete window.__bmcpOrigFetch; }
      if (window.__bmcpOrigXhrOpen) { XMLHttpRequest.prototype.open = window.__bmcpOrigXhrOpen; delete window.__bmcpOrigXhrOpen; }
      if (window.__bmcpOrigXhrSend) { XMLHttpRequest.prototype.send = window.__bmcpOrigXhrSend; delete window.__bmcpOrigXhrSend; }
      const log = window.__bmcpNetLog || [];
      delete window.__bmcpNetLog;
      return { status: "stopped", entries: log.length };
    }, [], "MAIN");
  }
  // get
  return await injectAndRun(tabId, (f) => {
    const log = window.__bmcpNetLog || [];
    if (!f) return log;
    return log.filter((e) => e.url.includes(f));
  }, [filter || null], "MAIN");
};

handlers.console_log = async ({ action, tabId }) => {
  if (action === "start") {
    return await injectAndRun(tabId, () => {
      if (window.__bmcpConsoleLog) return { status: "already_running" };
      window.__bmcpConsoleLog = [];
      const levels = ["log", "warn", "error", "info", "debug"];
      window.__bmcpOrigConsole = {};
      for (const lvl of levels) {
        window.__bmcpOrigConsole[lvl] = console[lvl];
        console[lvl] = function (...args) {
          window.__bmcpConsoleLog.push({ level: lvl, args: args.map((a) => { try { return typeof a === "object" ? JSON.stringify(a) : String(a); } catch { return String(a); } }), timestamp: Date.now() });
          if (window.__bmcpConsoleLog.length > 1000) window.__bmcpConsoleLog.shift();
          window.__bmcpOrigConsole[lvl].apply(console, args);
        };
      }
      return { status: "started" };
    }, [], "MAIN");
  }
  if (action === "stop") {
    return await injectAndRun(tabId, () => {
      if (window.__bmcpOrigConsole) {
        for (const [lvl, fn] of Object.entries(window.__bmcpOrigConsole)) console[lvl] = fn;
        delete window.__bmcpOrigConsole;
      }
      const log = window.__bmcpConsoleLog || [];
      delete window.__bmcpConsoleLog;
      return { status: "stopped", entries: log.length };
    }, [], "MAIN");
  }
  return await injectAndRun(tabId, () => window.__bmcpConsoleLog || [], [], "MAIN");
};

// --- WINDOW MANAGEMENT ---

handlers.new_window = async ({ url, incognito = false, width, height }) => {
  const opts = { incognito, state: "normal" };
  if (url) opts.url = url;
  if (width) opts.width = width;
  if (height) opts.height = height;
  const win = await chrome.windows.create(opts);
  return { windowId: win.id, tabId: win.tabs?.[0]?.id };
};

handlers.close_window = async ({ windowId }) => {
  await chrome.windows.remove(windowId);
  return { success: true };
};

handlers.resize_window = async ({ width, height, windowId }) => {
  const wid = windowId || (await chrome.windows.getLastFocused()).id;
  await chrome.windows.update(wid, { state: "normal" });
  const win = await chrome.windows.update(wid, { width, height });
  return { windowId: win.id, width: win.width, height: win.height };
};

handlers.move_tab = async ({ tabId, windowId, index = -1 }) => {
  const tab = await chrome.tabs.move(tabId, { windowId, index });
  return { tabId: tab.id, windowId: tab.windowId, index: tab.index };
};

handlers.pin_tab = async ({ tabId, pinned = true }) => {
  await chrome.tabs.update(tabId, { pinned });
  return { tabId, pinned };
};

handlers.mute_tab = async ({ tabId, muted = true }) => {
  await chrome.tabs.update(tabId, { muted });
  return { tabId, muted };
};

// --- CONTENT ---

handlers.highlight = async ({ selector, color = "red", tabId }) => {
  return await injectAndRun(tabId, (sel, col) => {
    const els = document.querySelectorAll(sel);
    if (!els.length) throw new Error(`No elements found: ${sel}`);
    els.forEach((el) => { el.style.outline = `3px solid ${col}`; el.style.outlineOffset = "2px"; });
    return { count: els.length };
  }, [selector, color]);
};

handlers.extract_images = async ({ tabId }) => {
  return await injectAndRun(tabId, () => {
    return Array.from(document.querySelectorAll("img")).map((img) => ({
      src: img.src, alt: img.alt || "", width: img.width, height: img.height,
      naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
    }));
  }, []);
};

handlers.extract_meta = async ({ tabId }) => {
  return await injectAndRun(tabId, () => {
    const result = { title: document.title, canonical: "", meta: {}, openGraph: {}, twitter: {}, jsonLd: [] };
    const canon = document.querySelector('link[rel="canonical"]');
    if (canon) result.canonical = canon.href;
    document.querySelectorAll("meta").forEach((m) => {
      const name = m.getAttribute("name");
      const prop = m.getAttribute("property");
      const content = m.getAttribute("content") || "";
      if (prop?.startsWith("og:")) result.openGraph[prop] = content;
      else if (name?.startsWith("twitter:") || prop?.startsWith("twitter:")) result.twitter[name || prop] = content;
      else if (name) result.meta[name] = content;
      else if (prop) result.meta[prop] = content;
    });
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try { result.jsonLd.push(JSON.parse(s.textContent)); } catch {}
    });
    return result;
  }, []);
};

handlers.readability = async ({ tabId }) => {
  return await injectAndRun(tabId, () => {
    // Simple readability: find main content container
    const candidates = [
      document.querySelector("article"),
      document.querySelector('[role="main"]'),
      document.querySelector("main"),
      document.querySelector(".post-content"),
      document.querySelector(".article-content"),
      document.querySelector(".entry-content"),
      document.querySelector("#content"),
    ].filter(Boolean);

    let best = candidates[0];
    if (!best) {
      // Fallback: find the element with the most paragraph text
      let maxLen = 0;
      document.querySelectorAll("div, section").forEach((el) => {
        const pText = Array.from(el.querySelectorAll("p")).reduce((sum, p) => sum + (p.textContent?.length || 0), 0);
        if (pText > maxLen) { maxLen = pText; best = el; }
      });
    }
    if (!best) best = document.body;

    const title = document.querySelector("h1")?.textContent?.trim() || document.title;
    const text = best.innerText || "";
    const excerpt = text.slice(0, 300).trim();

    return { title, content: text, length: text.length, excerpt };
  }, []);
};

handlers.watch_changes = async ({ action, selector = "body", tabId }) => {
  if (action === "start") {
    return await injectAndRun(tabId, (sel) => {
      if (window.__bmcpMutations) return { status: "already_running" };
      window.__bmcpMutations = [];
      const target = document.querySelector(sel);
      if (!target) throw new Error(`Element not found: ${sel}`);
      window.__bmcpMutationObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          window.__bmcpMutations.push({
            type: m.type,
            target: m.target.nodeName,
            addedNodes: m.addedNodes.length,
            removedNodes: m.removedNodes.length,
            attributeName: m.attributeName || null,
            timestamp: Date.now(),
          });
          if (window.__bmcpMutations.length > 500) window.__bmcpMutations.shift();
        }
      });
      window.__bmcpMutationObserver.observe(target, { childList: true, subtree: true, attributes: true, characterData: true });
      return { status: "started" };
    }, [selector]);
  }
  if (action === "stop") {
    return await injectAndRun(tabId, () => {
      if (window.__bmcpMutationObserver) { window.__bmcpMutationObserver.disconnect(); delete window.__bmcpMutationObserver; }
      const mutations = window.__bmcpMutations || [];
      delete window.__bmcpMutations;
      return { status: "stopped", entries: mutations.length };
    }, []);
  }
  return await injectAndRun(tabId, () => window.__bmcpMutations || [], []);
};

handlers.set_cookies = async ({ url, name, value, domain, path = "/", secure, httpOnly, expirationDate }) => {
  const opts = { url, name, value, path };
  if (domain) opts.domain = domain;
  if (secure != null) opts.secure = secure;
  if (httpOnly != null) opts.httpOnly = httpOnly;
  if (expirationDate != null) opts.expirationDate = expirationDate;
  return await chrome.cookies.set(opts);
};

// --- TEXT-BASED ELEMENT TARGETING ---

handlers.click_by_text = async ({ text, elementType = "*", exact = false, tabId }) => {
  return await injectAndRun(tabId, (txt, elType, isExact, css, svg) => {
    const clickable = elType === "button"
      ? 'button, [role="button"], input[type="button"], input[type="submit"], a'
      : elType === "link" ? "a" : "*";
    const candidates = Array.from(document.querySelectorAll(clickable));
    const el = candidates.find(e => {
      const t = e.textContent?.trim();
      return isExact ? t === txt : t?.includes(txt);
    });
    if (!el) throw new Error(`No element with text "${txt}" found (type: ${elType})`);

    const rect = el.getBoundingClientRect();
    const tx = rect.left + rect.width / 2, ty = rect.top + rect.height / 2;
    document.querySelectorAll(".__bmcp-cursor, .__bmcp-ripple, .__bmcp-cursor-style").forEach(e => e.remove());
    const s = document.createElement("style"); s.className = "__bmcp-cursor-style"; s.textContent = css; document.head.appendChild(s);

    const prev = window.__bmcp_cursorPos || { x: tx, y: Math.max(ty - 100, 0) };
    window.__bmcp_cursorPos = { x: tx, y: ty };

    const c = document.createElement("div"); c.className = "__bmcp-cursor"; c.innerHTML = svg;
    c.style.left = (prev.x - 5) + "px"; c.style.top = (prev.y - 2) + "px";
    c.style.opacity = "0"; document.body.appendChild(c);

    return new Promise(resolve => {
      requestAnimationFrame(() => {
        c.style.opacity = "1";
        c.style.left = (tx - 5) + "px"; c.style.top = (ty - 2) + "px";
        setTimeout(() => {
          c.classList.add("--press");
          const r1 = document.createElement("div"); r1.className = "__bmcp-ripple --fill";
          r1.style.left = tx + "px"; r1.style.top = ty + "px"; document.body.appendChild(r1);
          const r2 = document.createElement("div"); r2.className = "__bmcp-ripple --ring";
          r2.style.left = tx + "px"; r2.style.top = ty + "px"; document.body.appendChild(r2);
          setTimeout(() => {
            c.classList.remove("--press");
            el.click();
            resolve({ clicked: true, tagName: el.tagName, text: el.textContent?.trim().slice(0, 200) });
          }, 110);
          setTimeout(() => { c.style.opacity = "0"; }, 380);
          setTimeout(() => { document.querySelectorAll(".__bmcp-cursor,.__bmcp-ripple,.__bmcp-cursor-style").forEach(e => e.remove()); }, 750);
        }, 300);
      });
    });
  }, [text, elementType, exact, CURSOR_CSS, CURSOR_SVG]);
};

handlers.type_by_label = async ({ label, text, tabId }) => {
  showClickCursor(tabId, label + "::__ELTYPE__::label", "text");
  return await injectAndRun(tabId, (lbl, txt) => {
    // Strategy 1: Find <label> by text and use its `for` attribute
    let el;
    const labels = Array.from(document.querySelectorAll("label"));
    const matchLabel = labels.find(l => l.textContent?.trim().includes(lbl));
    if (matchLabel) {
      const forId = matchLabel.getAttribute("for");
      if (forId) el = document.getElementById(forId);
      if (!el) el = matchLabel.querySelector("input, textarea, select");
    }
    // Strategy 2: Find by placeholder
    if (!el) {
      el = document.querySelector(`input[placeholder*="${lbl}" i], textarea[placeholder*="${lbl}" i]`);
    }
    // Strategy 3: Find by aria-label
    if (!el) {
      el = document.querySelector(`input[aria-label*="${lbl}" i], textarea[aria-label*="${lbl}" i]`);
    }
    if (!el) throw new Error(`No input found for label "${lbl}"`);
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
    if (nativeSetter) { nativeSetter.call(el, txt); } else { el.value = txt; }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { typed: true, tagName: el.tagName, id: el.id || null };
  }, [label, text]);
};

handlers.get_interactive_elements = async ({ tabId, filter }) => {
  return await injectAndRun(tabId, (f) => {
    const selectors = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [onclick], [tabindex]';
    const els = Array.from(document.querySelectorAll(selectors));
    const results = els.map((el, idx) => {
      const text = el.textContent?.trim().slice(0, 200) || "";
      const tagName = el.tagName;
      const type = el.getAttribute("type") || "";
      const role = el.getAttribute("role") || "";
      const ariaLabel = el.getAttribute("aria-label") || "";
      const placeholder = el.getAttribute("placeholder") || "";
      const id = el.id || "";
      const name = el.getAttribute("name") || "";
      const href = el.href || "";
      const testId = el.getAttribute("data-testid") || el.getAttribute("data-test-id") || "";
      const isVisible = el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0;
      if (!isVisible) return null;

      // Build best unique selector
      let selector = "";
      if (id) selector = `#${CSS.escape(id)}`;
      else if (testId) selector = `[data-testid="${testId}"]`;
      else if (name && tagName === "INPUT") selector = `input[name="${name}"]`;
      else if (ariaLabel) selector = `${tagName.toLowerCase()}[aria-label="${ariaLabel}"]`;
      else if (text && (tagName === "BUTTON" || tagName === "A")) {
        // No good unique CSS selector — recommend text-based click
        selector = `[use browser_click_text with text="${text.slice(0, 60)}"]`;
      } else {
        // Generate nth-of-type selector
        const tag = tagName.toLowerCase();
        const parent = el.parentElement;
        if (parent) {
          const siblings = Array.from(parent.querySelectorAll(`:scope > ${tag}`));
          const nth = siblings.indexOf(el) + 1;
          selector = nth > 0 ? `${tag}:nth-of-type(${nth})` : tag;
        } else {
          selector = tag;
        }
      }

      return { tagName, text, type, role, ariaLabel, placeholder, id, name, href: href.slice(0, 200), testId, selector };
    }).filter(Boolean);

    if (!f) return results;
    const fl = f.toLowerCase();
    return results.filter(r =>
      r.text.toLowerCase().includes(fl) ||
      r.ariaLabel.toLowerCase().includes(fl) ||
      r.placeholder.toLowerCase().includes(fl) ||
      r.id.toLowerCase().includes(fl)
    );
  }, [filter || null]);
};

handlers.find_by_xpath = async ({ xpath, action = "click", text, tabId }) => {
  return await injectAndRun(tabId, (xp, act, txt, css, svg) => {
    const result = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const el = result.singleNodeValue;
    if (!el) throw new Error(`XPath not found: ${xp}`);
    if (act === "click") {
      const rect = el.getBoundingClientRect();
      const tx = rect.left + rect.width / 2, ty = rect.top + rect.height / 2;
      document.querySelectorAll(".__bmcp-cursor, .__bmcp-ripple, .__bmcp-cursor-style").forEach(e => e.remove());
      const s = document.createElement("style"); s.className = "__bmcp-cursor-style"; s.textContent = css; document.head.appendChild(s);

      const prev = window.__bmcp_cursorPos || { x: tx, y: Math.max(ty - 100, 0) };
      window.__bmcp_cursorPos = { x: tx, y: ty };

      const c = document.createElement("div"); c.className = "__bmcp-cursor"; c.innerHTML = svg;
      c.style.left = (prev.x - 5) + "px"; c.style.top = (prev.y - 2) + "px";
      c.style.opacity = "0"; document.body.appendChild(c);
      return new Promise(resolve => {
        requestAnimationFrame(() => {
          c.style.opacity = "1";
          c.style.left = (tx - 5) + "px"; c.style.top = (ty - 2) + "px";
          setTimeout(() => {
            c.classList.add("--press");
            const r1 = document.createElement("div"); r1.className = "__bmcp-ripple --fill";
            r1.style.left = tx + "px"; r1.style.top = ty + "px"; document.body.appendChild(r1);
            const r2 = document.createElement("div"); r2.className = "__bmcp-ripple --ring";
            r2.style.left = tx + "px"; r2.style.top = ty + "px"; document.body.appendChild(r2);
            setTimeout(() => {
              c.classList.remove("--press");
              el.click();
              resolve({ action: "clicked", tagName: el.tagName, text: el.textContent?.trim().slice(0, 200) });
            }, 110);
            setTimeout(() => { c.style.opacity = "0"; }, 380);
            setTimeout(() => { document.querySelectorAll(".__bmcp-cursor,.__bmcp-ripple,.__bmcp-cursor-style").forEach(e => e.remove()); }, 750);
          }, 300);
        });
      });
    }
    if (act === "type" && txt) {
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
      if (nativeSetter) { nativeSetter.call(el, txt); } else { el.value = txt; }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { action: "typed", tagName: el.tagName };
    }
    if (act === "read") {
      return { tagName: el.tagName, text: el.textContent?.trim().slice(0, 2000), html: el.outerHTML?.slice(0, 2000) };
    }
    return { tagName: el.tagName, text: el.textContent?.trim().slice(0, 200) };
  }, [xpath, action, text || null, CURSOR_CSS, CURSOR_SVG]);
};

// --- FILL FORM (multiple fields at once) ---

handlers.fill_form = async ({ fields, tabId }) => {
  return await injectAndRun(tabId, (fieldsData) => {
    function resolveElement(fieldDef) {
      // Strategy 1: CSS selector
      if (fieldDef.selector) {
        const el = document.querySelector(fieldDef.selector);
        if (el) return el;
      }
      // Strategy 2: label text → for attr or nested input
      if (fieldDef.label) {
        const lbl = fieldDef.label;
        const labels = Array.from(document.querySelectorAll("label"));
        const matchLabel = labels.find(l => l.textContent?.trim().toLowerCase().includes(lbl.toLowerCase()));
        if (matchLabel) {
          const forId = matchLabel.getAttribute("for");
          if (forId) { const el = document.getElementById(forId); if (el) return el; }
          const nested = matchLabel.querySelector("input, textarea, select");
          if (nested) return nested;
        }
        // Strategy 3: placeholder / aria-label match
        const byAttr = document.querySelector(
          `input[placeholder*="${lbl}" i], textarea[placeholder*="${lbl}" i], input[aria-label*="${lbl}" i], textarea[aria-label*="${lbl}" i]`
        );
        if (byAttr) return byAttr;
        // Strategy 4: name attribute match
        const byName = document.querySelector(`input[name*="${lbl}" i], textarea[name*="${lbl}" i]`);
        if (byName) return byName;
      }
      return null;
    }

    function fillElement(el, value) {
      if (el.tagName === "SELECT") {
        const options = Array.from(el.options);
        const match = options.find(o =>
          o.text.toLowerCase().includes(value.toLowerCase()) ||
          o.value.toLowerCase() === value.toLowerCase()
        );
        if (match) el.value = match.value;
        else el.value = value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { filled: true, type: "select", selectedText: el.options[el.selectedIndex]?.text };
      }
      if (el.type === "checkbox" || el.type === "radio") {
        const check = value === "true" || value === "1" || value === "on" || value === "checked";
        el.checked = check;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { filled: true, type: el.type, checked: el.checked };
      }
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
      if (nativeSetter) { nativeSetter.call(el, value); } else { el.value = value; }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { filled: true, type: el.type || el.tagName.toLowerCase() };
    }

    const results = [];
    for (const field of fieldsData) {
      const el = resolveElement(field);
      if (!el) {
        results.push({ field: field.selector || field.label, error: "Element not found" });
        continue;
      }
      const info = fillElement(el, String(field.value));
      results.push({ field: field.selector || field.label, ...info });
    }
    return results;
  }, [fields]);
};

// --- BATCH (run multiple actions sequentially) ---

handlers.batch = async ({ actions, tabId: defaultTabId }) => {
  const results = [];
  for (const action of actions) {
    const { command, params = {} } = action;
    const handler = handlers[command];
    if (!handler) {
      results.push({ command, error: `Unknown command: ${command}` });
      continue;
    }
    try {
      const mergedParams = { tabId: defaultTabId, ...params };
      const result = await Promise.race([
        handler(mergedParams),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Batch step '${command}' timed out`)), 30_000)),
      ]);
      results.push({ command, result });
    } catch (e) {
      results.push({ command, error: e.message || String(e) });
      if (action.abortOnError) break;
    }
  }
  return results;
};

// ============================================================
// Command Dispatcher
// ============================================================

async function handleCommand(msg) {
  const { id, action, params } = msg;
  const handler = handlers[action];
  if (!handler) return { id, error: `Unknown action: ${action}` };
  try {
    const result = await Promise.race([
      handler(params || {}),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Command '${action}' timed out after 55s`)), 55_000)),
    ]);
    return { id, result };
  } catch (e) {
    return { id, error: e.message || String(e) };
  }
}

// ============================================================
// Initialize
// ============================================================

connect();
updateBadge(false);
