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

  ws.onerror = () => { };

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
  // ── Chat Widget handlers ──
  if (msg.type === "chat_get_settings") {
    chrome.storage.local.get(["chatSettings"], (data) => sendResponse(data.chatSettings || {}));
    return true;
  }
  if (msg.type === "chat_save_settings") {
    chrome.storage.local.set({ chatSettings: msg.settings }, () => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "chat_send") {
    processChatMessage(msg, sender.tab?.id).then(sendResponse).catch(e => sendResponse({ error: e.message || String(e) }));
    return true;
  }
});

// ============================================================
// Chat AI Processing
// ============================================================

const CHAT_TOOLS = [
  {
    name: "read_page",
    description: "Read the text content of the current browser page. Returns page title, URL, and text content.",
    parameters: { type: "object", properties: { format: { type: "string", enum: ["text", "html"], description: "Output format — text (default) or html" } } },
  },
  {
    name: "click",
    description: "Click an element on the page. Use a CSS selector, aria-label, or visible button/link text. Prefer text content for React/dynamic sites.",
    parameters: { type: "object", properties: { selector: { type: "string", description: "CSS selector, aria-label value, or visible text of the element to click" } }, required: ["selector"] },
  },
  {
    name: "type",
    description: "Type text into an input field or textarea on the page.",
    parameters: { type: "object", properties: { selector: { type: "string", description: "CSS selector of the input/textarea" }, text: { type: "string", description: "Text to type" } }, required: ["selector", "text"] },
  },
  {
    name: "navigate",
    description: "Navigate the browser to a URL. Opens in a new tab.",
    parameters: { type: "object", properties: { url: { type: "string", description: "The URL to navigate to" } }, required: ["url"] },
  },
  {
    name: "scroll",
    description: "Scroll the page in a direction or to a specific element.",
    parameters: { type: "object", properties: { direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Scroll direction" }, pixels: { type: "number", description: "Pixels to scroll (default 500)" }, selector: { type: "string", description: "CSS selector to scroll to (overrides direction)" } } },
  },
  {
    name: "inspect_page",
    description: "Get a map of all interactive elements on the page (buttons, inputs, links, forms). Use this to understand what actions are available.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_links",
    description: "Extract all links from the current page with their text and href.",
    parameters: { type: "object", properties: { filter: { type: "string", description: "Optional text filter to narrow results" } } },
  },
  {
    name: "get_elements",
    description: "Query elements by CSS selector and return their attributes.",
    parameters: { type: "object", properties: { selector: { type: "string", description: "CSS selector to query" }, limit: { type: "number", description: "Max results (default 50)" } }, required: ["selector"] },
  },
  {
    name: "execute_js",
    description: "Execute JavaScript code on the page and return the result. Use for complex interactions or data extraction.",
    parameters: { type: "object", properties: { code: { type: "string", description: "JavaScript code to execute" } }, required: ["code"] },
  },
  {
    name: "screenshot",
    description: "Take a screenshot of the visible tab area. Returns a base64-encoded PNG data URL.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "back",
    description: "Go back in browser history.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "forward",
    description: "Go forward in browser history.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "click_by_text",
    description: "Click an element by its visible text content. Best for dynamic sites where CSS selectors are unreliable.",
    parameters: { type: "object", properties: { text: { type: "string", description: "Visible text of the element" }, elementType: { type: "string", enum: ["button", "link", "*"], description: "Type filter (default *)" } }, required: ["text"] },
  },
  {
    name: "fill_form",
    description: "Fill multiple form fields at once. Each field can be targeted by selector, label, or name.",
    parameters: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              selector: { type: "string", description: "CSS selector" },
              label: { type: "string", description: "Label text" },
              name: { type: "string", description: "Input name attribute" },
              value: { type: "string", description: "Value to set" },
            },
            required: ["value"],
          },
          description: "Array of fields to fill",
        },
      },
      required: ["fields"],
    },
  },
];

