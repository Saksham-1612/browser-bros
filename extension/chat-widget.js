// BrowserMCP — Chat Widget Content Script
// Injects a floating AI chat interface into every page (bottom-left).
// Uses Shadow DOM to isolate styles from the host page.

(function () {
  if (document.getElementById('__bmcp-chat-root')) return;

  // ── Shadow DOM host ──────────────────────────────────────────
  const host = document.createElement('div');
  host.id = '__bmcp-chat-root';
  host.style.cssText = 'position:fixed!important;z-index:2147483640!important;bottom:0!important;right:0!important;width:0!important;height:0!important;overflow:visible!important;display:block!important;visibility:visible!important;opacity:1!important;pointer-events:none!important;margin:0!important;padding:0!important;border:none!important;';
  (document.body || document.documentElement).appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  // ── Styles ───────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    *, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }

    :host { font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif; }

    /* ── Bubble ── */
    .bubble {
      position: fixed; bottom: 20px; right: 20px;
      width: 52px; height: 52px; border-radius: 50%;
      background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%);
      box-shadow: 0 4px 24px rgba(79,70,229,0.5), 0 0 0 0 rgba(79,70,229,0.4);
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
      animation: bubble-pulse 2.5s ease-in-out infinite;
      pointer-events: auto;
    }
    .bubble:hover { transform: scale(1.1); box-shadow: 0 6px 32px rgba(79,70,229,0.65); }
    .bubble:active { transform: scale(0.95); }
    .bubble.hidden { display: none; }
    .bubble svg { width: 26px; height: 26px; fill: #fff; }

    /* Unread badge on bubble */
    .bubble .unread-dot {
      position: absolute; top: 2px; right: 2px;
      width: 14px; height: 14px; border-radius: 50%;
      background: #EF4444; border: 2px solid #07090F;
      display: none;
    }
    .bubble .unread-dot.show { display: block; }

    @keyframes bubble-pulse {
      0%,100% { box-shadow: 0 4px 24px rgba(79,70,229,0.5), 0 0 0 0 rgba(79,70,229,0.3); }
      50%     { box-shadow: 0 4px 24px rgba(79,70,229,0.5), 0 0 0 10px rgba(79,70,229,0); }
    }

    /* ── Panel ── */
    .panel {
      position: fixed; bottom: 20px; right: 20px;
      width: 400px; height: 560px;
      background: #07090F;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 20px;
      display: flex; flex-direction: column;
      overflow: hidden;
      box-shadow: 0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.05);
      transform: scale(0.9) translateY(20px); opacity: 0;
      transition: transform 0.25s cubic-bezier(0.22,1,0.36,1), opacity 0.2s ease;
      pointer-events: none;
    }
    .panel.open {
      transform: scale(1) translateY(0); opacity: 1;
      pointer-events: auto;
    }

    /* ── Header ── */
    .header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 16px;
      background: rgba(255,255,255,0.03);
      border-bottom: 1px solid rgba(255,255,255,0.06);
      flex-shrink: 0;
    }
    .header-left { display: flex; align-items: center; gap: 10px; }
    .header-logo {
      width: 30px; height: 30px; border-radius: 8px;
      background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%);
      display: flex; align-items: center; justify-content: center;
    }
    .header-logo svg { width: 18px; height: 18px; fill: #fff; }
    .header-title {
      font-size: 15px; font-weight: 700; color: #F1F5F9;
      letter-spacing: -0.02em;
    }
    .header-actions { display: flex; gap: 4px; }
    .hdr-btn {
      width: 30px; height: 30px; border-radius: 8px;
      background: transparent; border: 1px solid transparent;
      color: #4B5563; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.15s ease;
      font-size: 16px;
    }
    .hdr-btn:hover { background: rgba(255,255,255,0.06); color: #9CA3AF; border-color: rgba(255,255,255,0.08); }
    .hdr-btn.active { background: rgba(79,70,229,0.15); color: #818CF8; border-color: rgba(99,102,241,0.3); }

    /* ── Settings Panel ── */
    .settings {
      max-height: 0; overflow: hidden;
      transition: max-height 0.3s ease, padding 0.3s ease;
      background: rgba(255,255,255,0.02);
      border-bottom: 1px solid transparent;
      padding: 0 16px;
    }
    .settings.open {
      max-height: 350px;
      padding: 14px 16px;
      border-bottom-color: rgba(255,255,255,0.06);
    }
    .setting-group { margin-bottom: 10px; }
    .setting-group:last-child { margin-bottom: 0; }
    .setting-label {
      font-size: 10px; font-weight: 600; color: #4B5563;
      text-transform: uppercase; letter-spacing: 0.08em;
      margin-bottom: 5px; display: block;
    }
    .setting-row { display: flex; gap: 8px; }
    .sel, .inp {
      flex: 1; height: 36px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px; color: #E2E8F0;
      font-family: inherit; font-size: 12px;
      padding: 0 10px;
      transition: border-color 0.15s;
      outline: none;
    }
    .sel { cursor: pointer; -webkit-appearance: none; appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 5l3 3 3-3' stroke='%234B5563' stroke-width='1.5' fill='none'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 10px center;
      padding-right: 28px;
    }
    .sel option { background: #0F1219; color: #E2E8F0; }
    .inp:focus, .sel:focus { border-color: rgba(99,102,241,0.5); }
    .inp::placeholder { color: #2D3A4E; }
    .save-btn {
      width: 100%; height: 34px; margin-top: 10px;
      background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%);
      border: none; border-radius: 10px;
      color: #fff; font-family: inherit; font-size: 12px; font-weight: 600;
      cursor: pointer; transition: opacity 0.15s;
    }
    .save-btn:hover { opacity: 0.9; }
    .save-btn:active { transform: scale(0.98); }
    .save-toast {
      font-size: 11px; color: #10B981; text-align: center;
      margin-top: 6px; opacity: 0; transition: opacity 0.2s;
    }
    .save-toast.show { opacity: 1; }

    /* ── Messages area ── */
    .messages {
      flex: 1; overflow-y: auto; padding: 14px 16px;
      display: flex; flex-direction: column; gap: 10px;
      scroll-behavior: smooth;
      position: relative;
    }
    .messages::-webkit-scrollbar { width: 4px; }
    .messages::-webkit-scrollbar-track { background: transparent; }
    .messages::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }

    /* Message bubbles */
    .msg-wrap { display: flex; flex-direction: column; max-width: 88%; animation: msg-in 0.25s ease-out; }
    .no-anim { animation: none !important; }
    .msg-wrap.user { align-self: flex-end; align-items: flex-end; }
    .msg-wrap.ai { align-self: flex-start; align-items: flex-start; }

    .msg { padding: 10px 14px; border-radius: 16px; font-size: 13px; line-height: 1.55; word-wrap: break-word; }

    .msg-user {
      background: linear-gradient(135deg, #4F46E5 0%, #6D28D9 100%);
      color: #fff; border-bottom-right-radius: 6px;
    }
    .msg-ai {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.07);
      color: #D1D5DB; border-bottom-left-radius: 6px;
    }
    .msg-ai strong { color: #F1F5F9; }
    .msg-ai code {
      background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 4px;
      font-family: 'SF Mono','Fira Code','Consolas',monospace; font-size: 12px; color: #A78BFA;
    }
    .msg-ai pre {
      background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px; padding: 10px; margin: 8px 0; overflow-x: auto;
      position: relative;
    }
    .msg-ai pre code { background: none; padding: 0; color: #D1D5DB; font-size: 11.5px; }
    .msg-ai a { color: #818CF8; text-decoration: none; }
    .msg-ai a:hover { text-decoration: underline; }
    .msg-ai ul, .msg-ai ol { padding-left: 18px; margin: 4px 0; }
    .msg-ai li { margin: 2px 0; }

    /* Message meta row (timestamp + copy) */
    .msg-meta {
      display: flex; align-items: center; gap: 8px;
      margin-top: 4px; padding: 0 4px;
      opacity: 0; transition: opacity 0.15s;
    }
    .msg-wrap:hover .msg-meta { opacity: 1; }
    .msg-time {
      font-size: 10px; color: #3D4F6A;
    }
    .copy-btn {
      background: none; border: none; cursor: pointer;
      color: #3D4F6A; padding: 2px;
      display: flex; align-items: center; justify-content: center;
      transition: color 0.15s;
      border-radius: 4px;
    }
    .copy-btn:hover { color: #818CF8; }
    .copy-btn svg { width: 12px; height: 12px; }
    .copy-btn.copied { color: #10B981; }

    .msg-system {
      align-self: center; text-align: center;
      font-size: 11px; color: #3D4F6A;
      padding: 4px 12px;
    }

    @keyframes msg-in {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* Tool usage indicator */
    .tool-badge {
      align-self: flex-start;
      display: inline-flex; align-items: center; gap: 6px;
      background: rgba(99,102,241,0.08);
      border: 1px solid rgba(99,102,241,0.18);
      border-radius: 10px; padding: 6px 12px;
      font-size: 11px; color: #818CF8; font-weight: 500;
      animation: msg-in 0.2s ease-out;
    }
    .tool-badge .spinner {
      width: 12px; height: 12px; border: 2px solid rgba(129,140,248,0.3);
      border-top-color: #818CF8; border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }
    .tool-badge .check { color: #10B981; font-weight: 700; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Restore indicator (shown after navigation while polling for response) */
    .restore-indicator {
      align-self: center; text-align: center;
      font-size: 11px; color: #4B5563;
      padding: 6px 14px; border-radius: 10px;
      background: rgba(99,102,241,0.06);
      border: 1px solid rgba(99,102,241,0.12);
      display: flex; align-items: center; gap: 8px;
    }
    .restore-indicator .ri-spin {
      width: 10px; height: 10px; border: 1.5px solid rgba(129,140,248,0.3);
      border-top-color: #818CF8; border-radius: 50%;
      animation: spin 0.8s linear infinite; flex-shrink: 0;
    }

    /* Thinking indicator */
    .thinking {
      align-self: flex-start;
      display: flex; align-items: center; gap: 8px;
      padding: 10px 14px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 16px; border-bottom-left-radius: 6px;
      animation: msg-in 0.2s ease-out;
    }
    .thinking-dots { display: flex; gap: 4px; }
    .thinking-dots span {
      width: 6px; height: 6px; border-radius: 50%;
      background: #4B5563;
      animation: dot-bounce 1.2s ease-in-out infinite;
    }
    .thinking-dots span:nth-child(2) { animation-delay: 0.15s; }
    .thinking-dots span:nth-child(3) { animation-delay: 0.3s; }
    @keyframes dot-bounce {
      0%,60%,100% { transform: translateY(0); opacity: 0.4; }
      30%          { transform: translateY(-6px); opacity: 1; }
    }

    /* ── Scroll-to-bottom button ── */
    .scroll-bottom {
      position: sticky; bottom: 8px;
      align-self: center;
      width: 32px; height: 32px; border-radius: 50%;
      background: rgba(79,70,229,0.9);
      border: 1px solid rgba(255,255,255,0.15);
      color: #fff; cursor: pointer;
      display: none; align-items: center; justify-content: center;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      transition: transform 0.15s, opacity 0.15s;
      z-index: 10;
    }
    .scroll-bottom:hover { transform: scale(1.1); }
    .scroll-bottom.show { display: flex; }
    .scroll-bottom svg { width: 16px; height: 16px; fill: #fff; }

    /* ── Input area ── */
    .input-area {
      display: flex; flex-direction: column; gap: 4px;
      padding: 12px 16px;
      background: rgba(255,255,255,0.02);
      border-top: 1px solid rgba(255,255,255,0.06);
      flex-shrink: 0;
    }
    .input-row {
      display: flex; align-items: flex-end; gap: 8px;
    }
    .input-wrap {
      flex: 1; position: relative;
    }
    .chat-input {
      width: 100%; min-height: 38px; max-height: 120px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px; padding: 9px 12px;
      color: #E2E8F0; font-family: inherit; font-size: 13px;
      line-height: 1.4; resize: none; outline: none;
      transition: border-color 0.15s;
    }
    .chat-input:focus { border-color: rgba(99,102,241,0.5); }
    .chat-input::placeholder { color: #2D3A4E; }

    /* Char count */
    .char-count {
      position: absolute; bottom: 4px; right: 8px;
      font-size: 9px; color: #2D3A4E;
      pointer-events: none;
      transition: color 0.15s;
    }
    .char-count.warn { color: #F59E0B; }

    .action-btn {
      width: 38px; height: 38px; flex-shrink: 0;
      border: none; border-radius: 12px;
      color: #fff; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: opacity 0.15s, transform 0.1s;
    }
    .action-btn:hover { opacity: 0.9; }
    .action-btn:active { transform: scale(0.93); }
    .action-btn:disabled { opacity: 0.3; cursor: not-allowed; }
    .action-btn svg { width: 18px; height: 18px; fill: #fff; }

    .send-btn {
      background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%);
    }

    .stop-btn {
      background: linear-gradient(135deg, #DC2626 0%, #EF4444 100%);
      animation: stop-pulse 1.5s ease-in-out infinite;
    }
    @keyframes stop-pulse {
      0%,100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.4); }
      50%     { box-shadow: 0 0 0 6px rgba(239,68,68,0); }
    }

    .voice-btn {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.08);
      width: 34px; height: 34px; border-radius: 10px;
      color: #4B5563; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.15s;
      flex-shrink: 0;
    }
    .voice-btn:hover { background: rgba(255,255,255,0.1); color: #9CA3AF; border-color: rgba(255,255,255,0.15); }
    .voice-btn.recording {
      background: rgba(239,68,68,0.15); color: #EF4444;
      border-color: rgba(239,68,68,0.3);
      animation: voice-pulse 1s ease-in-out infinite;
    }
    .voice-btn svg { width: 16px; height: 16px; }
    @keyframes voice-pulse {
      0%,100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.3); }
      50%     { box-shadow: 0 0 0 6px rgba(239,68,68,0); }
    }
    .voice-btn.unsupported { display: none; }

    /* ── Provider badge ── */
    .provider-badge {
      display: flex; align-items: center; gap: 5px;
      font-size: 10px; color: #3D4F6A; font-weight: 500;
      padding: 0;
    }
    .provider-badge .dot {
      width: 5px; height: 5px; border-radius: 50%;
      background: #3D4F6A;
    }
    .provider-badge.ready .dot { background: #10B981; }
    .provider-badge.ready { color: #4B7A6A; }

    /* ── Welcome state ── */
    .welcome {
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 12px;
      padding: 40px 24px; text-align: center; flex: 1;
    }
    .welcome-icon {
      width: 56px; height: 56px; border-radius: 16px;
      background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%);
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 8px 32px rgba(79,70,229,0.35);
    }
    .welcome-icon svg { width: 28px; height: 28px; fill: #fff; }
    .welcome h3 {
      font-size: 16px; font-weight: 700; color: #F1F5F9;
      letter-spacing: -0.02em;
    }
    .welcome p {
      font-size: 12px; color: #4B5563; line-height: 1.5;
      max-width: 280px;
    }
    .welcome .setup-hint {
      font-size: 11px; color: #818CF8; cursor: pointer;
      padding: 6px 14px; border-radius: 8px;
      background: rgba(99,102,241,0.1);
      border: 1px solid rgba(99,102,241,0.2);
      transition: background 0.15s;
    }
    .welcome .setup-hint:hover { background: rgba(99,102,241,0.18); }

    /* ── Quick suggestion chips ── */
    .suggestions {
      display: flex; flex-wrap: wrap; gap: 6px;
      justify-content: center; margin-top: 8px;
    }
    .suggestion-chip {
      font-size: 11px; color: #818CF8; cursor: pointer;
      padding: 5px 12px; border-radius: 16px;
      background: rgba(99,102,241,0.08);
      border: 1px solid rgba(99,102,241,0.15);
      transition: all 0.15s; font-family: inherit;
      white-space: nowrap;
    }
    .suggestion-chip:hover { background: rgba(99,102,241,0.18); border-color: rgba(99,102,241,0.3); }

    /* ── Error message ── */
    .msg-error {
      align-self: flex-start;
      background: rgba(239,68,68,0.08);
      border: 1px solid rgba(239,68,68,0.2);
      color: #F87171; border-radius: 12px;
      padding: 8px 12px; font-size: 12px;
      animation: msg-in 0.2s ease-out;
    }

    /* ── Continue button ── */
    .continue-btn {
      align-self: center;
      display: inline-flex; align-items: center; gap: 6px;
      background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%);
      border: none; border-radius: 12px;
      padding: 8px 20px;
      color: #fff; font-family: inherit; font-size: 12px; font-weight: 600;
      cursor: pointer; transition: opacity 0.15s, transform 0.1s;
      animation: msg-in 0.2s ease-out;
    }
    .continue-btn:hover { opacity: 0.9; }
    .continue-btn:active { transform: scale(0.95); }
    .continue-btn svg { width: 14px; height: 14px; fill: #fff; }

    /* ── Resize handle ── */
    .resize-handle {
      position: absolute; top: 0; left: 0;
      width: 20px; height: 20px; cursor: nw-resize;
      display: flex; align-items: center; justify-content: center;
      opacity: 0; transition: opacity 0.15s;
    }
    .panel:hover .resize-handle { opacity: 0.4; }
    .resize-handle:hover { opacity: 0.8 !important; }
    .resize-handle svg { width: 10px; height: 10px; }
  `;
  shadow.appendChild(style);

  // ── HTML ─────────────────────────────────────────────────────
  const container = document.createElement('div');
  container.innerHTML = `
    <!-- Floating Bubble -->
    <div class="bubble" id="bubble">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
        <circle cx="8" cy="10" r="1.2"/>
        <circle cx="12" cy="10" r="1.2"/>
        <circle cx="16" cy="10" r="1.2"/>
      </svg>
      <span class="unread-dot" id="unreadDot"></span>
    </div>

    <!-- Chat Panel -->
    <div class="panel" id="panel">
      <!-- Resize handle -->
      <div class="resize-handle" id="resizeHandle">
        <svg viewBox="0 0 10 10" fill="none" stroke="#4B5563" stroke-width="1.5">
          <line x1="0" y1="10" x2="10" y2="0"/>
          <line x1="0" y1="6" x2="6" y2="0"/>
        </svg>
      </div>

      <!-- Header -->
      <div class="header">
        <div class="header-left">
          <div class="header-logo">
            <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
          </div>
          <span class="header-title">Browser Bros</span>
        </div>
        <div class="header-actions">
          <button class="hdr-btn" id="settingsBtn" title="Settings">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6.5 1.5L6.9 3.1a4.5 4.5 0 011.2.5l1.4-.8 1.4 1.4-.8 1.4c.2.4.4.8.5 1.2l1.6.4v2l-1.6.4a4.5 4.5 0 01-.5 1.2l.8 1.4-1.4 1.4-1.4-.8c-.4.2-.8.4-1.2.5L9.5 14.5h-2L7.1 12.9a4.5 4.5 0 01-1.2-.5l-1.4.8-1.4-1.4.8-1.4a4.5 4.5 0 01-.5-1.2L1.8 8.8v-2l1.6-.4c.1-.4.3-.8.5-1.2l-.8-1.4 1.4-1.4 1.4.8c.4-.2.8-.4 1.2-.5L7.5 1.5h2z" stroke="currentColor" stroke-width="1.2" fill="none"/><circle cx="8.5" cy="7.8" r="1.8" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>
          </button>
          <button class="hdr-btn" id="clearBtn" title="Clear chat">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 5h8M5.5 5V4a1 1 0 011-1h3a1 1 0 011 1v1M6 7v4M8 7v4M10 7v4M4.5 5l.5 8a1 1 0 001 1h4a1 1 0 001-1l.5-8" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>
          </button>
          <button class="hdr-btn" id="closeBtn" title="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>

      <!-- Settings Drawer -->
      <div class="settings" id="settings">
        <div class="setting-group">
          <label class="setting-label">Provider</label>
          <select class="sel" id="providerSel">
            <option value="openai">OpenAI (GPT)</option>
            <option value="claude">Anthropic (Claude)</option>
          </select>
        </div>
        <div class="setting-group">
          <label class="setting-label">Model</label>
          <select class="sel" id="modelSel"></select>
        </div>
        <div class="setting-group">
          <label class="setting-label">API Key</label>
          <input class="inp" id="apiKeyInp" type="password" placeholder="sk-... or sk-ant-...">
        </div>
        <button class="save-btn" id="saveBtn">Save Settings</button>
        <div class="save-toast" id="saveToast">Settings saved</div>
      </div>

      <!-- Messages / Welcome -->
      <div class="messages" id="messages">
        <div class="welcome" id="welcome">
          <div class="welcome-icon">
            <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
          </div>
          <h3>Browser Bros Chat</h3>
          <p>AI assistant that can read, click, type, and navigate your browser. Set up your API key to get started.</p>
          <div class="setup-hint" id="setupHint">Configure API Key</div>
          <div class="suggestions" id="suggestions">
            <button class="suggestion-chip" data-text="Summarize this page">Summarize page</button>
            <button class="suggestion-chip" data-text="What links are on this page?">Find links</button>
            <button class="suggestion-chip" data-text="What can I do on this page?">Inspect page</button>
            <button class="suggestion-chip" data-text="Read the main content of this page">Read content</button>
          </div>
        </div>
        <button class="scroll-bottom" id="scrollBottom">
          <svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>
        </button>
      </div>

      <!-- Input -->
      <div class="input-area">
        <div class="provider-badge" id="providerBadge">
          <span class="dot"></span>
          <span id="providerLabel">No API key</span>
        </div>
        <div class="input-row">
          <button class="voice-btn" id="voiceBtn" title="Voice input">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
          </button>
          <div class="input-wrap">
            <textarea class="chat-input" id="chatInput" placeholder="Ask me anything..." rows="1"></textarea>
            <span class="char-count" id="charCount"></span>
          </div>
          <button class="action-btn send-btn" id="sendBtn" disabled title="Send message (Enter)">
            <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
          <button class="action-btn stop-btn" id="stopBtn" style="display:none" title="Stop generating">
            <svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="#fff"/></svg>
          </button>
        </div>
      </div>
    </div>
  `;
  shadow.appendChild(container);

  // ── DOM refs ─────────────────────────────────────────────────
  const $ = (id) => shadow.querySelector('#' + id);
  const bubble = $('bubble');
  const unreadDot = $('unreadDot');
  const panel = $('panel');
  const settingsBtn = $('settingsBtn');
  const settingsDrawer = $('settings');
  const clearBtn = $('clearBtn');
  const closeBtn = $('closeBtn');
  const providerSel = $('providerSel');
  const modelSel = $('modelSel');
  const apiKeyInp = $('apiKeyInp');
  const saveBtn = $('saveBtn');
  const saveToast = $('saveToast');
  const messagesEl = $('messages');
  const welcomeEl = $('welcome');
  const setupHint = $('setupHint');
  const chatInput = $('chatInput');
  const sendBtn = $('sendBtn');
  const stopBtn = $('stopBtn');
  const voiceBtn = $('voiceBtn');
  const charCount = $('charCount');
  const providerBadge = $('providerBadge');
  const providerLabel = $('providerLabel');
  const scrollBottomBtn = $('scrollBottom');
  const resizeHandle = $('resizeHandle');

  // ── State ────────────────────────────────────────────────────
  let isOpen = false;
  let settingsOpen = false;
  let isProcessing = false;
  let ownRequest = false; // true only when THIS script instance started the request
  let abortController = null;
  let conversationHistory = [];
  let settings = { provider: 'openai', model: 'gpt-4o', openaiKey: '', claudeKey: '' };
  let isRecording = false;
  let recognition = null;
  let myTabId = null; // set on init via background — makes storage keys tab-specific

  const MODELS = {
    openai: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
      { id: 'gpt-4.1', name: 'GPT-4.1' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
      { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano' },
      { id: 'o3-mini', name: 'o3-mini' },
    ],
    claude: [
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
      { id: 'claude-opus-4-20250514', name: 'Claude Opus 4' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
    ],
  };

  // ── Chat persistence (tab-scoped, survives same-tab navigation) ─
  // Keys are keyed to myTabId so different tabs never share state.
  function storageKeys() {
    const id = myTabId || 'unknown';
    return {
      history:    `_chat_history_${id}`,
      open:       `_chat_open_${id}`,
      processing: `_chat_processing_${id}`,
      pending:    `_chat_pending_${id}`,
    };
  }

  function saveChat() {
    try {
      const k = storageKeys();
      chrome.storage.local.set({
        [k.history]:    conversationHistory,
        [k.open]:       isOpen,
        [k.processing]: isProcessing,
      });
    } catch {}
  }

  function restoreChat() {
    return new Promise((resolve) => {
      try {
        const k = storageKeys();
        chrome.storage.local.get([k.history, k.open, k.processing], (data) => {
          if (chrome.runtime.lastError) { resolve(); return; }
          if (data[k.history]?.length) {
            conversationHistory = data[k.history];
            welcomeEl.style.display = 'none';
            for (const msg of conversationHistory) {
              addMessage(msg.role, msg.content, { animate: false });
            }
          }
          if (data[k.open]) {
            isOpen = true;
            bubble.classList.add('hidden');
            panel.classList.add('open');
          }
          // If background was processing when page navigated, wait for response.
          // Use a separate restore-indicator (NOT #__thinking) to avoid conflicts.
          if (data[k.processing]) {
            addRestoreIndicator();
            setProcessingUI(true);
            waitForPendingResponse();
          }
          resolve();
        });
      } catch { resolve(); }
    });
  }

  // Wait for background to write the final response — event-driven, no interval race
  function waitForPendingResponse() {
    const k = storageKeys();
    const progressKey = `_chat_tool_progress_${myTabId}`;
    let handled = false;
    const liveToolBadges = new Map(); // toolName → badge el, for live updates

    function handleResponse(resp) {
      if (handled) return;
      handled = true;
      chrome.storage.onChanged.removeListener(storageListener);
      clearTimeout(timeoutId);
      removeRestoreIndicator();
      liveToolBadges.clear();

      if (resp.error) {
        addMessage('error', resp.error);
      } else {
        if (resp.toolsUsed?.length) {
          for (const tool of resp.toolsUsed) {
            addToolBadge(tool.name, 'done');
          }
        }
        addMessage('assistant', resp.text);
        conversationHistory.push({ role: 'assistant', content: resp.text });
        if (resp.canContinue) addContinueButton();
      }
      // setProcessingUI(false) must come before saveChat so _chatProcessing saves as false
      setProcessingUI(false);
    }

    function updateLiveProgress(prog) {
      if (!prog || handled) return;
      const ri = shadow.querySelector('#__restore-indicator span');
      const toolLabel = prog.name.replace(/_/g, ' ');
      if (prog.type === 'chat_tool_start') {
        if (ri) ri.textContent = `Running ${toolLabel}…`;
        if (!liveToolBadges.has(prog.name)) {
          addToolBadge(prog.name, 'running');
          liveToolBadges.set(prog.name, true);
        }
      } else if (prog.type === 'chat_tool_done') {
        if (ri) ri.textContent = `Done: ${toolLabel}…`;
        updateToolBadge(prog.name);
      }
    }

    function storageListener(changes) {
      // Live tool progress
      if (changes[progressKey]?.newValue) {
        updateLiveProgress(changes[progressKey].newValue);
      }
      // Final response
      if (!changes[k.pending]) return;
      const resp = changes[k.pending].newValue;
      if (!resp) return;
      chrome.storage.local.remove(k.pending);
      handleResponse(resp);
    }
    chrome.storage.onChanged.addListener(storageListener);

    // Immediate checks — both may already be written before listener registered
    chrome.storage.local.get([k.pending, progressKey], (data) => {
      if (chrome.runtime.lastError) return;
      if (data[progressKey]) updateLiveProgress(data[progressKey]);
      if (data[k.pending]) {
        chrome.storage.local.remove(k.pending);
        handleResponse(data[k.pending]);
      }
    });

    const timeoutId = setTimeout(() => {
      if (handled) return;
      handled = true;
      chrome.storage.onChanged.removeListener(storageListener);
      removeRestoreIndicator();
      addMessage('system', 'Request timed out after navigation.');
      setProcessingUI(false);
    }, 120000);
  }

  // ── Voice recognition setup ─────────────────────────────────
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      // Replace current input or append after existing text
      const existing = chatInput.value.trimEnd();
      if (existing) {
        chatInput.value = existing + ' ' + transcript;
      } else {
        chatInput.value = transcript;
      }
      autoResize();
      updateCharCount();
      sendBtn.disabled = !getActiveKey() || !chatInput.value.trim();
    };

    recognition.onend = () => {
      isRecording = false;
      voiceBtn.classList.remove('recording');
      voiceBtn.title = 'Voice input';
    };

    recognition.onerror = (event) => {
      isRecording = false;
      voiceBtn.classList.remove('recording');
      if (event.error !== 'aborted' && event.error !== 'no-speech') {
        addMessage('error', `Voice error: ${event.error}`);
      }
    };
  } else {
    voiceBtn.classList.add('unsupported');
  }

  function toggleVoice() {
    if (!recognition) return;
    if (isRecording) {
      recognition.stop();
    } else {
      isRecording = true;
      voiceBtn.classList.add('recording');
      voiceBtn.title = 'Stop recording';
      recognition.start();
    }
  }

  // ── Model selector ───────────────────────────────────────────
  function populateModels() {
    const models = MODELS[settings.provider] || MODELS.openai;
    modelSel.innerHTML = models.map(m => `<option value="${m.id}"${m.id === settings.model ? ' selected' : ''}>${m.name}</option>`).join('');
    if (!models.find(m => m.id === settings.model)) {
      settings.model = models[0].id;
      modelSel.value = settings.model;
    }
  }

  // ── Settings I/O ─────────────────────────────────────────────
  function loadSettings() {
    chrome.runtime.sendMessage({ type: 'chat_get_settings' }, (data) => {
      if (chrome.runtime.lastError) return;
      if (data && typeof data === 'object') {
        Object.assign(settings, data);
        providerSel.value = settings.provider;
        populateModels();
        apiKeyInp.value = getActiveKey();
        updateProviderBadge();
      }
    });
  }

  function saveSettings() {
    settings.provider = providerSel.value;
    settings.model = modelSel.value;
    const key = apiKeyInp.value.trim();
    if (settings.provider === 'openai') settings.openaiKey = key;
    else settings.claudeKey = key;

    chrome.runtime.sendMessage({ type: 'chat_save_settings', settings }, () => {
      if (chrome.runtime.lastError) return;
      saveToast.classList.add('show');
      setTimeout(() => saveToast.classList.remove('show'), 2000);
      updateProviderBadge();
    });
  }

  function getActiveKey() {
    return settings.provider === 'openai' ? settings.openaiKey : settings.claudeKey;
  }

  function updateProviderBadge() {
    const hasKey = !!getActiveKey();
    const models = MODELS[settings.provider] || [];
    const modelName = models.find(m => m.id === settings.model)?.name || settings.model;
    providerBadge.className = 'provider-badge' + (hasKey ? ' ready' : '');
    providerLabel.textContent = hasKey ? `${modelName}` : 'No API key set';
    sendBtn.disabled = !hasKey || isProcessing;
  }

  // ── Markdown renderer ────────────────────────────────────────
  function renderMarkdown(text) {
    if (!text) return '';
    let html = text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${code.trim()}</code></pre>`)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
      .replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')
      .replace(/\n\n/g, '<br><br>')
      .replace(/\n/g, '<br>');
    return html;
  }

  // ── Time formatting ──────────────────────────────────────────
  function formatTime() {
    const now = new Date();
    return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ── Message helpers ──────────────────────────────────────────
  function addMessage(role, content, { animate = true } = {}) {
    welcomeEl.style.display = 'none';
    const time = formatTime();
    const animClass = animate ? '' : ' no-anim';

    if (role === 'user') {
      const wrap = document.createElement('div');
      wrap.className = 'msg-wrap user' + animClass;
      const div = document.createElement('div');
      div.className = 'msg msg-user';
      div.textContent = content;
      wrap.appendChild(div);
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.innerHTML = `<span class="msg-time">${time}</span>`;
      wrap.appendChild(meta);
      messagesEl.appendChild(wrap);
    } else if (role === 'assistant') {
      const wrap = document.createElement('div');
      wrap.className = 'msg-wrap ai' + animClass;
      const div = document.createElement('div');
      div.className = 'msg msg-ai';
      div.innerHTML = renderMarkdown(content);
      wrap.appendChild(div);
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.innerHTML = `
        <span class="msg-time">${time}</span>
        <button class="copy-btn" title="Copy message">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        </button>
      `;
      const copyBtn = meta.querySelector('.copy-btn');
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(content).then(() => {
          copyBtn.classList.add('copied');
          copyBtn.title = 'Copied!';
          setTimeout(() => { copyBtn.classList.remove('copied'); copyBtn.title = 'Copy message'; }, 1500);
        });
      });
      wrap.appendChild(meta);
      messagesEl.appendChild(wrap);

      // Unread badge if panel is closed
      if (!isOpen) {
        unreadDot.classList.add('show');
      }
    } else if (role === 'error') {
      const div = document.createElement('div');
      div.className = 'msg-error' + animClass;
      div.textContent = content;
      messagesEl.appendChild(div);
    } else if (role === 'system') {
      const div = document.createElement('div');
      div.className = 'msg-system' + animClass;
      div.textContent = content;
      messagesEl.appendChild(div);
    }

    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addThinking() {
    // Idempotent — never create more than one thinking indicator
    if (shadow.querySelector('#__thinking')) return;
    welcomeEl.style.display = 'none';
    const div = document.createElement('div');
    div.className = 'thinking';
    div.id = '__thinking';
    div.innerHTML = '<div class="thinking-dots"><span></span><span></span><span></span></div>';
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function removeThinking() {
    // Remove all thinking indicators (guards against any duplicate that slipped through)
    shadow.querySelectorAll('#__thinking').forEach(el => el.remove());
  }

  function addRestoreIndicator() {
    if (shadow.querySelector('#__restore-indicator')) return;
    welcomeEl.style.display = 'none';
    const div = document.createElement('div');
    div.className = 'restore-indicator';
    div.id = '__restore-indicator';
    div.innerHTML = '<div class="ri-spin"></div><span>Resuming after navigation\u2026</span>';
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function removeRestoreIndicator() {
    shadow.querySelectorAll('#__restore-indicator').forEach(el => el.remove());
  }

  function addToolBadge(toolName, status = 'running') {
    const div = document.createElement('div');
    div.className = 'tool-badge';
    div.dataset.tool = toolName;
    if (status === 'running') {
      div.innerHTML = `<div class="spinner"></div> Using <strong>${toolName}</strong>`;
    } else {
      div.innerHTML = `<span class="check">\u2713</span> Used <strong>${toolName}</strong>`;
    }
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function updateToolBadge(toolName, fromCache) {
    const badges = shadow.querySelectorAll('.tool-badge');
    badges.forEach(b => {
      if (b.dataset.tool === toolName && b.querySelector('.spinner')) {
        if (fromCache) {
          b.innerHTML = `<span class="check">⚡</span> Used <strong>${toolName}</strong> (cached)`;
        } else {
          b.innerHTML = `<span class="check">\u2713</span> Used <strong>${toolName}</strong>`;
        }
      }
    });
  }

  // ── Continue button (for tool call limit) ─────────────────────
  function addContinueButton() {
    // Remove any existing continue button
    const existing = shadow.querySelector('.continue-btn');
    if (existing) existing.remove();

    const btn = document.createElement('button');
    btn.className = 'continue-btn';
    btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg> Continue`;
    btn.addEventListener('click', () => {
      btn.remove();
      // Send a "continue" message to resume the conversation
      chatInput.value = 'Continue where you left off.';
      sendMessage();
    });
    messagesEl.appendChild(btn);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ── Send / Stop message ──────────────────────────────────────
  function setProcessingUI(processing) {
    isProcessing = processing;
    if (processing) {
      sendBtn.style.display = 'none';
      stopBtn.style.display = 'flex';
    } else {
      sendBtn.style.display = 'flex';
      stopBtn.style.display = 'none';
      sendBtn.disabled = !getActiveKey() || !chatInput.value.trim();
    }
    saveChat();
  }

  function stopGeneration() {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    ownRequest = false;
    removeThinking();
    addMessage('system', 'Generation stopped');
    setProcessingUI(false);
    chatInput.focus();
  }

  async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text || isProcessing) return;

    // Stop voice if recording
    if (isRecording && recognition) {
      recognition.stop();
    }

    ownRequest = true;
    setProcessingUI(true);
    chatInput.value = '';
    autoResize();
    updateCharCount();

    addMessage('user', text);
    conversationHistory.push({ role: 'user', content: text });
    saveChat();

    addThinking();

    abortController = new AbortController();

    try {
      const response = await new Promise((resolve, reject) => {
        const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (abortController.signal.aborted) { onAbort(); return; }
        
        let abortHandler = null;
        let retries = 0;
        const maxRetries = 5;

        const trySend = () => {
          if (abortController.signal.aborted) { 
            reject(new DOMException('Aborted', 'AbortError')); 
            return; 
          }

          chrome.runtime.sendMessage({
            type: 'chat_send',
            messages: conversationHistory,
            provider: settings.provider,
            model: settings.model,
            requestId: Date.now() + Math.random(),
          }, (resp) => {
            if (!abortController) return;
            
            if (chrome.runtime.lastError) {
              const errMsg = chrome.runtime.lastError.message || '';
              if ((errMsg.includes('Extension context invalidated') || errMsg.includes('Could not establish connection')) && retries < maxRetries) {
                retries++;
                setTimeout(trySend, 800);
                return;
              }
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (resp?.error) {
              reject(new Error(resp.error));
              return;
            }
            resolve(resp);
          });
        };

        abortHandler = () => reject(new DOMException('Aborted', 'AbortError'));
        abortController.signal.addEventListener('abort', abortHandler);
        trySend();
      });

      removeThinking();

      // Reset tool tracking for new message
      toolCount = 0;

      if (response.toolsUsed?.length) {
        for (const tool of response.toolsUsed) {
          addToolBadge(tool.name, 'done');
        }
      }

      addMessage('assistant', response.text);
      conversationHistory.push({ role: 'assistant', content: response.text });
      saveChat();

      // Show Continue button if the AI hit tool call limit
      if (response.canContinue) {
        addContinueButton();
      }

    } catch (err) {
      removeThinking();
      if (err.name === 'AbortError') {
        // Already handled in stopGeneration
      } else {
        addMessage('error', err.message || 'Something went wrong');
      }
    }

    abortController = null;
    ownRequest = false;
    setProcessingUI(false);
    chatInput.focus();
  }

  // ── Listen for background progress messages ──────────────────
  let toolCount = 0;
  let hasThinking = false;
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'chat_tool_start') {
      if (hasThinking) {
        removeThinking();
      }
      addToolBadge(msg.tool, 'running');
      toolCount++;
    }
    if (msg.type === 'chat_tool_done') {
      updateToolBadge(msg.tool, msg.fromCache);
      toolCount--;
      if (toolCount <= 0) {
        toolCount = 0;
      }
    }
  });

  // ── Auto-resize textarea ─────────────────────────────────────
  function autoResize() {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  }

  // ── Character count ──────────────────────────────────────────
  function updateCharCount() {
    const len = chatInput.value.length;
    if (len > 0) {
      charCount.textContent = len > 3000 ? `${len}/4000` : '';
      charCount.classList.toggle('warn', len > 3500);
    } else {
      charCount.textContent = '';
    }
  }

  // ── Scroll-to-bottom visibility ──────────────────────────────
  function checkScrollBottom() {
    const { scrollTop, scrollHeight, clientHeight } = messagesEl;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 80;
    scrollBottomBtn.classList.toggle('show', !isNearBottom && scrollHeight > clientHeight + 100);
  }

  // ── Panel resize ─────────────────────────────────────────────
  let isResizing = false;
  let resizeStartX, resizeStartY, startWidth, startHeight;

  resizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isResizing = true;
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    startWidth = panel.offsetWidth;
    startHeight = panel.offsetHeight;
    document.addEventListener('mousemove', onResize);
    document.addEventListener('mouseup', stopResize);
  });

  function onResize(e) {
    if (!isResizing) return;
    const dx = resizeStartX - e.clientX;
    const dy = resizeStartY - e.clientY;
    const newWidth = Math.max(320, Math.min(700, startWidth + dx));
    const newHeight = Math.max(400, Math.min(800, startHeight + dy));
    panel.style.width = newWidth + 'px';
    panel.style.height = newHeight + 'px';
  }

  function stopResize() {
    isResizing = false;
    document.removeEventListener('mousemove', onResize);
    document.removeEventListener('mouseup', stopResize);
  }

  // ── Event bindings ───────────────────────────────────────────
  bubble.addEventListener('click', () => {
    isOpen = true;
    unreadDot.classList.remove('show');
    bubble.classList.add('hidden');
    panel.classList.add('open');
    chatInput.focus();
    saveChat();
  });

  closeBtn.addEventListener('click', () => {
    isOpen = false;
    panel.classList.remove('open');
    setTimeout(() => bubble.classList.remove('hidden'), 250);
    saveChat();
  });

  settingsBtn.addEventListener('click', () => {
    settingsOpen = !settingsOpen;
    settingsDrawer.classList.toggle('open', settingsOpen);
    settingsBtn.classList.toggle('active', settingsOpen);
    if (settingsOpen) apiKeyInp.value = getActiveKey();
  });

  setupHint.addEventListener('click', () => {
    settingsOpen = true;
    settingsDrawer.classList.add('open');
    settingsBtn.classList.add('active');
  });

  clearBtn.addEventListener('click', () => {
    conversationHistory = [];
    saveChat();
    messagesEl.innerHTML = '';
    messagesEl.appendChild(welcomeEl);
    messagesEl.appendChild(scrollBottomBtn);
    welcomeEl.style.display = '';
  });

  providerSel.addEventListener('change', () => {
    settings.provider = providerSel.value;
    populateModels();
    apiKeyInp.value = getActiveKey();
    apiKeyInp.placeholder = settings.provider === 'openai' ? 'sk-...' : 'sk-ant-api03-...';
  });

  modelSel.addEventListener('change', () => {
    settings.model = modelSel.value;
  });

  saveBtn.addEventListener('click', saveSettings);

  chatInput.addEventListener('input', () => {
    autoResize();
    updateCharCount();
    sendBtn.disabled = !getActiveKey() || !chatInput.value.trim() || isProcessing;
  });

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener('click', sendMessage);
  stopBtn.addEventListener('click', stopGeneration);
  voiceBtn.addEventListener('click', toggleVoice);

  // Suggestion chips
  shadow.querySelectorAll('.suggestion-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const text = chip.dataset.text;
      if (text && getActiveKey()) {
        chatInput.value = text;
        sendMessage();
      } else if (!getActiveKey()) {
        settingsOpen = true;
        settingsDrawer.classList.add('open');
        settingsBtn.classList.add('active');
      }
    });
  });

  // Scroll-to-bottom
  messagesEl.addEventListener('scroll', checkScrollBottom);
  scrollBottomBtn.addEventListener('click', () => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) {
      isOpen = false;
      panel.classList.remove('open');
      setTimeout(() => bubble.classList.remove('hidden'), 250);
      saveChat();
    }
  });

  // ── Keyboard shortcut hint in placeholder ────────────────────
  chatInput.setAttribute('placeholder', 'Ask me anything... (Shift+Enter for new line)');

  // ── Init ─────────────────────────────────────────────────────
  populateModels();
  loadSettings();
  // Get our tab ID first — all storage keys are scoped to this tab ID so
  // different tabs (or accidentally opened new tabs) never share processing state.
  chrome.runtime.sendMessage({ type: 'getMyTabId' }, (resp) => {
    if (!chrome.runtime.lastError && resp?.tabId) {
      myTabId = resp.tabId;
    }
    restoreChat();
  });
})();