async function executeChatTool(name, args, tabId) {
  switch (name) {
    case "read_page":      return await handlers.read_page({ tabId, format: args.format || "text" });
    case "click":          return await handlers.click({ tabId, selector: args.selector });
    case "type":           return await handlers.type({ tabId, selector: args.selector, text: args.text });
    case "navigate":       return await handlers.navigate({ tabId, url: args.url, waitMs: 2000 });
    case "scroll":         return await handlers.scroll({ tabId, direction: args.direction, pixels: args.pixels, selector: args.selector });
    case "inspect_page":   return await handlers.inspect_page({ tabId });
    case "get_links":      return await handlers.get_links({ tabId, filter: args.filter });
    case "get_elements":   return await handlers.get_elements({ tabId, selector: args.selector, limit: args.limit || 50 });
    case "execute_js":     return await handlers.execute_js({ tabId, code: args.code });
    case "screenshot":     return await handlers.screenshot({ tabId });
    case "back":           return await handlers.back({ tabId });
    case "forward":        return await handlers.forward({ tabId });
    case "click_by_text":  return await handlers.click_by_text({ tabId, text: args.text, elementType: args.elementType || "*" });
    case "fill_form":      return await handlers.fill_form({ tabId, fields: args.fields });
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

function truncateToolResult(result) {
  const str = typeof result === "string" ? result : JSON.stringify(result);
  return str.length > 8000 ? str.slice(0, 8000) + "\n...[truncated]" : str;
}

async function processChatMessage({ messages, provider, model }, tabId) {
  const data = await chrome.storage.local.get(["chatSettings"]);
  const chatSettings = data.chatSettings || {};
  const apiKey = provider === "openai" ? chatSettings.openaiKey : chatSettings.claudeKey;
  if (!apiKey) throw new Error("API key not configured. Open settings (gear icon) to add your key.");

  // Get current page context
  let pageContext = "";
  try {
    if (tabId) {
      const tab = await chrome.tabs.get(tabId);
      pageContext = `Current page: ${tab.url}\nTitle: ${tab.title}`;
    }
  } catch {}

  const systemPrompt = `You are Browser Bros, an AI browser assistant embedded in a Chrome extension. You can interact with the user's current browser tab using the available tools.

${pageContext}

Guidelines:
- Use read_page to understand what's on the current page before taking actions.
- Use inspect_page to discover interactive elements (buttons, inputs, links).
- For clicking, prefer click_by_text on dynamic sites, or use CSS selectors for specific elements.
- Use fill_form for filling multiple form fields efficiently.
- Keep responses concise and helpful.
- When you perform actions, briefly describe what you did and the result.
- If a tool fails, try alternative approaches (different selector strategies, etc).`;

  if (provider === "openai") {
    return await chatWithOpenAI(apiKey, model, systemPrompt, messages, tabId);
  } else {
    return await chatWithClaude(apiKey, model, systemPrompt, messages, tabId);
  }
}

// ── OpenAI Chat Loop ──────────────────────────────────────────
async function chatWithOpenAI(apiKey, model, systemPrompt, history, tabId) {
  const openaiMessages = [
    { role: "system", content: systemPrompt },
    ...history.map(m => ({ role: m.role, content: m.content })),
  ];
  const openaiTools = CHAT_TOOLS.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const toolsUsed = [];
  const MAX_ROUNDS = 12;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: openaiMessages, tools: openaiTools, tool_choice: "auto" }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message || `OpenAI API error: ${resp.status}`);
    }

    const data = await resp.json();
    const choice = data.choices?.[0];
    if (!choice) throw new Error("No response from OpenAI");
    const msg = choice.message;
    openaiMessages.push(msg);

    if (msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
        const toolName = tc.function.name;

        // Notify content script
        if (tabId) chrome.tabs.sendMessage(tabId, { type: "chat_tool_start", tool: toolName, args }).catch(() => {});

        let result;
        try {
          result = await executeChatTool(toolName, args, tabId);
        } catch (e) {
          result = { error: e.message || String(e) };
        }

        const resultStr = truncateToolResult(result);
        toolsUsed.push({ name: toolName, args });

        if (tabId) chrome.tabs.sendMessage(tabId, { type: "chat_tool_done", tool: toolName }).catch(() => {});

        openaiMessages.push({ role: "tool", tool_call_id: tc.id, content: resultStr });
      }
      continue; // Loop for next AI response
    }

    // Final text response
    return { text: msg.content || "", toolsUsed };
  }
  // Hit max rounds — return partial result with continue option
  const lastMsg = openaiMessages[openaiMessages.length - 1];
  const partialText = lastMsg?.content || "I was still working on this but hit the tool call limit.";
  return { text: partialText + "\n\n*Reached tool call limit. Click **Continue** to keep going.*", toolsUsed, canContinue: true };
}

// ── Claude Chat Loop ──────────────────────────────────────────
async function chatWithClaude(apiKey, model, systemPrompt, history, tabId) {
  const claudeTools = CHAT_TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));

  // Build Claude messages — convert flat history to Claude format
  let claudeMessages = history.map(m => ({ role: m.role, content: m.content }));

  const toolsUsed = [];
  const MAX_ROUNDS = 12;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: claudeMessages,
        tools: claudeTools,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message || `Claude API error: ${resp.status}`);
    }

    const data = await resp.json();

    // Check for tool use in response
    const toolUseBlocks = (data.content || []).filter(b => b.type === "tool_use");
    const textBlocks = (data.content || []).filter(b => b.type === "text");
    const responseText = textBlocks.map(b => b.text).join("\n");

    if (toolUseBlocks.length > 0 && data.stop_reason === "tool_use") {
      // Add assistant message with all content blocks
      claudeMessages.push({ role: "assistant", content: data.content });

      const toolResults = [];
      for (const tu of toolUseBlocks) {
        const toolName = tu.name;
        const args = tu.input || {};

        if (tabId) chrome.tabs.sendMessage(tabId, { type: "chat_tool_start", tool: toolName, args }).catch(() => {});

        let result;
        try {
          result = await executeChatTool(toolName, args, tabId);
        } catch (e) {
          result = { error: e.message || String(e) };
        }

        const resultStr = truncateToolResult(result);
        toolsUsed.push({ name: toolName, args });

        if (tabId) chrome.tabs.sendMessage(tabId, { type: "chat_tool_done", tool: toolName }).catch(() => {});

        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: resultStr });
      }

      claudeMessages.push({ role: "user", content: toolResults });
      continue;
    }

    // Final text response
    return { text: responseText, toolsUsed };
  }
  // Hit max rounds — return partial result with continue option
  const lastTextBlocks = (claudeMessages[claudeMessages.length - 1]?.content || []);
  const partialText = Array.isArray(lastTextBlocks)
    ? lastTextBlocks.filter(b => b.type === "text").map(b => b.text).join("\n")
    : String(lastTextBlocks);
  const displayText = partialText || "I was still working on this but hit the tool call limit.";
  return { text: displayText + "\n\n*Reached tool call limit. Click **Continue** to keep going.*", toolsUsed, canContinue: true };
}

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

// ─── Visual design tokens ─────────────────────────────────────────────────────
const CURSOR_CSS = `
  /* ── Cursor arrow ── */
  .__bmcp-cursor{
    position:fixed;z-index:2147483647;pointer-events:none;
    width:26px;height:26px;
    filter:drop-shadow(0 2px 6px rgba(0,0,0,.55)) drop-shadow(0 0 14px rgba(255,255,255,.2));
    transition:left .28s cubic-bezier(.22,1,.36,1),top .28s cubic-bezier(.22,1,.36,1),opacity .16s ease,transform .1s ease;
    transform-origin:4px 2px;will-change:left,top;
  }
  .__bmcp-cursor.--press{transform:scale(.66) rotate(-10deg)}

  /* ── Action badge – glass pill next to cursor ── */
  .__bmcp-badge{
    position:fixed;z-index:2147483647;pointer-events:none;
    display:flex;align-items:center;gap:5px;
    background:rgba(12,12,12,.82);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
    border:1px solid rgba(255,255,255,.13);border-radius:20px;
    padding:4px 11px 4px 9px;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
    font-size:11.5px;font-weight:600;color:rgba(255,255,255,.9);letter-spacing:.1px;white-space:nowrap;
    box-shadow:0 6px 24px rgba(0,0,0,.45),0 1px 4px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.07);
    animation:__bmcp-badge-pop .18s cubic-bezier(.22,1,.36,1);
    transition:left .28s cubic-bezier(.22,1,.36,1),top .28s cubic-bezier(.22,1,.36,1),background .2s ease,opacity .18s ease;
  }
  .__bmcp-badge.--done{background:rgba(5,150,105,.88)!important;border-color:rgba(52,211,153,.35)!important;}
  @keyframes __bmcp-badge-pop{from{opacity:0;transform:scale(.75) translateX(-8px)}to{opacity:1;transform:scale(1) translateX(0)}}

  /* ── Target reticle – draws around element before click ── */
  .__bmcp-target{
    position:fixed;z-index:2147483644;pointer-events:none;border-radius:5px;
    animation:__bmcp-target-draw .24s cubic-bezier(.22,1,.36,1) forwards;
  }
  @keyframes __bmcp-target-draw{
    0%  {outline:2px solid rgba(255,255,255,0);box-shadow:none;transform:scale(1.14)}
    55% {outline:2px solid rgba(255,255,255,.85);box-shadow:0 0 18px 4px rgba(139,92,246,.4),inset 0 0 8px rgba(139,92,246,.15);transform:scale(1.03)}
    100%{outline:2px solid rgba(255,255,255,.18);box-shadow:none;transform:scale(1)}
  }

  /* ── Ripple (white – visible on any background) ── */
  .__bmcp-ripple{position:fixed;z-index:2147483646;pointer-events:none;border-radius:50%;transform:translate(-50%,-50%)}
  .__bmcp-ripple.--fill{width:0;height:0;background:radial-gradient(circle,rgba(255,255,255,.35) 0%,rgba(255,255,255,0) 70%);animation:__bmcp-rf .42s ease-out forwards}
  .__bmcp-ripple.--ring{width:0;height:0;border:1.5px solid rgba(255,255,255,.55);animation:__bmcp-rr .52s ease-out .03s forwards}
  @keyframes __bmcp-rf{0%{width:0;height:0;opacity:1}100%{width:68px;height:68px;opacity:0}}
  @keyframes __bmcp-rr{0%{width:0;height:0;opacity:.9}100%{width:56px;height:56px;opacity:0}}

  /* ── Spotlight overlay ── */
  .__bmcp-spotlight{
    position:fixed;inset:0;z-index:2147483639;pointer-events:none;
    background:rgba(0,0,0,.18);
    animation:__bmcp-sp-in .18s ease-out,__bmcp-sp-out .28s ease-in .52s forwards;
  }
  @keyframes __bmcp-sp-in{from{opacity:0}to{opacity:1}}
  @keyframes __bmcp-sp-out{from{opacity:1}to{opacity:0}}

  /* ── Typing glow ring ── */
  .__bmcp-type-ring{
    position:fixed;z-index:2147483645;pointer-events:none;border-radius:7px;
    box-shadow:0 0 0 2.5px rgba(99,102,241,.8),0 0 18px rgba(99,102,241,.45);
    animation:__bmcp-tr-pulse 1.3s ease-in-out infinite;
  }
  @keyframes __bmcp-tr-pulse{
    0%,100%{box-shadow:0 0 0 2.5px rgba(99,102,241,.8),0 0 18px rgba(99,102,241,.45)}
    50%{box-shadow:0 0 0 3.5px rgba(99,102,241,.5),0 0 28px rgba(99,102,241,.22)}
  }
`;
// Glossy black arrow with white outline — high-contrast on any page
const CURSOR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26"><path d="M4 2L4 20L9 15.5L15.5 23L19 20.5L12.5 13L20 13Z" fill="#111" stroke="#fff" stroke-width="1.35" stroke-linejoin="round" stroke-linecap="round"/></svg>';


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
  }, [selector, selectorType, CURSOR_CSS, CURSOR_SVG]).catch(() => { });
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

handlers.navigate = async ({ tabId, url, waitMs = 1000 }) => {
  let targetTabId = tabId;
  if (targetTabId) {
    // Navigate the current tab instead of opening a new one
    await chrome.tabs.update(targetTabId, { url, active: true });
    await waitForTabLoad(targetTabId);
  } else {
    // Fallback: create new tab if no current tab available
    const tab = await chrome.tabs.create({ url, active: true });
    targetTabId = tab.id;
    if (tab.status !== "complete") await waitForTabLoad(targetTabId);
  }
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  if (!isInjectableUrl(url)) return { title: url, url, text: `[Cannot extract content from ${url}]`, meta: {} };
  return await extractContent(targetTabId, "text");
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

// Universal element finder — works on Tailwind/CSS-in-JS sites without stable selectors
// Returns the best matching element using 8 progressive strategies
function findSmartElement(query, context = document) {
  const q = query.trim();
  const ql = q.toLowerCase();

  // 1. Exact CSS selector (id, data-testid, aria-label attr)
  try {
    const el = context.querySelector(q);
    if (el) return el;
  } catch { }

  // 2. aria-label exact or partial
  for (const tag of ["button", "a", "input", "textarea", "select", "[role]", "*"]) {
    const els = context.querySelectorAll(tag);
    const found = Array.from(els).find(e => {
      const al = (e.getAttribute("aria-label") || "").toLowerCase();
      return al === ql || al.includes(ql);
    });
    if (found) return found;
    if (tag === "[role]") break;
  }

  // 3. data-testid / data-test-id / data-cy / data-qa
  for (const attr of ["data-testid", "data-test-id", "data-cy", "data-qa", "data-id"]) {
    const el = context.querySelector(`[${attr}*="${q}" i]`) || context.querySelector(`[${attr}="${q}"]`);
    if (el) return el;
  }

  // 4. Visible text content — prefer innermost (shortest textContent)
  const clickable = Array.from(context.querySelectorAll('button,[role="button"],[role="tab"],[role="menuitem"],[role="option"],a,summary'));
  const textMatches = clickable.filter(e => {
    const t = (e.textContent || "").trim().toLowerCase();
    return t === ql || t.includes(ql);
  });
  if (textMatches.length) {
    return textMatches.reduce((best, cur) =>
      (cur.textContent || "").trim().length < (best.textContent || "").trim().length ? cur : best
    );
  }

  // 5. title / placeholder / name fallback
  const byAttr = context.querySelector(
    `[title*="${q}" i],[placeholder*="${q}" i],[name*="${q}" i]`
  );
  if (byAttr) return byAttr;

  return null;
}

handlers.click = async ({ selector, tabId, waitForSelector, waitForSelectorTimeout = 5000 }) => {
  const result = await injectAndRun(tabId, (sel, css, svg) => {
    // ── Element resolution with smart fallback ────────────────────────────────
    let el = null;
    try { el = document.querySelector(sel); } catch { }
    if (!el) {
      const q = sel.replace(/^[#.\['"]/, "").replace(/[\]'"]/g, "").toLowerCase();
      el = document.querySelector(`[aria-label*="${sel}" i]`);
      if (!el) el = document.querySelector(`[data-testid*="${sel}" i],[data-cy*="${sel}" i]`);
      if (!el) {
        const clickable = Array.from(document.querySelectorAll('button,[role="button"],a,[role="tab"],[role="menuitem"]'));
        const m = clickable.filter(e => (e.textContent || '').trim().toLowerCase().includes(q));
        if (m.length) el = m.reduce((b, c) => (c.textContent || '').trim().length < (b.textContent || '').trim().length ? c : b);
      }
    }
    if (!el) throw new Error(`Element not found: ${sel}`);

    // ── Scroll into view ─────────────────────────────────────────────────────
    const r0 = el.getBoundingClientRect();
    if (r0.top < 0 || r0.bottom > window.innerHeight) el.scrollIntoView({ block: "center", behavior: "instant" });
    const rect = el.getBoundingClientRect();
    const tx = rect.left + rect.width / 2, ty = rect.top + rect.height / 2;

    // ── Build DOM layer ───────────────────────────────────────────────────────
    document.querySelectorAll(".__bmcp-cursor,.__bmcp-ripple,.__bmcp-cursor-style,.__bmcp-badge,.__bmcp-target,.__bmcp-spotlight").forEach(e => e.remove());
    const s = document.createElement("style"); s.className = "__bmcp-cursor-style"; s.textContent = css; document.head.appendChild(s);

    // Spotlight
    const spot = document.createElement("div"); spot.className = "__bmcp-spotlight"; document.body.appendChild(spot);

    // Cursor — starts from previous known position
    const prev = window.__bmcp_cursorPos || { x: tx, y: Math.max(ty - 80, 0) };
    window.__bmcp_cursorPos = { x: tx, y: ty };
    const c = document.createElement("div"); c.className = "__bmcp-cursor"; c.innerHTML = svg;
    c.style.left = (prev.x - 4) + "px"; c.style.top = (prev.y - 2) + "px"; c.style.opacity = "0";
    document.body.appendChild(c);

    // Action badge — floats to the right of cursor
    const badge = document.createElement("div"); badge.className = "__bmcp-badge";
    badge.innerHTML = '<span style="font-size:13px">⌥</span><span>Click</span>';
    badge.style.left = (prev.x + 22) + "px"; badge.style.top = (prev.y - 13) + "px";
    document.body.appendChild(badge);

    return new Promise(resolve => {
      requestAnimationFrame(() => {
        // Cursor glides to target
        c.style.opacity = "1";
        c.style.left = (tx - 4) + "px"; c.style.top = (ty - 2) + "px";
        // Badge follows cursor
        badge.style.left = (tx + 22) + "px"; badge.style.top = (ty - 13) + "px";

        // ── After cursor lands (0.28s) ────────────────────────────────────────
        setTimeout(() => {
          // Target reticle ring
          const tring = document.createElement("div"); tring.className = "__bmcp-target";
          tring.style.cssText = `left:${rect.left - 4}px;top:${rect.top - 4}px;width:${rect.width + 8}px;height:${rect.height + 8}px`;
          document.body.appendChild(tring);

          // Cursor squish
          c.classList.add("--press");

          // ── Fire click after squish (90ms) ────────────────────────────────
          setTimeout(() => {
            c.classList.remove("--press");

            // Ripple burst
            const r1 = document.createElement("div"); r1.className = "__bmcp-ripple --fill";
            r1.style.left = tx + "px"; r1.style.top = ty + "px"; document.body.appendChild(r1);
            const rr = document.createElement("div"); rr.className = "__bmcp-ripple --ring";
            rr.style.left = tx + "px"; rr.style.top = ty + "px"; document.body.appendChild(rr);

            // Fire full pointer event sequence — required for React synthetic events
            const evOpts = { bubbles: true, cancelable: true, view: window, clientX: tx, clientY: ty };
            el.dispatchEvent(new MouseEvent("pointerover", evOpts));
            el.dispatchEvent(new MouseEvent("mouseover", evOpts));
            el.dispatchEvent(new MouseEvent("pointermove", evOpts));
            el.dispatchEvent(new MouseEvent("mousemove", evOpts));
            el.dispatchEvent(new MouseEvent("pointerdown", evOpts));
            el.dispatchEvent(new MouseEvent("mousedown", evOpts));
            el.dispatchEvent(new MouseEvent("pointerup", evOpts));
            el.dispatchEvent(new MouseEvent("mouseup", evOpts));
            el.dispatchEvent(new MouseEvent("click", evOpts));
            el.click(); // native fallback for non-React elements

            // Badge → "✓ Done" flash
            badge.classList.add("--done");
            badge.innerHTML = '<span style="font-size:13px">✓</span><span>Done</span>';

            resolve({ clicked: true, tagName: el.tagName, text: (el.textContent || '').trim().slice(0, 200), wasVisible: rect.width > 0 || rect.height > 0 });

            setTimeout(() => { c.style.opacity = "0"; badge.style.opacity = "0"; }, 300);
            setTimeout(() => { document.querySelectorAll(".__bmcp-cursor,.__bmcp-ripple,.__bmcp-cursor-style,.__bmcp-badge,.__bmcp-target,.__bmcp-spotlight").forEach(e => e.remove()); }, 820);
          }, 90);
        }, 280);
      });
    });
  }, [selector, CURSOR_CSS, CURSOR_SVG]);
  if (waitForSelector) await handlers.wait_for({ selector: waitForSelector, timeout: waitForSelectorTimeout, tabId });
  return result;
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
  }, [selector, text], "MAIN");
};

handlers.screenshot = async ({ tabId }) => {
  const tab = await getTargetTab(tabId);
  return await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
};

handlers.execute_js = async ({ code, tabId }) => {
  return await injectAndRun(tabId, (jsCode) => (0, eval)(`(function(){\n${jsCode}\n})()`), [code], "MAIN");
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

handlers.wait_for_navigation = async ({ urlPattern, timeout = 10000, tabId }) => {
  const tab = await getTargetTab(tabId);
  const startUrl = tab.url || "";
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = async () => {
      if (Date.now() - start > timeout) {
        reject(new Error(`Navigation timeout after ${timeout}ms (still at ${startUrl})`));
        return;
      }
      try {
        const currentTab = await chrome.tabs.get(tab.id);
        const currentUrl = currentTab.url || "";
        const urlChanged = currentUrl !== startUrl && currentUrl !== "about:blank";
        const patternMatch = urlPattern ? currentUrl.includes(urlPattern) : urlChanged;
        if (patternMatch) {
          // Brief pause to let SPA finish rendering after URL change
          await new Promise(r => setTimeout(r, 200));
          resolve({ url: currentUrl, navigated: true });
        } else {
          setTimeout(check, 150);
        }
      } catch {
        reject(new Error("Tab no longer available"));
      }
    };
    setTimeout(check, 150);
  });
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

handlers.get_elements = async ({ selector, attributes = ["textContent", "href", "src", "alt", "value", "class", "id"], limit = 50, maxTextLength = 300, includeInnerText = false, tabId }) => {
  return await injectAndRun(tabId, (sel, attrs, lim, maxLen, withInnerText) => {
    const els = Array.from(document.querySelectorAll(sel)).slice(0, lim);
    return els.map((el) => {
      const obj = { tagName: el.tagName };
      for (const attr of attrs) {
        if (attr === "textContent") obj[attr] = el.textContent?.trim().slice(0, maxLen) || "";
        else if (attr in el) obj[attr] = el[attr] ?? "";
        else obj[attr] = el.getAttribute(attr) ?? "";
      }
      if (withInnerText) obj.innerText = el.innerText?.trim().slice(0, maxLen) || "";
      return obj;
    });
  }, [selector, attributes, limit, maxTextLength, includeInnerText]);
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
      try { result.jsonLd.push(JSON.parse(s.textContent)); } catch { }
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
      ? 'button,[role="button"],input[type="button"],input[type="submit"],a,[role="tab"],[role="menuitem"],[role="option"]'
      : elType === "link" ? "a" : 'button,[role="button"],a,[role="tab"],[role="menuitem"],[role="option"],[onclick],[tabindex],*';
    const candidates = Array.from(document.querySelectorAll(clickable));
    const matches = candidates.filter(e => {
      const t = (e.textContent || "").trim();
      return isExact ? t === txt : t.includes(txt);
    });
    if (!matches.length) throw new Error(`No element with text "${txt}" found (type: ${elType})`);
    const el = matches.reduce((best, cur) => {
      const bt = (best.textContent || "").trim(), ct = (cur.textContent || "").trim();
      if (ct === txt && bt !== txt) return cur;
      if (bt === txt && ct !== txt) return best;
      return ct.length < bt.length ? cur : best;
    });

    // Scroll into view
    const r0 = el.getBoundingClientRect();
    if (r0.top < 0 || r0.bottom > window.innerHeight) el.scrollIntoView({ block: "center", behavior: "instant" });
    const rect = el.getBoundingClientRect();
    const tx = rect.left + rect.width / 2, ty = rect.top + rect.height / 2;

    document.querySelectorAll(".__bmcp-cursor,.__bmcp-ripple,.__bmcp-cursor-style,.__bmcp-badge,.__bmcp-target,.__bmcp-spotlight").forEach(e => e.remove());
    const s = document.createElement("style"); s.className = "__bmcp-cursor-style"; s.textContent = css; document.head.appendChild(s);

    // Spotlight
    const spot = document.createElement("div"); spot.className = "__bmcp-spotlight"; document.body.appendChild(spot);

    const prev = window.__bmcp_cursorPos || { x: tx, y: Math.max(ty - 80, 0) };
    window.__bmcp_cursorPos = { x: tx, y: ty };
    const c = document.createElement("div"); c.className = "__bmcp-cursor"; c.innerHTML = svg;
    c.style.left = (prev.x - 4) + "px"; c.style.top = (prev.y - 2) + "px"; c.style.opacity = "0";
    document.body.appendChild(c);

    const badge = document.createElement("div"); badge.className = "__bmcp-badge";
    badge.innerHTML = '<span style="font-size:13px">⌥</span><span>Click</span>';
    badge.style.left = (prev.x + 22) + "px"; badge.style.top = (prev.y - 13) + "px";
    document.body.appendChild(badge);

    return new Promise(resolve => {
      requestAnimationFrame(() => {
        c.style.opacity = "1";
        c.style.left = (tx - 4) + "px"; c.style.top = (ty - 2) + "px";
        badge.style.left = (tx + 22) + "px"; badge.style.top = (ty - 13) + "px";

        setTimeout(() => {
          const tring = document.createElement("div"); tring.className = "__bmcp-target";
          tring.style.cssText = `left:${rect.left - 4}px;top:${rect.top - 4}px;width:${rect.width + 8}px;height:${rect.height + 8}px`;
          document.body.appendChild(tring);
          c.classList.add("--press");

          setTimeout(() => {
            c.classList.remove("--press");
            const r1 = document.createElement("div"); r1.className = "__bmcp-ripple --fill";
            r1.style.left = tx + "px"; r1.style.top = ty + "px"; document.body.appendChild(r1);
            const rr = document.createElement("div"); rr.className = "__bmcp-ripple --ring";
            rr.style.left = tx + "px"; rr.style.top = ty + "px"; document.body.appendChild(rr);
            // Full pointer/mouse event sequence for React synthetic events
            const evOpts = { bubbles: true, cancelable: true, view: window, clientX: tx, clientY: ty };
            el.dispatchEvent(new MouseEvent("pointerover", evOpts));
            el.dispatchEvent(new MouseEvent("mouseover", evOpts));
            el.dispatchEvent(new MouseEvent("pointerdown", evOpts));
            el.dispatchEvent(new MouseEvent("mousedown", evOpts));
            el.dispatchEvent(new MouseEvent("pointerup", evOpts));
            el.dispatchEvent(new MouseEvent("mouseup", evOpts));
            el.dispatchEvent(new MouseEvent("click", evOpts));
            el.click();
            badge.classList.add("--done");
            badge.innerHTML = '<span style="font-size:13px">✓</span><span>Done</span>';
            resolve({ clicked: true, tagName: el.tagName, text: (el.textContent || '').trim().slice(0, 200) });
            setTimeout(() => { c.style.opacity = "0"; badge.style.opacity = "0"; }, 300);
            setTimeout(() => { document.querySelectorAll(".__bmcp-cursor,.__bmcp-ripple,.__bmcp-cursor-style,.__bmcp-badge,.__bmcp-target,.__bmcp-spotlight").forEach(e => e.remove()); }, 820);
          }, 90);
        }, 280);
      });
    });
  }, [text, elementType, exact, CURSOR_CSS, CURSOR_SVG]);
};


handlers.type_by_label = async ({ label, text, tabId }) => {
  return await injectAndRun(tabId, (lbl, txt, css) => {
    const lbl_l = lbl.toLowerCase();
    let el = null;

    // S1: <label> text → for= or nested input
    const lbEls = Array.from(document.querySelectorAll("label"));
    const matchLb = lbEls.find(l => (l.textContent || '').trim().toLowerCase().includes(lbl_l));
    if (matchLb) {
      const forId = matchLb.getAttribute("for");
      if (forId) el = document.getElementById(forId);
      if (!el) el = matchLb.querySelector("input,textarea,select");
    }
    // S2: aria-label
    if (!el) el = document.querySelector(`input[aria-label*="${lbl}" i],textarea[aria-label*="${lbl}" i],select[aria-label*="${lbl}" i]`);
    // S3: placeholder
    if (!el) el = document.querySelector(`input[placeholder*="${lbl}" i],textarea[placeholder*="${lbl}" i]`);
    // S4: name attribute
    if (!el) el = document.querySelector(`input[name*="${lbl}" i],textarea[name*="${lbl}" i],select[name*="${lbl}" i]`);
    // S5: id contains label text
    if (!el) el = document.querySelector(`input[id*="${lbl}" i],textarea[id*="${lbl}" i]`);
    // S6: data-testid / data-label
    if (!el) el = document.querySelector(`[data-testid*="${lbl}" i],[data-label*="${lbl}" i]`);
    // S7: container text heuristic
    if (!el) {
      const allInputs = Array.from(document.querySelectorAll("input:not([type=hidden]),textarea,select"));
      el = allInputs.find(inp => {
        const parent = inp.closest("div,section,fieldset,li,tr");
        return parent && (parent.textContent || '').toLowerCase().includes(lbl_l);
      }) || null;
    }
    if (!el) throw new Error(`No input found for label "${lbl}". Tried label/aria-label/placeholder/name/id/data-testid/container-text.`);

    // Scroll into view if needed
    const r0 = el.getBoundingClientRect();
    if (r0.top < 0 || r0.bottom > window.innerHeight) el.scrollIntoView({ block: "center", behavior: "instant" });
    const rect = el.getBoundingClientRect();

    // ── Visual: typing glow ring + badge ────────────────────────────────────
    document.querySelectorAll(".__bmcp-cursor-style,.__bmcp-type-ring,.__bmcp-badge").forEach(e => e.remove());
    const styleEl = document.createElement("style"); styleEl.className = "__bmcp-cursor-style"; styleEl.textContent = css; document.head.appendChild(styleEl);

    // Glow ring around the field
    const ring = document.createElement("div"); ring.className = "__bmcp-type-ring";
    ring.style.cssText = `left:${rect.left - 3}px;top:${rect.top - 3}px;width:${rect.width + 6}px;height:${rect.height + 6}px`;
    document.body.appendChild(ring);

    // Badge above the field: "✎ Typing..."
    const badge = document.createElement("div"); badge.className = "__bmcp-badge";
    badge.innerHTML = '<span style="font-size:13px">✎</span><span>Typing…</span>';
    // Position badge above the field (or below if field is near top)
    const bTop = rect.top > 40 ? rect.top - 34 : rect.bottom + 8;
    badge.style.cssText = `left:${rect.left}px;top:${bTop}px`;
    document.body.appendChild(badge);

    // Focus and fill using native setter (React/Vue/Angular compatible)
    el.focus();
    el.select?.();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
    if (nativeSetter) { nativeSetter.call(el, txt); } else { el.value = txt; }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: txt, inputType: "insertText" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));

    // Update badge to "✓ Filled" then clean up
    setTimeout(() => {
      badge.classList.add("--done");
      badge.innerHTML = '<span style="font-size:13px">✓</span><span>Filled</span>';
    }, 200);
    setTimeout(() => {
      badge.style.opacity = "0";
      document.querySelectorAll(".__bmcp-type-ring").forEach(e => e.remove());
    }, 700);
    setTimeout(() => document.querySelectorAll(".__bmcp-type-ring,.__bmcp-cursor-style,.__bmcp-badge").forEach(e => e.remove()), 1000);

    return { typed: true, tagName: el.tagName, id: el.id || null, strategy: "multi-strategy" };
  }, [label, text, CURSOR_CSS]);
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
              const evOpts = { bubbles: true, cancelable: true, view: window, clientX: tx, clientY: ty };
              el.dispatchEvent(new MouseEvent("pointerover", evOpts));
              el.dispatchEvent(new MouseEvent("mouseover", evOpts));
              el.dispatchEvent(new MouseEvent("pointerdown", evOpts));
              el.dispatchEvent(new MouseEvent("mousedown", evOpts));
              el.dispatchEvent(new MouseEvent("pointerup", evOpts));
              el.dispatchEvent(new MouseEvent("mouseup", evOpts));
              el.dispatchEvent(new MouseEvent("click", evOpts));
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
        if (el) return { el, strategy: "selector" };
      }
      // Strategy 2: label text → for attr or nested input
      if (fieldDef.label) {
        const lbl = fieldDef.label;
        const labels = Array.from(document.querySelectorAll("label"));
        const matchLabel = labels.find(l => l.textContent?.trim().toLowerCase().includes(lbl.toLowerCase()));
        if (matchLabel) {
          const forId = matchLabel.getAttribute("for");
          if (forId) { const el = document.getElementById(forId); if (el) return { el, strategy: "label[for]" }; }
          const nested = matchLabel.querySelector("input, textarea, select");
          if (nested) return { el: nested, strategy: "label>nested" };
        }
        // Strategy 3: aria-label match
        const byAria = document.querySelector(`input[aria-label*="${lbl}" i], textarea[aria-label*="${lbl}" i]`);
        if (byAria) return { el: byAria, strategy: "aria-label" };
        // Strategy 4: placeholder match
        const byPlaceholder = document.querySelector(`input[placeholder*="${lbl}" i], textarea[placeholder*="${lbl}" i]`);
        if (byPlaceholder) return { el: byPlaceholder, strategy: "placeholder" };
        // Strategy 5: name attribute match
        const byName = document.querySelector(`input[name*="${lbl}" i], textarea[name*="${lbl}" i]`);
        if (byName) return { el: byName, strategy: "name" };
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
      const resolved = resolveElement(field);
      if (!resolved) {
        results.push({ field: field.selector || field.label, error: "Element not found" });
        continue;
      }
      const info = fillElement(resolved.el, String(field.value));
      results.push({ field: field.selector || field.label, strategy: resolved.strategy, ...info });
    }
    return results;
  }, [fields], "MAIN");
};

// --- INSPECT PAGE (full interactive element map) ---

handlers.inspect_page = async ({ tabId, scope }) => {
  return await injectAndRun(tabId, (scopeSel) => {
    // Build a unique, verified CSS selector for an element
    function uniqueSelector(el) {
      if (el.id) {
        const sel = `#${CSS.escape(el.id)}`;
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
      for (const attr of ["data-testid", "data-test-id", "data-cy", "data-qa"]) {
        const val = el.getAttribute(attr);
        if (val) {
          const sel = `[${attr}="${CSS.escape(val)}"]`;
          if (document.querySelectorAll(sel).length === 1) return sel;
        }
      }
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) {
        const tag = el.tagName.toLowerCase();
        const sel = `${tag}[aria-label="${ariaLabel.replace(/"/g, '\\"')}"]`;
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
      const name = el.getAttribute("name");
      if (name) {
        const tag = el.tagName.toLowerCase();
        const sel = `${tag}[name="${CSS.escape(name)}"]`;
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
      // Walk up building a path
      const parts = [];
      let node = el;
      while (node && node !== document.body) {
        const tag = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (!parent) break;
        const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        const nth = siblings.indexOf(node) + 1;
        parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${nth})` : tag);
        node = parent;
        const candidate = parts.join(" > ");
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      }
      return parts.join(" > ") || el.tagName.toLowerCase();
    }

    // Resolve visible label for an element
    function resolveLabel(el) {
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) return lbl.textContent?.trim() || "";
      }
      const wrapping = el.closest("label");
      if (wrapping) {
        const clone = wrapping.cloneNode(true);
        clone.querySelectorAll("input,textarea,select").forEach(c => c.remove());
        const t = clone.textContent?.trim();
        if (t) return t;
      }
      return el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || "";
    }

    // Is element in viewport?
    function inViewport(rect) {
      return rect.width > 0 && rect.height > 0 &&
        rect.top < window.innerHeight && rect.bottom > 0 &&
        rect.left < window.innerWidth && rect.right > 0;
    }

    const root = scopeSel ? document.querySelector(scopeSel) : document.body;
    if (!root) return { error: `Scope element not found: ${scopeSel}` };

    // Page context: headings
    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .filter(h => h.offsetParent !== null)
      .map(h => ({ level: parseInt(h.tagName[1]), text: h.textContent?.trim().slice(0, 120) || "" }))
      .slice(0, 10);

    // Collect all interactive elements
    const INTERACTIVE = 'a[href], button, input:not([type="hidden"]), textarea, select, [role="button"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [role="option"], [contenteditable="true"]';
    const all = Array.from(root.querySelectorAll(INTERACTIVE));

    // Group by nearest form ancestor (null = top-level)
    const formMap = new Map(); // form el → array of element infos
    const topLevel = [];

    for (const el of all) {
      const rect = el.getBoundingClientRect();
      // Skip truly invisible (not just off-screen)
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;

      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute("type") || "";
      const role = el.getAttribute("role") || tag;

      // Determine action hint
      let actionHint = "click";
      if (tag === "input" && !["button", "submit", "reset", "checkbox", "radio", "file"].includes(type)) actionHint = "type/fill";
      if (tag === "textarea") actionHint = "type/fill";
      if (tag === "select") actionHint = "fill_form (select)";
      if (type === "checkbox" || type === "radio" || role === "checkbox" || role === "radio" || role === "switch") actionHint = "click (toggle)";

      // Select options
      let options = undefined;
      if (tag === "select") {
        options = Array.from(el.options).map(o => ({ value: o.value, text: o.text, selected: o.selected }));
      }

      const info = {
        tag,
        type: type || undefined,
        role: (role !== tag) ? role : undefined,
        label: resolveLabel(el),
        text: (tag === "button" || tag === "a" || (el.getAttribute("role") || "").includes("button"))
          ? el.textContent?.trim().slice(0, 120) || ""
          : undefined,
        selector: uniqueSelector(el),
        value: (el.value !== undefined && el.value !== "") ? el.value.slice(0, 200) : undefined,
        checked: el.type === "checkbox" || el.type === "radio" ? el.checked : undefined,
        state: {
          disabled: el.disabled || el.getAttribute("aria-disabled") === "true" || undefined,
          required: el.required || el.getAttribute("aria-required") === "true" || undefined,
          readonly: el.readOnly || undefined,
          inViewport: inViewport(rect),
        },
        rect: { top: Math.round(rect.top), left: Math.round(rect.left), w: Math.round(rect.width), h: Math.round(rect.height) },
        options,
        actionHint,
        href: (tag === "a" && el.href) ? el.href.slice(0, 200) : undefined,
      };
      // Remove undefined keys
      Object.keys(info).forEach(k => info[k] === undefined && delete info[k]);
      Object.keys(info.state).forEach(k => info.state[k] === undefined && delete info.state[k]);

      const form = el.closest("form");
      if (form) {
        if (!formMap.has(form)) formMap.set(form, { name: form.getAttribute("name") || form.id || null, action: form.getAttribute("action") || null, elements: [] });
        formMap.get(form).elements.push(info);
      } else {
        topLevel.push(info);
      }
    }

    const forms = Array.from(formMap.values());

    return {
      url: location.href,
      title: document.title,
      headings,
      forms,
      topLevelElements: topLevel,
      totalInteractive: all.length,
    };
  }, [scope || null]);
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
