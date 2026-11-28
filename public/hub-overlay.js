// hub-overlay.js — Calm-by-Default AI Studio Hub Drawer + Cloudflare-Proof Live Event Stream
(() => {
  if (window.__AI_STUDIO_HUB_OVERLAY__) return;
  window.__AI_STUDIO_HUB_OVERLAY__ = true;

  // ---------------------------------------------------------------------------
  // 0. Cloudflare-Proof JSON-Polled EventSource for /api/events
  //    Cloudflare Quick Tunnels buffer chunked text/event-stream responses in
  //    128KB blocks and cancel idle HTTP/2 streams on mobile. By routing
  //    /api/events through fast 800ms JSON polling (/api/hub/events-poll),
  //    every runtime, tool, and message frame arrives on mobile in real time!
  // ---------------------------------------------------------------------------
  const origFetch = window.fetch.bind(window);
  const NativeEventSource = window.EventSource;
  const activeEventSources = new Set();
  let lastFetchedBotId = null;
  let onLiveBotEvent = null;

  class HubPolledEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 0; // CONNECTING
      this.onopen = null;
      this.onerror = null;
      this.onmessage = null;
      this._closed = false;
      this._seq = null;
      this._timer = null;
      this._inFlight = false;
      activeEventSources.add(this);
      this._start();
    }

    async _poll() {
      if (this._closed || this._inFlight) return;
      if (document.hidden) return;
      this._inFlight = true;
      try {
        const q = this._seq === null ? '' : `?since=${this._seq}`;
        const res = await origFetch(`/api/hub/events-poll${q}`, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const payload = await res.json();
        if (this._closed) return;

        if (this.readyState === 0) {
          this.readyState = 1; // OPEN
          if (typeof this.onopen === 'function') {
            this.onopen(new Event('open'));
          }
        }

        this._seq = payload.seq;
        const events = payload.events || [];
        if (events.length > 0) {
          let hasBotEv = false;
          for (const ev of events) {
            if (this._closed) return;
            const dStr = String(ev.data || '');
            if (
              dStr.includes('"bot"') ||
              dStr.includes('"runtime"') ||
              dStr.includes('"modelSelection"') ||
              dStr.includes('"message"') ||
              dStr.includes('"activity"') ||
              dStr.includes('"busy"')
            ) {
              hasBotEv = true;
            }
            if (typeof this.onmessage === 'function') {
              this.onmessage({ data: ev.data, lastEventId: ev.id || '' });
            }
          }
          if (hasBotEv && typeof onLiveBotEvent === 'function') {
            onLiveBotEvent(false);
          }
        } else if (typeof this.onmessage === 'function') {
          // Keep OpenMausBot's 40s stale timer alive
          this.onmessage({ data: '{"kind":"ping"}', lastEventId: '' });
        }
      } catch {
        if (!this._closed && typeof this.onerror === 'function') {
          this.onerror(new Event('error'));
        }
      } finally {
        this._inFlight = false;
      }
    }

    _start() {
      setTimeout(() => this._poll(), 5);
      this._timer = setInterval(() => this._poll(), 800);
    }

    close() {
      this._closed = true;
      this.readyState = 2; // CLOSED
      activeEventSources.delete(this);
      if (this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }
    }

    addEventListener() {}
    removeEventListener() {}
  }

  window.EventSource = function(url, opts) {
    if (String(url || '').includes('/api/events')) {
      return new HubPolledEventSource(url);
    }
    return new NativeEventSource(url, opts);
  };
  window.EventSource.CONNECTING = 0;
  window.EventSource.OPEN = 1;
  window.EventSource.CLOSED = 2;

  function nudgeAllEventSources() {
    for (const es of activeEventSources) {
      es._poll();
    }
  }

  let lastBlankPopupBlocked = false;
  const origWindowOpen = window.open.bind(window);

  function showAuthLinkBanner(authUrl) {
    if (!authUrl || !document.body) return;
    let banner = document.getElementById('ash-auth-banner');
    if (banner) banner.remove();
    banner = document.createElement('div');
    banner.id = 'ash-auth-banner';
    banner.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:99999;background:#0f172a;color:#f8fafc;border:1px solid #38bdf8;border-radius:14px;padding:12px 16px;box-shadow:0 12px 32px rgba(0,0,0,0.55);display:flex;align-items:center;gap:10px;max-width:min(92vw,420px);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:13px;';
    banner.innerHTML = `
      <div style="flex:1;min-width:0;">
        <div style="font-weight:700;color:#38bdf8;margin-bottom:2px;">🔗 Browser blocked pop-up</div>
        <div style="font-size:11.5px;color:#cbd5e1;">Tap below to open the sign-in page:</div>
      </div>
      <a href="${String(authUrl).replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer" id="ash-auth-open-link" style="padding:7px 12px;border-radius:8px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:700;text-decoration:none;white-space:nowrap;">Sign In ↗</a>
      <button id="ash-auth-dismiss" style="padding:6px 9px;border-radius:8px;border:1px solid rgba(148,163,184,0.3);background:transparent;color:#94a3b8;cursor:pointer;">✕</button>
    `;
    document.body.appendChild(banner);
    banner.querySelector('#ash-auth-open-link')?.addEventListener('click', () => {
      setTimeout(() => banner.remove(), 400);
    });
    banner.querySelector('#ash-auth-dismiss')?.addEventListener('click', () => banner.remove());
  }

  window.open = function(url, target, features) {
    const win = origWindowOpen(url, target, features);
    const u = String(url || '').trim();
    if (!win) {
      if (!u || u === 'about:blank') {
        lastBlankPopupBlocked = true;
      } else if (/^https?:\/\//i.test(u)) {
        showAuthLinkBanner(u);
      }
    } else {
      lastBlankPopupBlocked = false;
    }
    return win;
  };

  window.fetch = async function(...args) {
    const url = String(args[0] || '');
    const opts = args[1] || {};
    const method = String(opts.method || 'GET').toUpperCase();
    const mBot = url.match(/\/api\/bots\/([0-9a-f-]{8,})\b/i);
    if (mBot) lastFetchedBotId = mBot[1];
    const p = origFetch.apply(this, args);
    if (
      (method === 'POST' && (url.includes('/messages') || url.includes('/tasks') || url.includes('/turns'))) ||
      (method === 'PATCH' && url.includes('/api/bots/'))
    ) {
      p.then(() => {
        nudgeAllEventSources();
        setTimeout(nudgeAllEventSources, 250);
        setTimeout(nudgeAllEventSources, 600);
        if (typeof onLiveBotEvent === 'function') {
          onLiveBotEvent(true);
        }
      }).catch(() => {});
    }
    if (method === 'POST' && (url.includes('/authorize') || url.includes('/auth/start'))) {
      p.then(async (res) => {
        if (!res.ok) return;
        const data = await res.clone().json().catch(() => null);
        const authUrl = data?.url || data?.authorizationUrl || data?.auth?.authorizationUrl;
        if (authUrl && lastBlankPopupBlocked) {
          lastBlankPopupBlocked = false;
          showAuthLinkBanner(authUrl);
        }
      }).catch(() => {});
    }
    return p;
  };

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) nudgeAllEventSources();
  });
  window.addEventListener('focus', () => nudgeAllEventSources());

  function mountHubOverlayDom() {
    if (!document.body) return;

    const style = document.createElement('style');
  style.textContent = `
    #ash-pill {
      position: fixed;
      bottom: 24px;
      left: 20px;
      z-index: 9998;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 6px;
      border-radius: 999px;
      border: 1px solid rgba(148, 163, 184, 0.28);
      background: rgba(17, 24, 39, 0.90);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 12px;
      font-weight: 600;
      cursor: grab;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
      transition: box-shadow 0.15s, background 0.15s;
    }
    .ash-pill-seg {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 9px;
      border-radius: 999px;
      border: none;
      background: transparent;
      color: #f8fafc;
      font: inherit;
      cursor: pointer;
      transition: background 0.15s;
    }
    .ash-pill-seg:hover {
      background: rgba(139, 92, 246, 0.28);
    }
    .ash-pill-seg.allowances {
      background: rgba(99, 102, 241, 0.22);
      color: #c7d2fe;
    }
    .ash-pill-seg.allowances:hover {
      background: rgba(99, 102, 241, 0.42);
      color: #fff;
    }
    .ash-pill-seg.go {
      background: rgba(16, 185, 129, 0.24);
      color: #6ee7b7;
      font-weight: 700;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
    }
    .ash-pill-seg.go:hover {
      background: rgba(16, 185, 129, 0.42);
      color: #ffffff;
    }
    .ash-pill-seg.go.sent {
      background: rgba(16, 185, 129, 0.55);
      color: #ffffff;
    }
    .ash-pill-seg.go.warn {
      background: rgba(245, 158, 11, 0.30);
      color: #fde68a;
    }
    .ash-pill-seg.go:disabled {
      opacity: 0.65;
      cursor: default;
    }
    .ash-pill-seg.next {
      background: rgba(139, 92, 246, 0.24);
      color: #ddd6fe;
      font-weight: 700;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
    }
    .ash-pill-seg.next:hover {
      background: rgba(139, 92, 246, 0.44);
      color: #ffffff;
    }
    .ash-pill-seg.next.sent {
      background: rgba(16, 185, 129, 0.55);
      color: #ffffff;
    }
    .ash-pill-seg.next.warn {
      background: rgba(245, 158, 11, 0.30);
      color: #fde68a;
    }
    .ash-pill-seg.next:disabled {
      opacity: 0.65;
      cursor: default;
    }
    .ash-allow-short {
      display: none;
    }
    .ash-pill-seg.auto {
      background: rgba(100, 116, 139, 0.22);
      color: #cbd5e1;
      font-weight: 700;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
    }
    .ash-pill-seg.auto.on {
      background: rgba(14, 165, 233, 0.26);
      color: #7dd3fc;
    }
    .ash-pill-seg.auto:hover {
      background: rgba(14, 165, 233, 0.38);
      color: #ffffff;
    }
    #ash-auto-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #64748b;
      display: inline-block;
    }
    .ash-pill-seg.auto.on #ash-auto-dot {
      background: #38bdf8;
      box-shadow: 0 0 6px #38bdf8;
    }
    .ash-pill-div {
      width: 1px;
      height: 14px;
      background: rgba(148, 163, 184, 0.25);
    }
    #ash-allow-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #10b981;
      display: inline-block;
    }
    #ash-pill:active {
      cursor: grabbing;
    }
    #ash-pill:hover {
      background: rgba(30, 41, 59, 0.96);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
    }
    #ash-pill-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #f59e0b;
      display: none;
    }
    #ash-backdrop {
      position: fixed;
      inset: 0;
      z-index: 9999;
      background: rgba(2, 6, 23, 0.45);
      backdrop-filter: blur(3px);
      display: none;
      justify-content: flex-end;
    }
    #ash-backdrop.open {
      display: flex;
    }
    #ash-drawer {
      width: min(440px, 100vw);
      height: 100%;
      background: #0f172a;
      color: #f1f5f9;
      border-left: 1px solid rgba(148, 163, 184, 0.18);
      display: flex;
      flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-shadow: -8px 0 32px rgba(0, 0, 0, 0.45);
    }
    .ash-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.14);
    }
    .ash-tabs {
      display: flex;
      gap: 4px;
      padding: 8px 12px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.14);
      background: rgba(15, 23, 42, 0.6);
    }
    .ash-tab {
      flex: 1;
      padding: 6px 8px;
      border-radius: 8px;
      border: none;
      background: transparent;
      color: #94a3b8;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .ash-tab-link {
      flex: 1;
      padding: 6px 8px;
      border-radius: 8px;
      color: #94a3b8;
      font-size: 12px;
      font-weight: 600;
      text-align: center;
      text-decoration: none;
    }
    .ash-tab-link:hover { color: #e2e8f0; }
    .ash-tab.active {
      background: rgba(139, 92, 246, 0.22);
      color: #e2e8f0;
    }
    .ash-body {
      flex: 1;
      overflow-y: auto;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .ash-card {
      background: rgba(30, 41, 59, 0.7);
      border: 1px solid rgba(148, 163, 184, 0.16);
      border-radius: 12px;
      padding: 11px 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .ash-btn {
      padding: 6px 11px;
      border-radius: 8px;
      border: 1px solid rgba(148, 163, 184, 0.24);
      background: rgba(51, 65, 85, 0.7);
      color: #f8fafc;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .ash-btn.primary {
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      border-color: transparent;
    }
    .ash-btn:disabled {
      opacity: 0.55;
      cursor: default;
    }
    .ash-badge {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 10.5px;
      font-weight: 700;
      background: rgba(148, 163, 184, 0.16);
      color: #cbd5e1;
    }
    .ash-bar-bg {
      height: 7px;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.16);
      overflow: hidden;
    }
    .ash-bar-fill {
      height: 100%;
      border-radius: 999px;
      background: #10b981;
      transition: width 0.25s;
    }
    .ash-input {
      width: 100%;
      box-sizing: border-box;
      padding: 8px 11px;
      border-radius: 9px;
      border: 1px solid rgba(148, 163, 184, 0.24);
      background: rgba(15, 23, 42, 0.9);
      color: #f8fafc;
      font-size: 13px;
      outline: none;
    }
    .ash-input:focus {
      border-color: #8b5cf6;
    }
    /* Wide, colorful, scannable AI response layout (desktop + mobile) */
    :root {
      --chat-bubble-max: 54rem !important;
      --chat-bubble-pct: 92% !important;
      --chat-card-pct: 95% !important;
      --chat-prose-max: 56rem !important;
      --chat-column-max: 68rem !important;
    }
    [data-look="message-bot"] [data-look="bot-bubble"],
    [data-look="message-bot"] [data-reply-bubble],
    [data-look="message-bot"] [data-reply-segment],
    [data-look="message-bot"] [data-conversational-reply],
    [data-look="message-bot"] [data-reply-blocks] {
      max-width: min(56rem, 94%) !important;
      box-sizing: border-box !important;
    }
    [data-look="message-bot"] [data-reply-bubble] > div:not([data-reply-table]) {
      max-width: 100% !important;
    }
    :root:not([data-skin="daylight"]) [data-look="bot-bubble"]:not(:has([data-reply-segment], [data-reply-bubble])),
    :root:not([data-skin="daylight"]) [data-reply-bubble],
    :root:not([data-skin="daylight"]) [data-reply-segment] {
      background: linear-gradient(180deg, rgba(30, 41, 59, 0.72), rgba(15, 23, 42, 0.78)) !important;
      border: 1px solid rgba(148, 163, 184, 0.16) !important;
      border-left: 3px solid rgba(99, 102, 241, 0.72) !important;
      border-radius: 14px !important;
      padding: 12px 15px !important;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
    }
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md {
      color: #e2e8f0;
      line-height: 1.64 !important;
    }
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md > .md-heading:first-child,
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md > div.font-semibold:first-child {
      margin-top: 0 !important;
    }
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md .md-heading,
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md h2 {
      color: #a5b4fc !important;
      font-weight: 700 !important;
      border-bottom: 1px solid rgba(165, 180, 252, 0.20);
      padding-bottom: 3px;
      margin-top: 14px !important;
      margin-bottom: 6px !important;
    }
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md .md-heading.text-\[20px\],
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md h1 {
      color: #7dd3fc !important;
      border-bottom-color: rgba(56, 189, 248, 0.28);
      padding-bottom: 4px;
    }
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md > div.font-semibold:not(.md-heading),
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md h3,
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md h4 {
      color: #6ee7b7 !important;
      font-weight: 700 !important;
      font-size: 15.5px;
      margin-top: 12px !important;
      margin-bottom: 4px !important;
    }
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md :is(strong, b) {
      color: #f8fafc !important;
      font-weight: 700 !important;
    }
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md li > strong:first-child,
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md li > p:first-child > strong:first-child {
      color: #bae6fd !important;
    }
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md ul {
      list-style-type: disc !important;
      padding-inline-start: 1.35em !important;
      margin: 8px 0 !important;
    }
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md ol {
      list-style-type: decimal !important;
      padding-inline-start: 1.45em !important;
      margin: 8px 0 !important;
    }
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md ul > li::marker {
      color: #38bdf8;
    }
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md ol > li::marker {
      color: #a78bfa;
      font-weight: 700;
    }
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md li + li {
      margin-top: 6px;
    }
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md :not(pre) > code {
      background: rgba(56, 189, 248, 0.13) !important;
      color: #7dd3fc !important;
      border: 1px solid rgba(56, 189, 248, 0.22);
      border-radius: 6px;
      padding: 1px 5px;
      font-size: 0.87em;
    }
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md pre {
      background: rgba(2, 6, 23, 0.78) !important;
      border: 1px solid rgba(148, 163, 184, 0.22) !important;
      border-radius: 10px !important;
      padding: 10px 12px !important;
      overflow-x: auto;
    }
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md blockquote {
      border-inline-start: 3px solid #8b5cf6 !important;
      background: rgba(139, 92, 246, 0.09);
      border-radius: 0 10px 10px 0;
      padding: 8px 12px !important;
      margin: 10px 0 !important;
      color: #cbd5e1 !important;
    }
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md table {
      width: 100%;
      border-collapse: collapse;
      margin: 10px 0;
      font-size: 13.5px;
    }
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md thead th {
      background: rgba(99, 102, 241, 0.16);
      color: #c7d2fe;
      font-weight: 700;
      border-bottom: 1px solid rgba(129, 140, 248, 0.35);
      padding: 7px 10px;
    }
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md tbody tr:nth-child(even) {
      background: rgba(148, 163, 184, 0.05);
    }
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md tbody td {
      border-bottom: 1px solid rgba(148, 163, 184, 0.14);
      padding: 7px 10px;
    }
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md hr {
      border: none;
      border-top: 1px solid rgba(148, 163, 184, 0.22);
      margin: 12px 0;
    }
    :root:not([data-skin="daylight"]) [data-look="message-bot"] .chat-md a {
      color: #38bdf8 !important;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .glass-scroller-content {
      padding-top: 26px !important;
    }
    @media (max-width: 768px) {
      :root {
        --chat-bubble-max: 100% !important;
        --chat-bubble-pct: 100% !important;
        --chat-card-pct: 100% !important;
        --chat-prose-max: 100% !important;
        --chat-column-max: 100% !important;
      }
      .glass-scroller {
        padding-left: 10px !important;
        padding-right: 10px !important;
      }
      [data-look="message-bot"] > .flex > span.opacity-0,
      [data-look="message-bot"] > .flex > div.opacity-0 {
        display: none !important;
      }
      [data-look="message-bot"] > .flex > [data-look="bot-bubble"] {
        flex: 1 1 100% !important;
        min-width: 0 !important;
      }
      [data-look="message-bot"] [data-look="bot-bubble"],
      [data-look="message-bot"] [data-reply-bubble],
      [data-look="message-bot"] [data-reply-segment],
      [data-look="message-bot"] [data-conversational-reply],
      [data-look="message-bot"] [data-reply-blocks] {
        max-width: 100% !important;
        width: 100% !important;
        min-width: 0 !important;
      }
      [data-look="message-user"] [data-look="user-bubble"] {
        max-width: 88% !important;
      }
    }
    @media (max-width: 768px) {
      .ash-mob-input {
        font-size: 16px !important;
      }
    }
    @keyframes ash-tap-ripple {
      0% { transform: translate(-50%, -50%) scale(0.35); opacity: 0.95; }
      100% { transform: translate(-50%, -50%) scale(1.55); opacity: 0; }
    }
    .ash-mb-btn {
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
      user-select: none;
      -webkit-user-select: none;
    }
    @media (max-width: 520px) {
      #ash-pill {
        gap: 2px;
        padding: 3px 5px;
        font-size: 11px;
      }
      .ash-pill-seg {
        padding: 4px 6px;
        gap: 4px;
      }
      .ash-allow-full {
        display: none;
      }
      .ash-allow-short {
        display: inline;
      }
    }
    @media (max-width: 768px) {
      body:has([data-browser-surface]) #ash-pill,
      body:has([data-browser-surface]) #ash-running-model-note {
        display: none !important;
      }
    }
    #ash-running-model-note {
      position: fixed;
      z-index: 35;
      display: none;
      align-items: center;
      gap: 5px;
      padding: 2px 9px;
      border-radius: 9999px;
      background: rgba(15, 23, 42, 0.84);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid rgba(148, 163, 184, 0.28);
      color: #e2e8f0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 10.5px;
      line-height: 1.3;
      font-weight: 500;
      opacity: 0.9;
      pointer-events: none;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
      transform: translateX(-50%);
      white-space: nowrap;
      max-width: calc(100vw - 24px);
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #ash-running-model-note.running {
      border-color: rgba(56, 189, 248, 0.50);
      background: rgba(15, 23, 42, 0.92);
      opacity: 1;
    }
    #ash-running-model-note .ash-rm-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: none;
      animation: none;
      flex-shrink: 0;
    }
    #ash-running-model-note.running .ash-rm-dot {
      background: #38bdf8;
      box-shadow: 0 0 6px #38bdf8;
      animation: ash-pulse 1.4s ease-in-out infinite;
    }
    @keyframes ash-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.45; transform: scale(0.8); }
    }
    #ash-chief-status {
      width: calc(100% - 28px);
      max-width: 320px;
      margin: 4px auto 0;
      padding: 6px 11px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(148, 163, 184, 0.14);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      cursor: pointer;
      box-sizing: border-box;
      text-align: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      transition: background 0.15s, border-color 0.15s;
    }
    #ash-chief-status:hover {
      background: rgba(255, 255, 255, 0.07);
    }
    #ash-chief-status.working {
      background: rgba(34, 197, 94, 0.09);
      border-color: rgba(34, 197, 94, 0.28);
    }
    #ash-chief-status.waiting {
      background: rgba(245, 158, 11, 0.09);
      border-color: rgba(245, 158, 11, 0.28);
    }
    #ash-chief-status .ash-cs-top {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      max-width: 100%;
      font-size: 11.5px;
      line-height: 1.3;
      font-weight: 600;
      color: #cbd5e1;
    }
    #ash-chief-status.working .ash-cs-top {
      color: #86efac;
    }
    #ash-chief-status.waiting .ash-cs-top {
      color: #fde68a;
    }
    #ash-chief-status .ash-cs-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #64748b;
      flex-shrink: 0;
    }
    #ash-chief-status.working .ash-cs-dot {
      background: #22c55e;
      box-shadow: 0 0 7px rgba(34, 197, 94, 0.8);
      animation: ash-pulse 1.4s ease-in-out infinite;
    }
    #ash-chief-status.waiting .ash-cs-dot {
      background: #f59e0b;
      box-shadow: 0 0 6px rgba(245, 158, 11, 0.7);
    }
    #ash-chief-status.unread .ash-cs-dot {
      background: #38bdf8;
      box-shadow: 0 0 6px rgba(56, 189, 248, 0.75);
    }
    #ash-chief-status .ash-cs-state {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    #ash-chief-status .ash-cs-time {
      color: #94a3b8;
      font-weight: 500;
      font-size: 10.5px;
      flex-shrink: 0;
    }
    #ash-chief-status .ash-cs-preview {
      width: 100%;
      font-size: 11.5px;
      line-height: 1.35;
      color: #94a3b8;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #ash-chief-status .ash-cs-preview.warn {
      color: #fbbf24;
    }
  `;
  document.head.appendChild(style);

  const pill = document.createElement('div');
  pill.id = 'ash-pill';
  pill.title = 'Drag to move · Click Hub, Allowances, Go, Next, or Auto';
  pill.innerHTML = `
    <button type="button" id="ash-btn-hub" class="ash-pill-seg" title="Open AI Studio Hub"><span>⚡ Hub</span><span id="ash-pill-dot"></span></button>
    <span class="ash-pill-div"></span>
    <button type="button" id="ash-btn-allowances" class="ash-pill-seg allowances" title="View Model Allowances & Reset Times Across All Accounts"><span id="ash-allow-dot"></span><span>📊 <span class="ash-allow-full">Allowances</span><span class="ash-allow-short">Quota</span></span></button>
    <span class="ash-pill-div"></span>
    <button type="button" id="ash-btn-go" class="ash-pill-seg go" title="Send &quot;Go&quot; in the current chat"><span>▶ Go</span></button>
    <span class="ash-pill-div"></span>
    <button type="button" id="ash-btn-next" class="ash-pill-seg next" title="Send &quot;So what is the next step?&quot; in the current chat"><span>⏭ Next</span></button>
    <span class="ash-pill-div"></span>
    <button type="button" id="ash-btn-auto" class="ash-pill-seg auto" title="Toggle AI Auto-Routing (Model & Account Optimizer)"><span id="ash-auto-dot"></span><span>🤖 Auto</span></button>
  `;
  document.body.appendChild(pill);

  const backdrop = document.createElement('div');
  backdrop.id = 'ash-backdrop';
  backdrop.innerHTML = `
    <div id="ash-drawer" onclick="event.stopPropagation()">
      <div class="ash-head">
        <div>
          <div style="font-weight:800; font-size:14px;">⚡ AI Studio Hub</div>
          <div style="font-size:11px; color:#94a3b8;">OpenMausBot + Antigravity / Codex Bridge</div>
        </div>
        <div style="display:flex; gap:6px;">
          <button id="ash-refresh-btn" class="ash-btn">↻</button>
          <button id="ash-close-btn" class="ash-btn">✕</button>
        </div>
      </div>
      <div class="ash-tabs">
        <button class="ash-tab active" data-tab="quotas">📊 Allowances</button>
        <button class="ash-tab" data-tab="radar">📡 Radar</button>
        <button class="ash-tab" data-tab="chats">🔍 Chats</button>
        <button class="ash-tab" data-tab="remote">📱 Remote</button>
        <a class="ash-tab-link" href="/dashboard" target="_blank" rel="noopener" title="Phone dashboard: what needs you, every bot, every account">🩺 Dashboard</a>
      </div>
      <div id="ash-body" class="ash-body"></div>
    </div>
  `;
  document.body.appendChild(backdrop);

  let activeTab = 'quotas';
  let hubState = null;
  let searchResults = [];
  let searchQuery = '';
  let pairInfo = null;
  let allowancesRefreshing = false;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function originPill(origin) {
    const o = String(origin || '').toLowerCase();
    if (o === 'antigravity') return '<span class="ash-badge" style="background:rgba(139,92,246,0.22); color:#c4b5fd;">🚀 Antigravity</span>';
    if (o === 'vscode') return '<span class="ash-badge" style="background:rgba(56,189,248,0.22); color:#7dd3fc;">💻 VS Code</span>';
    return '<span class="ash-badge" style="background:rgba(16,185,129,0.22); color:#6ee7b7;">⚡ Codex</span>';
  }

  function switchTab(tabName) {
    activeTab = tabName;
    backdrop.querySelectorAll('.ash-tab').forEach((t) => t.classList.toggle('active', t.getAttribute('data-tab') === tabName));
    renderBody();
  }

  let routerState = null;

  function syncAutoBtn() {
    const autoBtn = document.getElementById('ash-btn-auto');
    if (!autoBtn) return;
    const on = routerState ? !!routerState.enabled : true;
    autoBtn.classList.toggle('on', on);
    autoBtn.title = on ? 'AI Auto-Router: ON (click to pause)' : 'AI Auto-Router: OFF (click to enable)';
  }

  async function loadRouterState() {
    try {
      const r = await fetch('/api/hub/router');
      if (r.ok) {
        routerState = await r.json();
        syncAutoBtn();
        if (backdrop.classList.contains('open') && activeTab === 'quotas') renderBody();
      }
    } catch {}
  }

  async function toggleAutoRouter() {
    const autoBtn = document.getElementById('ash-btn-auto');
    if (autoBtn) autoBtn.disabled = true;
    try {
      const r = await fetch('/api/hub/router/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !(routerState ? routerState.enabled : true) })
      });
      if (r.ok) {
        routerState = await r.json();
        syncAutoBtn();
        if (backdrop.classList.contains('open') && activeTab === 'quotas') renderBody();
      }
    } catch {} finally {
      if (autoBtn) autoBtn.disabled = false;
    }
  }

  async function loadHubState(force = false) {
    try {
      if (force) {
        allowancesRefreshing = true;
        if (backdrop.classList.contains('open') && activeTab === 'quotas') renderBody();
      }
      const res = await fetch('/api/hub/state' + (force ? '?force=1' : ''));
      if (!res.ok) return;
      hubState = await res.json();
      const dot = document.getElementById('ash-pill-dot');
      if (dot) {
        dot.style.display = (hubState?.radar?.stalledTasks?.length || 0) > 0 ? 'inline-block' : 'none';
      }
      const allowDot = document.getElementById('ash-allow-dot');
      if (allowDot) {
        const warns = hubState?.allowances?.routingAdvice?.conserveWarnings || [];
        allowDot.style.background = warns.length > 0 ? '#f59e0b' : '#10b981';
      }
    } catch {} finally {
      allowancesRefreshing = false;
      if (backdrop.classList.contains('open')) renderBody();
    }
  }

  async function continueInOmb(threadId, btn) {
    if (!threadId) return;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Sending...';
    }
    try {
      const res = await fetch('/api/hub/continue-in-omb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId })
      });
      const data = await res.json();
      if (data.ok) {
        if (btn) btn.textContent = '✓ Opened in OpenMausBot!';
        setTimeout(() => {
          backdrop.classList.remove('open');
          window.location.reload();
        }, 700);
      } else if (btn) {
        btn.disabled = false;
        btn.textContent = data.error || 'Error';
      }
    } catch {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Retry';
      }
    }
  }

  function renderBody() {
    const body = document.getElementById('ash-body');
    if (!body) return;
    if (!hubState) {
      body.innerHTML = '<div style="color:#94a3b8; font-size:13px;">Loading AI Studio Hub bridge...</div>';
      return;
    }

    if (activeTab === 'radar') {
      const stalled = hubState.radar?.stalledTasks || [];
      if (stalled.length === 0) {
        body.innerHTML = '<div class="ash-card"><div style="font-size:13px; color:#94a3b8;">✨ No unfinished or stalled tasks detected across Antigravity, Codex, or VS Code.</div></div>';
        return;
      }
      body.innerHTML = stalled.map((item) => `
        <div class="ash-card">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
            <div style="display:flex; gap:6px; align-items:center;">${originPill(item.origin)}<span style="font-size:11px; color:#94a3b8;">${item.hoursIdle}h ago</span></div>
            <span style="font-size:11px; color:#94a3b8;">${esc(item.projectName)}</span>
          </div>
          <div style="font-weight:700; font-size:13px;">${esc(item.title)}</div>
          <div style="font-size:12px; color:#fbbf24;">⚠️ ${esc(item.reason)}</div>
          <div style="display:flex; gap:6px; margin-top:4px;">
            <button class="ash-btn primary" data-continue="${esc(item.id)}">↗ Continue in OpenMausBot</button>
            <button class="ash-btn" data-dismiss="${esc(item.id)}">Dismiss</button>
          </div>
        </div>
      `).join('');

      body.querySelectorAll('[data-continue]').forEach((b) => {
        b.addEventListener('click', () => continueInOmb(b.getAttribute('data-continue'), b));
      });
      body.querySelectorAll('[data-dismiss]').forEach((b) => {
        b.addEventListener('click', async () => {
          const tid = b.getAttribute('data-dismiss');
          await fetch('/api/hub/dismiss-stalled', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threadId: tid })
          });
          await loadHubState(true);
        });
      });
      return;
    }

    if (activeTab === 'chats') {
      const items = searchQuery ? searchResults : (hubState.recentNative || []);
      body.innerHTML = `
        <input id="ash-search-inp" class="ash-input" type="text" placeholder="Search Antigravity, Codex & VS Code chats..." value="${esc(searchQuery)}" />
        <div style="font-size:11.5px; color:#94a3b8;">${searchQuery ? `Matches for "${esc(searchQuery)}"` : 'Recent native conversations across all models:'}</div>
        ${items.length === 0 ? '<div class="ash-card" style="color:#94a3b8; font-size:12.5px;">No matching conversations found.</div>' : items.map((t) => `
          <div class="ash-card">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              ${originPill(t.origin)}
              <span style="font-size:11px; color:#94a3b8;">${esc(t.projectName)}</span>
            </div>
            <div style="font-weight:700; font-size:13px;">${esc(t.title)}</div>
            ${t.snippet ? `<div style="font-size:11.5px; color:#cbd5e1;">${esc(t.snippet)}</div>` : ''}
            <button class="ash-btn primary" style="align-self:flex-start;" data-continue="${esc(t.id)}">↗ Continue in OpenMausBot</button>
          </div>
        `).join('')}
      `;
      const inp = document.getElementById('ash-search-inp');
      let timer = null;
      inp?.addEventListener('input', (e) => {
        searchQuery = e.target.value;
        clearTimeout(timer);
        timer = setTimeout(async () => {
          if (!searchQuery.trim()) {
            searchResults = [];
            renderBody();
            return;
          }
          const r = await fetch('/api/hub/search?q=' + encodeURIComponent(searchQuery));
          const d = await r.json();
          searchResults = d.matches || [];
          renderBody();
          const inp2 = document.getElementById('ash-search-inp');
          if (inp2) { inp2.focus(); inp2.setSelectionRange(searchQuery.length, searchQuery.length); }
        }, 220);
      });
      body.querySelectorAll('[data-continue]').forEach((b) => {
        b.addEventListener('click', () => continueInOmb(b.getAttribute('data-continue'), b));
      });
      return;
    }

    if (activeTab === 'quotas') {
      const al = hubState.allowances;
      const barColor = (pct) => pct <= 15 ? '#ef4444' : pct <= 35 ? '#f59e0b' : '#10b981';
      const statusBadge = (acct, idx) => {
        if (idx === 0 && acct.statusTag !== 'conserve' && acct.statusTag !== 'critical') {
          return '<span class="ash-badge" style="background:rgba(16,185,129,0.22); color:#6ee7b7;">★ Best Right Now</span>';
        }
        if (acct.statusTag === 'use-soon') return '<span class="ash-badge" style="background:rgba(56,189,248,0.22); color:#7dd3fc;">⏳ Use Before Reset</span>';
        if (acct.statusTag === 'conserve') return '<span class="ash-badge" style="background:rgba(245,158,11,0.22); color:#fcd34d;">⚠️ Low Weekly — Conserve</span>';
        if (acct.statusTag === 'critical') return '<span class="ash-badge" style="background:rgba(239,68,68,0.22); color:#fca5a5;">🔴 Nearly Exhausted</span>';
        return '<span class="ash-badge" style="background:rgba(16,185,129,0.16); color:#6ee7b7;">✓ Plenty Left</span>';
      };

      const renderWindowRow = (label, win) => {
        if (!win || typeof win.remainingPercent !== 'number') return '';
        const pct = Math.max(0, Math.min(100, Math.round(win.remainingPercent)));
        const resetTxt = win.resetsInHuman
          ? `resets in ${win.resetsInHuman}${win.resetsAtEastern ? ` (${win.resetsAtEastern})` : ''}`
          : (pct >= 99.5 ? 'full / ready' : '');
        return `
          <div style="margin-top:5px;">
            <div style="font-size:11.5px; display:flex; justify-content:space-between; align-items:baseline; gap:6px;">
              <span style="color:#e2e8f0; font-weight:600;">${esc(label)}</span>
              <span style="color:#cbd5e1; font-weight:700;">${pct}% left</span>
            </div>
            <div class="ash-bar-bg" style="margin-top:3px;"><div class="ash-bar-fill" style="width:${pct}%; background:${barColor(pct)};"></div></div>
            ${resetTxt ? `<div style="font-size:10.5px; color:#94a3b8; margin-top:2px;">↻ ${esc(resetTxt)}</div>` : ''}
          </div>
        `;
      };

      if (al && Array.isArray(al.accounts) && al.accounts.length > 0) {
        const adv = al.routingAdvice || {};
        const updatedLabel = al.fetchedAt ? new Date(al.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';

        body.innerHTML = `
          <div class="ash-card" style="border-color:rgba(139,92,246,0.35); background:rgba(76,29,149,0.18);">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
              <div style="font-size:12px; font-weight:800; color:#c4b5fd;">🧠 Smart Account Routing</div>
              <button id="ash-allow-refresh" class="ash-btn" style="padding:3px 9px; font-size:11px;" ${allowancesRefreshing ? 'disabled' : ''}>${allowancesRefreshing ? 'Refreshing...' : '↻ Live Refresh'}</button>
            </div>
            <div style="font-size:12px; color:#e2e8f0; line-height:1.45;">${esc(adv.summary || 'All accounts loaded.')}</div>
            ${updatedLabel ? `<div style="font-size:10.5px; color:#94a3b8;">Updated ${esc(updatedLabel)} · Shared with khadang & all bots via MCP</div>` : ''}
          </div>

          ${al.accounts.map((acct, idx) => `
            <div class="ash-card">
              <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:6px; flex-wrap:wrap;">
                <div>
                  <div style="font-weight:800; font-size:13px; color:#f8fafc;">
                    ${acct.driver === 'codex' ? '🟢' : '🌌'} ${esc(acct.displayName)}
                    ${acct.plan ? `<span class="ash-badge" style="margin-left:4px;">${esc(acct.plan)}</span>` : ''}
                  </div>
                  ${acct.email ? `<div style="font-size:11px; color:#94a3b8; margin-top:1px;">${esc(acct.email)}</div>` : ''}
                </div>
                ${statusBadge(acct, idx)}
              </div>

              ${acct.assignedBots?.length ? `
                <div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:2px;">
                  ${acct.assignedBots.map((b) => `<span class="ash-badge" style="font-size:10px; background:rgba(51,65,85,0.8); color:#cbd5e1;">🤖 ${esc(b.name)}</span>`).join('')}
                </div>
              ` : '<div style="font-size:10.5px; color:#64748b;">No bots assigned yet — ready to use!</div>'}

              <div style="margin-top:4px;">
                ${acct.driver === 'antigravity' && acct.geminiSharedModels?.length ? `
                  <div style="font-size:10.5px; color:#a5b4fc; margin-bottom:2px;">
                    <b>Gemini Pool:</b> ${esc(acct.geminiSharedModels.join(' · '))}
                  </div>
                ` : ''}
                ${renderWindowRow(acct.driver === 'codex' ? '5-Hour Window' : 'Gemini · 5-Hour', acct.fiveHour)}
                ${renderWindowRow(acct.driver === 'codex' ? '7-Day Weekly' : 'Gemini · Weekly', acct.weekly)}
              </div>

              ${acct.models?.length ? `
                <div style="margin-top:6px; padding-top:6px; border-top:1px solid rgba(148,163,184,0.14);">
                  <div style="font-size:10.5px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:2px;">Separate Model Pools</div>
                  ${acct.models.map((m) => `
                    ${m.modelsIncluded?.length ? `<div style="font-size:10px; color:#94a3b8; margin-top:4px;">Includes: ${esc(m.modelsIncluded.join(' · '))}</div>` : ''}
                    ${(m.windows || []).map((w) => renderWindowRow(`${m.name} (${w.label})`, w)).join('')}
                  `).join('')}
                </div>
              ` : ''}
            </div>
          `).join('')}

          ${al.disconnected?.length ? `
            <div class="ash-card" style="opacity:0.72;">
              <div style="font-size:11.5px; font-weight:700; color:#94a3b8;">🔒 Not Signed In (${al.disconnected.length})</div>
              ${al.disconnected.map((d) => `<div style="font-size:11px; color:#94a3b8;">• <b>${esc(d.displayName)}</b> — ${esc(d.error || 'Sign in via Hub Settings → Engines')}</div>`).join('')}
            </div>
          ` : ''}
        `;

        if (routerState) {
          const rRoutes = (routerState.recentRoutes || []).slice(0, 5);
          body.innerHTML += `
            <div class="ash-card">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <div style="font-weight:700; font-size:12.5px;">🤖 AI Auto-Router</div>
                <span class="ash-badge" style="color:${routerState.enabled ? '#7dd3fc' : '#94a3b8'};">${routerState.enabled ? 'ON' : 'OFF'}</span>
              </div>
              ${rRoutes.length ? rRoutes.map((rt) => `
                <div style="font-size:11px; color:#cbd5e1; display:flex; justify-content:space-between; gap:6px; border-top:1px solid rgba(148,163,184,0.12); padding-top:4px;">
                  <span><b>${esc(rt.botName)}</b> → ${esc(rt.account)} / ${esc(rt.modelLabel || rt.model)}</span>
                  <span style="color:#94a3b8; white-space:nowrap;">${esc(rt.tier)}</span>
                </div>
                <div style="font-size:10.5px; color:#94a3b8; margin-top:-3px;">${esc(rt.reason)} (${esc(rt.judge)})</div>
              `).join('') : '<div style="font-size:11px; color:#94a3b8;">No routed prompts yet. Send a message with Auto ON to see decisions here.</div>'}
            </div>
          `;
        }
        document.getElementById('ash-allow-refresh')?.addEventListener('click', () => loadHubState(true));
        return;
      }

      // Fallback if /api/hub/allowances hasn't returned yet
      const ap = hubState.autoPilot || {};
      const agyPools = ap.agy?.pools || [];
      const cx5 = ap.codex?.fiveHourWindow?.remainingPct ?? 100;
      const cx7 = ap.codex?.weeklyWindow?.remainingPct ?? 100;
      body.innerHTML = `
        <div class="ash-card">
          <div style="font-size:12px; font-weight:700; color:#c4b5fd;">⚡ Auto-Pilot Recommendation: ${esc((ap.recommendedEngine || 'codex').toUpperCase())}</div>
          <div style="font-size:12px; color:#cbd5e1;">${esc(ap.reason || '')}</div>
        </div>
        <div class="ash-card">
          <div style="font-weight:700; font-size:13px;">🟢 OpenAI Codex Quota</div>
          <div style="font-size:12px; display:flex; justify-content:space-between;"><span>5-Hour Window</span><span>${cx5}% left</span></div>
          <div class="ash-bar-bg"><div class="ash-bar-fill" style="width:${cx5}%; background:${barColor(cx5)};"></div></div>
          <div style="font-size:12px; display:flex; justify-content:space-between; margin-top:4px;"><span>7-Day Weekly</span><span>${cx7}% left</span></div>
          <div class="ash-bar-bg"><div class="ash-bar-fill" style="width:${cx7}%; background:${barColor(cx7)};"></div></div>
        </div>
        <div class="ash-card">
          <div style="font-weight:700; font-size:13px;">🌌 Antigravity Pools ${ap.agy?.connected ? '' : '<span class="ash-badge">Cached</span>'}</div>
          ${agyPools.length === 0 ? '<div style="font-size:12px; color:#94a3b8;">Loading multi-account allowances...</div>' : agyPools.map((p) => `
            <div style="font-size:12px; display:flex; justify-content:space-between;"><span>${esc(p.family)}</span><span>${p.remainingPct}%</span></div>
            <div class="ash-bar-bg"><div class="ash-bar-fill" style="width:${p.remainingPct}%; background:${barColor(p.remainingPct)};"></div></div>
          `).join('')}
        </div>
      `;
      return;
    }

    if (activeTab === 'remote') {
      const tun = hubState.tunnel || {};
      body.innerHTML = `
        <div class="ash-card">
          <div style="font-weight:700; font-size:13px;">🌟 Permanent Gateway</div>
          <div style="font-size:12px; color:#38bdf8; word-break:break-all;">${esc(tun.gatewayUrl || 'https://ai-studio-hub.mojtaba-safdari-mm.workers.dev')}</div>
          <div style="font-size:11.5px; color:#94a3b8;">Tunnel status: <b>${esc(tun.status || 'starting')}</b> ${tun.url ? `(${esc(tun.url)})` : ''}</div>
        </div>
        <div class="ash-card">
          <div style="font-weight:700; font-size:13px;">📱 Pair Phone or Browser</div>
          <div style="font-size:12px; color:#cbd5e1;">Generate a single-use pairing link to sign in to OpenMausBot from your phone via the Permanent Gateway:</div>
          <button id="ash-pair-btn" class="ash-btn primary">Generate 1-Tap Pairing Link</button>
          ${pairInfo ? `<div style="margin-top:8px; padding:10px; border-radius:8px; background:rgba(15,23,42,0.85); font-size:12px; border:1px solid rgba(56,189,248,0.3);">
            ${pairInfo.code ? `<div style="margin-bottom:6px;"><span style="color:#94a3b8; font-size:11px; text-transform:uppercase; letter-spacing:0.05em;">Pairing Code (24h):</span> <code style="font-size:16px; font-weight:800; color:#38bdf8; background:rgba(56,189,248,0.15); padding:2px 8px; border-radius:4px; letter-spacing:0.1em;">${esc(pairInfo.code)}</code></div>` : ''}
            ${pairInfo.link ? `<div style="word-break:break-all;"><span style="color:#94a3b8; font-size:11px;">1-Tap Link:</span> <a href="${esc(pairInfo.link)}" target="_blank" style="color:#38bdf8; text-decoration:underline;">${esc(pairInfo.link)}</a></div>` : esc(pairInfo.raw || pairInfo.error)}
          </div>` : ''}
        </div>
      `;
      document.getElementById('ash-pair-btn')?.addEventListener('click', async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        b.textContent = 'Generating...';
        try {
          const r = await fetch('/api/hub/pair-link', { method: 'POST' });
          pairInfo = await r.json();
        } catch (err) {
          pairInfo = { error: err.message };
        }
        renderBody();
      });
    }
  }

  // Restore saved position
  try {
    const savedPos = localStorage.getItem('ash_pill_pos');
    if (savedPos) {
      const { x, y } = JSON.parse(savedPos);
      if (typeof x === 'number' && typeof y === 'number') {
        const pillW = pill.offsetWidth || 320;
        const pillH = pill.offsetHeight || 38;
        const maxW = Math.max(8, window.innerWidth - pillW - 8);
        const maxH = Math.max(8, window.innerHeight - pillH - 8);
        const safeX = Math.max(8, Math.min(x, maxW));
        const safeY = Math.max(8, Math.min(y, maxH));
        pill.style.left = safeX + 'px';
        pill.style.top = safeY + 'px';
        pill.style.bottom = 'auto';
        pill.style.right = 'auto';
      }
    }
  } catch {}

  let isDragging = false;
  let startX = 0, startY = 0;
  let pillStartX = 0, pillStartY = 0;
  let hasMoved = false;

  function onDragStart(clientX, clientY) {
    isDragging = true;
    hasMoved = false;
    startX = clientX;
    startY = clientY;
    const rect = pill.getBoundingClientRect();
    pillStartX = rect.left;
    pillStartY = rect.top;
  }

  function onDragMove(clientX, clientY) {
    if (!isDragging) return;
    const dx = clientX - startX;
    const dy = clientY - startY;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
      hasMoved = true;
    }
    if (!hasMoved) return;
    const maxW = window.innerWidth - pill.offsetWidth - 8;
    const maxH = window.innerHeight - pill.offsetHeight - 8;
    const newX = Math.max(8, Math.min(pillStartX + dx, maxW));
    const newY = Math.max(8, Math.min(pillStartY + dy, maxH));
    pill.style.left = newX + 'px';
    pill.style.top = newY + 'px';
    pill.style.bottom = 'auto';
    pill.style.right = 'auto';
  }

  function onDragEnd() {
    if (!isDragging) return;
    isDragging = false;
    if (hasMoved) {
      const rect = pill.getBoundingClientRect();
      try {
        localStorage.setItem('ash_pill_pos', JSON.stringify({ x: rect.left, y: rect.top }));
      } catch {}
    }
  }

  pill.addEventListener('mousedown', (e) => {
    onDragStart(e.clientX, e.clientY);
    const moveHandler = (ev) => onDragMove(ev.clientX, ev.clientY);
    const upHandler = () => {
      onDragEnd();
      window.removeEventListener('mousemove', moveHandler);
      window.removeEventListener('mouseup', upHandler);
    };
    window.addEventListener('mousemove', moveHandler);
    window.addEventListener('mouseup', upHandler);
  });

  pill.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      onDragStart(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: true });

  pill.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && isDragging) {
      onDragMove(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: true });

  pill.addEventListener('touchend', () => {
    onDragEnd();
  });

  let promptSending = false;
  const promptFlashTimers = new Map();

  function flashPromptBtn(btn, label, cls, ms = 1100, defaultHtml = '<span>▶ Go</span>') {
    if (!btn) return;
    const prev = promptFlashTimers.get(btn);
    if (prev) {
      clearTimeout(prev);
      promptFlashTimers.delete(btn);
    }
    btn.classList.remove('sent', 'warn');
    if (cls) btn.classList.add(cls);
    btn.textContent = label;
    btn.disabled = true;
    const tid = setTimeout(() => {
      promptFlashTimers.delete(btn);
      btn.classList.remove('sent', 'warn');
      btn.innerHTML = defaultHtml;
      btn.disabled = false;
    }, ms);
    promptFlashTimers.set(btn, tid);
  }

  function findVisibleComposer() {
    const visibleActions = Array.from(document.querySelectorAll('[data-composer-actions]'))
      .filter((el) => el.offsetParent !== null && el.getBoundingClientRect().width > 0);
    visibleActions.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    for (const actionsEl of visibleActions) {
      let root = actionsEl.parentElement;
      for (let i = 0; i < 4 && root; i++) {
        const ta = Array.from(root.querySelectorAll('textarea')).find(
          (el) => el.offsetParent !== null && el.getBoundingClientRect().width > 0
        );
        if (ta) return { actionsEl, ta };
        root = root.parentElement;
      }
    }
    return null;
  }

  function findComposerSendButton(actionsEl) {
    if (!actionsEl) return null;
    const followUp = actionsEl.querySelector('[data-composer-follow-up]');
    if (followUp) {
      const followBtns = Array.from(followUp.querySelectorAll('button'));
      const sendBtn = followBtns[followBtns.length - 1] || null;
      if (sendBtn && !sendBtn.disabled) return sendBtn;
    }
    const candidates = Array.from(actionsEl.querySelectorAll('button')).filter((b) => {
      if (b.disabled) return false;
      if (b.hasAttribute('data-composer-stop') || b.hasAttribute('aria-haspopup')) return false;
      const aria = String(b.getAttribute('aria-label') || '');
      const title = String(b.getAttribute('title') || '');
      if (/stop|dictat|voice|record|mic/i.test(aria) || /^stop\b|interrupt/i.test(title)) return false;
      return true;
    });
    return candidates[candidates.length - 1] || null;
  }

  function triggerQuickPrompt(btn, promptText, defaultHtml) {
    if (promptSending) return;
    const found = findVisibleComposer();
    if (!found || !found.ta) {
      flashPromptBtn(btn, 'No chat', 'warn', 1100, defaultHtml);
      return;
    }
    const { actionsEl, ta } = found;
    if (ta.disabled) {
      flashPromptBtn(btn, 'Busy', 'warn', 1100, defaultHtml);
      return;
    }
    const current = String(ta.value || '').trim();
    if (current.length > 0 && current.toLowerCase() !== promptText.toLowerCase()) {
      flashPromptBtn(btn, 'Clear box', 'warn', 1300, defaultHtml);
      return;
    }

    promptSending = true;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(ta, promptText);
    else ta.value = promptText;
    ta.dispatchEvent(new Event('input', { bubbles: true }));

    let frames = 0;
    const maxFrames = 12;
    const trySend = () => {
      const sendBtn = findComposerSendButton(actionsEl);
      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
        promptSending = false;
        flashPromptBtn(btn, '✓ Sent', 'sent', 950, defaultHtml);
        nudgeAllEventSources();
        return;
      }
      frames++;
      if (frames < maxFrames) {
        requestAnimationFrame(trySend);
        return;
      }
      ta.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      }));
      setTimeout(() => {
        promptSending = false;
        if (String(ta.value || '').trim() === '') {
          flashPromptBtn(btn, '✓ Sent', 'sent', 950, defaultHtml);
          nudgeAllEventSources();
        } else {
          flashPromptBtn(btn, 'Retry', 'warn', 1200, defaultHtml);
        }
      }, 100);
    };
    requestAnimationFrame(trySend);
  }

  function triggerQuickGo(btn) {
    return triggerQuickPrompt(btn, 'Go', '<span>▶ Go</span>');
  }

  pill.addEventListener('click', (e) => {
    if (hasMoved) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const autoBtn = e.target?.closest?.('#ash-btn-auto');
    if (autoBtn) {
      e.preventDefault();
      e.stopPropagation();
      toggleAutoRouter();
      return;
    }
    const nextBtn = e.target?.closest?.('#ash-btn-next');
    if (nextBtn) {
      e.preventDefault();
      e.stopPropagation();
      triggerQuickPrompt(nextBtn, 'So what is the next step?', '<span>⏭ Next</span>');
      return;
    }
    const goBtn = e.target?.closest?.('#ash-btn-go');
    if (goBtn) {
      e.preventDefault();
      e.stopPropagation();
      triggerQuickGo(goBtn);
      return;
    }
    const clickedAllowances = !!e.target?.closest?.('#ash-btn-allowances');
    if (clickedAllowances) {
      switchTab('quotas');
    } else if (e.target?.closest?.('#ash-btn-hub')) {
      switchTab(activeTab || 'quotas');
    }
    backdrop.classList.add('open');
    loadHubState(true);
  });
  backdrop.addEventListener('click', () => backdrop.classList.remove('open'));
  document.getElementById('ash-close-btn')?.addEventListener('click', () => backdrop.classList.remove('open'));
  document.getElementById('ash-refresh-btn')?.addEventListener('click', () => loadHubState(true));
  backdrop.querySelectorAll('.ash-tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      switchTab(tabBtn.getAttribute('data-tab'));
    });
  });

  setTimeout(() => { loadHubState(false); loadRouterState(); }, 1500);
  setInterval(() => { loadHubState(false); loadRouterState(); }, 60000);
  // Live model badge (idle & running) right below the chat header
  const runNote = document.createElement('div');
  runNote.id = 'ash-running-model-note';
  document.body.appendChild(runNote);

  let botsCache = [];
  let lastBotsFetchAt = 0;
  let botsFetchInFlight = null;
  let wasRunning = false;
  let lastRunNoteHtml = '';
  let liveBotTimer = null;

  async function refreshBotsCache(force = false, maxAgeMs = 8000) {
    if (!force && botsCache.length > 0 && Date.now() - lastBotsFetchAt < maxAgeMs) return botsCache;
    if (botsFetchInFlight) return botsFetchInFlight;
    lastBotsFetchAt = Date.now();
    botsFetchInFlight = (async () => {
      try {
        const r = await fetch('/api/bots');
        if (r.ok) {
          const d = await r.json();
          const list = Array.isArray(d) ? d : (Array.isArray(d?.bots) ? d.bots : null);
          if (list) botsCache = list;
        }
      } catch {}
      return botsCache;
    })();
    try {
      return await botsFetchInFlight;
    } finally {
      botsFetchInFlight = null;
    }
  }

  function findBotByNameInText(text) {
    const raw = String(text || '').trim();
    if (!raw || !botsCache.length) return null;
    const sorted = [...botsCache].filter((b) => b && b.name).sort((a, b) => b.name.length - a.name.length);
    const patterns = [
      /^Message\s+(.+)$/i,
      /^Ask\s+(.+?)(?:\.\.\.|…)?$/i,
      /^(.+?)\s+is working\b/i,
      /^Open\s+(.+?)(?:'s|’s)\s+profile$/i,
      /\b(?:queue|steer)\s+(?:for\s+)?(.+?)(?:\s*[.(—-]|$)/i
    ];
    for (const re of patterns) {
      const m = raw.match(re);
      if (m) {
        const candidate = m[1].trim().toLowerCase();
        const exact = sorted.find((b) => String(b.name || '').trim().toLowerCase() === candidate);
        if (exact) return exact;
      }
    }
    const lower = raw.toLowerCase();
    for (const b of sorted) {
      const nm = String(b.name || '').trim().toLowerCase();
      if (!nm) continue;
      const escaped = nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'i').test(lower)) {
        return b;
      }
    }
    return null;
  }

  function detectActiveBot(foundComposer) {
    if (!botsCache.length) return null;
    const qBot = new URLSearchParams(window.location.search).get('bot');
    if (qBot) {
      const hit = botsCache.find((b) => b.id === qBot);
      if (hit) return hit;
    }
    const loc = `${window.location.pathname || ''} ${window.location.hash || ''}`;
    for (const b of botsCache) {
      if (b.id && loc.includes(b.id)) return b;
    }
    const ariaBot = findBotByNameInText(foundComposer?.ta?.getAttribute('aria-label'));
    if (ariaBot) return ariaBot;

    const phBot = findBotByNameInText(foundComposer?.ta?.getAttribute('placeholder'));
    if (phBot) return phBot;

    const sorted = [...botsCache].filter((b) => b && b.name).sort((a, b) => b.name.length - a.name.length);
    const topEls = Array.from(document.querySelectorAll('button, h1, h2, [role="heading"]')).filter((el) => {
      if (el.offsetParent === null) return false;
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.top < 100 && r.width > 0 && r.height > 0;
    });
    for (const el of topEls) {
      const txt = String(el.textContent || '').trim().toLowerCase();
      if (!txt) continue;
      const exact = sorted.find((b) => String(b.name || '').trim().toLowerCase() === txt);
      if (exact) return exact;
    }

    const profileBtn = Array.from(document.querySelectorAll('button[aria-label^="Open "]')).find((b) =>
      /(?:'s|’s)\s+profile$/i.test(b.getAttribute('aria-label') || '')
    );
    if (profileBtn) {
      const pBot = findBotByNameInText(profileBtn.getAttribute('aria-label'));
      if (pBot) return pBot;
    }

    if (lastFetchedBotId) {
      const hit = botsCache.find((b) => b.id === lastFetchedBotId);
      if (hit) return hit;
    }
    return null;
  }

  function isComposerRunning(foundComposer) {
    const visibleStopAttr = Array.from(document.querySelectorAll('[data-composer-stop]')).find(
      (el) => el.offsetParent !== null && el.getBoundingClientRect().width > 0
    );
    if (visibleStopAttr) return true;

    const stopRe = /^stop\b|stop\s+(?:this\s+)?turn|interrupt/i;
    if (foundComposer?.actionsEl) {
      const actButtons = Array.from(foundComposer.actionsEl.querySelectorAll('button')).filter(
        (b) => b.offsetParent !== null && b.getBoundingClientRect().width > 0
      );
      for (const b of actButtons) {
        const aria = String(b.getAttribute('aria-label') || '');
        const title = String(b.getAttribute('title') || '');
        if (stopRe.test(aria) || stopRe.test(title)) return true;
      }
    }

    const headerButtons = Array.from(document.querySelectorAll('button')).filter((b) => {
      if (b.offsetParent === null) return false;
      const r = b.getBoundingClientRect();
      return r.top >= 0 && r.top < 110 && r.width > 0 && r.height > 0;
    });
    for (const b of headerButtons) {
      const aria = String(b.getAttribute('aria-label') || '');
      const title = String(b.getAttribute('title') || '');
      if (stopRe.test(aria) || stopRe.test(title)) return true;
    }

    const ph = String(foundComposer?.ta?.getAttribute('placeholder') || '');
    if (/\bis working\b/i.test(ph)) return true;

    return false;
  }

  function formatAccountLabel(instanceId) {
    if (!instanceId) return '';
    const accts = hubState?.allowances?.accounts || [];
    const hit = accts.find((a) => a.instanceId === instanceId);
    if (hit?.displayName) {
      if (hit.displayName === 'Google Gemini (Antigravity)') return 'Mina';
      return hit.displayName;
    }
    if (instanceId === 'codex') return 'Codex';
    if (instanceId === 'antigravity') return 'Mina';
    if (instanceId === 'antigravity-803cef99-77bf-4686-b428-149233bd1050') return 'Mojtaba.mm';
    if (instanceId === 'antigravity-78fdf303-92f9-41a2-bc00-5fc57f32c39c') return 'mojtaba';
    if (instanceId.startsWith('claude-')) return 'Claude';
    return instanceId;
  }

  function formatModelLabel(modelId) {
    const id = String(modelId || '').trim();
    if (!id) return '';
    const map = {
      'claude-opus-5-5': 'Claude Opus 5.5',
      'claude-sonnet-5-5': 'Claude Sonnet 5.5',
      'claude-haiku-5-5': 'Claude Haiku 5.5',
      'gemini-pro-orchestrator-neon': 'Orchestrator Neon',
      'gemini-pro-orchestrator-argon': 'Orchestrator Argon',
      'gemini-3.8-flash': 'Gemini 3.8 Flash',
      'gemini-4-neon': 'Gemini 4 Neon',
      'gpt-6.2-sol': 'GPT-6.2 Sol',
      'gpt-6-luna': 'GPT-6 Luna',
      'gpt-oss-120b-medium': 'GPT-OSS 120B'
    };
    if (map[id]) return map[id];
    let pretty = id
      .replace(/^claude-([a-z]+)-(\d+)-(\d+)$/i, (_, f, a, b) => `Claude ${f[0].toUpperCase()}${f.slice(1)} ${a}.${b}`)
      .replace(/^gpt-oss-(\d+[a-z]*)(?:-.+)?$/i, (_, sz) => `GPT-OSS ${sz.toUpperCase()}`)
      .replace(/^gpt-([0-9.]+)-([a-z]+)$/i, (_, ver, tag) => `GPT-${ver} ${tag[0].toUpperCase()}${tag.slice(1)}`)
      .replace(/^gemini-([0-9.]+)-([a-z]+)$/i, (_, ver, tag) => `Gemini ${ver} ${tag[0].toUpperCase()}${tag.slice(1)}`);
    if (pretty === id) {
      pretty = id.split('-').map((p) => (/^[0-9.]+$/.test(p) ? p : (p[0] ? p[0].toUpperCase() + p.slice(1) : p))).join(' ');
    }
    return pretty;
  }

  function resolveBotModel(bot) {
    if (!bot) return null;
    const tasks = Array.isArray(bot.tasks) ? bot.tasks : [];
    const qThread = new URLSearchParams(window.location.search).get('thread');
    const activeTask =
      (qThread && tasks.find((t) => t.threadId === qThread)) ||
      tasks.find((t) => t.threadId === bot.threadId) ||
      null;
    // What is actually answering: the running model while a turn is live, then the model that answered the last turn.
    if (activeTask?.runningModel?.model) return activeTask.runningModel;
    const ctx = String(activeTask?.lastContextModel || '');
    if (ctx.includes(':')) {
      const idx = ctx.indexOf(':');
      return { instanceId: ctx.slice(0, idx), model: ctx.slice(idx + 1) };
    }
    if (activeTask?.modelSelection?.model) return activeTask.modelSelection;
    if (bot.modelSelection?.model) return bot.modelSelection;
    return null;
  }

  async function updateRunningModelNote(forceRefresh = false) {
    const found = findVisibleComposer();
    if (!found || !found.ta) {
      wasRunning = false;
      lastRunNoteHtml = '';
      runNote.style.display = 'none';
      return;
    }
    const running = isComposerRunning(found);
    const justStarted = running && !wasRunning;
    wasRunning = running;
    const maxAgeMs = running ? 5000 : 15000;
    await refreshBotsCache(forceRefresh || justStarted || botsCache.length === 0, maxAgeMs);

    // Always show the model: beside the "Running for" status while generating, otherwise just above the composer.
    const anchor = running ? findRunningStatusAnchor() : null;

    const bot = detectActiveBot(found);
    const sel = resolveBotModel(bot);
    if (!sel || !sel.model) {
      lastRunNoteHtml = '';
      runNote.style.display = 'none';
      return;
    }

    const acct = formatAccountLabel(sel.instanceId);
    let modelLabel = formatModelLabel(sel.model);
    if (acct && modelLabel.toLowerCase().startsWith(acct.toLowerCase() + ' ')) {
      modelLabel = modelLabel.slice(acct.length + 1);
    }
    const label = acct ? `${acct} · ${modelLabel}` : modelLabel;
    const nextHtml = `<span class="ash-rm-dot"></span><span>${esc(label)}</span>`;

    runNote.classList.toggle('running', running);
    if (nextHtml !== lastRunNoteHtml) {
      lastRunNoteHtml = nextHtml;
      runNote.innerHTML = nextHtml;
    }

    const noteH = runNote.offsetHeight || 20;
    if (anchor) {
      // Just to the right of the "Running for …" status text.
      const ar = anchor.getBoundingClientRect();
      const left = Math.min(ar.right + 10, window.innerWidth - 220);
      runNote.style.top = `${Math.round(ar.top + (ar.height - noteH) / 2)}px`;
      runNote.style.left = `${Math.round(Math.max(8, left))}px`;
    } else {
      // Idle: just above the message box.
      const cr = (found.ta.closest('form') || found.ta.parentElement).getBoundingClientRect();
      runNote.style.top = `${Math.round(Math.max(8, cr.top - noteH - 6))}px`;
      runNote.style.left = `${Math.round(Math.max(8, cr.left + 8))}px`;
    }
    runNote.style.bottom = 'auto';
    runNote.style.display = 'flex';
  }

  // Finds the visible "Running for …" status text in the chat and returns its element.
  function findRunningStatusAnchor() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const txt = String(node.nodeValue || '').trim();
      if (!/^Running for\b/i.test(txt)) continue;
      const el = node.parentElement;
      if (!el || el.closest('#ash-running-model-note') || el.offsetParent === null) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight) return el;
    }
    return null;
  }

  // Swipe left or right on a bot answer to quote it into the message box as a reply.
  function quoteBotAnswerIntoComposer(msgEl) {
    const found = findVisibleComposer();
    if (!found || !found.ta) return;
    const raw = String(msgEl.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    if (!raw) return;
    const excerpt = raw.length > 500 ? raw.slice(0, 500).trimEnd() + ' …' : raw;
    const quoted = excerpt.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n';
    const ta = found.ta;
    const next = quoted + (ta.value || '');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(ta, next); else ta.value = next;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    try { ta.setSelectionRange(next.length, next.length); } catch {}
  }

  function installSwipeReply() {
    let start = null;
    document.addEventListener('touchstart', (e) => {
      const msg = e.target?.closest?.('[data-look="message-bot"]');
      if (!msg || e.touches.length !== 1) { start = null; return; }
      const t = e.touches[0];
      start = { msg, x: t.clientX, y: t.clientY, time: Date.now() };
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if (!start) return;
      const t = e.touches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (Math.abs(dy) > 30 && Math.abs(dy) > Math.abs(dx)) start = null; // vertical scroll, not a swipe
    }, { passive: true });
    document.addEventListener('touchend', (e) => {
      if (!start) return;
      const s = start;
      start = null;
      const t = e.changedTouches[0];
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (Math.abs(dx) < 70 || Math.abs(dy) > 40 || Date.now() - s.time > 700) return;
      quoteBotAnswerIntoComposer(s.msg);
    }, { passive: true });
  }

  function formatShortTime(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '';
    try {
      const dt = new Date(n);
      const now = new Date();
      if (
        dt.getFullYear() === now.getFullYear() &&
        dt.getMonth() === now.getMonth() &&
        dt.getDate() === now.getDate()
      ) {
        return dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      }
      return dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  }

  function cleanPreviewText(raw) {
    const s = String(raw || '')
      .replace(/```[\s\S]*?```/g, ' [code] ')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}[#>]+\s*/gm, ' ')
      .replace(/(\*\*|__|~~|[`*])/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return s.length > 140 ? s.slice(0, 139) + '…' : s;
  }

  function summarizeChiefBot(bot) {
    const msgs = Array.isArray(bot?.messages) ? bot.messages : [];
    const tasks = Array.isArray(bot?.tasks) ? bot.tasks : [];
    const activeTasks = tasks.filter((t) => t && (t.busy || t.activity === 'working'));
    const working = !!(bot?.busy || bot?.activity === 'working' || activeTasks.length > 0);
    const waiting = !working && !!bot?.waitingForTeammates;
    const unread = !working && !waiting && !!bot?.unread;

    let lastReply = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m || m.role !== 'bot') continue;
      if (m.kind === 'text' && typeof m.text === 'string' && m.text.trim()) {
        lastReply = m;
        break;
      }
    }

    let activeStep = '';
    let activeAt = 0;
    if (working) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (!m) continue;
        if (m.role === 'user') break;
        if (m.kind === 'activity' && m.tool) {
          const spoken = String(m.tool.spoken || '').trim();
          const label = spoken
            ? spoken.charAt(0).toUpperCase() + spoken.slice(1)
            : (m.tool.name ? `Running ${m.tool.name}` : 'Working…');
          activeStep = label;
          activeAt = m.at || 0;
          if (m.tool.ok === undefined) break;
        }
      }
      if (!activeStep && activeTasks.length > 0) {
        const tTitle = String(activeTasks[0].title || '').trim();
        activeStep = tTitle ? `Working · ${tTitle}` : 'Working…';
        activeAt = activeTasks[0].updatedAt || 0;
      }
      if (!activeStep) activeStep = 'Working…';
    }

    const lastMsgAt = (msgs.length > 0 ? msgs[msgs.length - 1]?.at : 0) || 0;
    const ts = activeAt || lastReply?.at || lastMsgAt || 0;
    const preview = lastReply ? cleanPreviewText(lastReply.text) : '';
    const isWarn = /^⚠|quota reached|error:/i.test(preview);
    const statusText = working
      ? activeStep
      : waiting
        ? 'Waiting on teammate'
        : unread
          ? 'New reply'
          : 'Idle';

    return {
      working,
      waiting,
      unread,
      statusText,
      timeLabel: formatShortTime(ts),
      preview,
      isWarn
    };
  }

  async function updateChiefStatusCard(forceRefresh = false) {
    const heroBtn = document.querySelector('button[data-sidebar-hero]');
    if (!heroBtn || heroBtn.offsetParent === null || !heroBtn.parentElement) return;
    const heroRect = heroBtn.getBoundingClientRect();
    if (heroRect.width <= 0 || heroRect.height <= 0) return;

    const heroId = heroBtn.getAttribute('data-sidebar-hero') || '';
    const cachedChief = botsCache.find((b) => b && (b.id === heroId || b.chiefOfStaff));
    const maxAgeMs = cachedChief?.busy ? 2500 : 8000;
    await refreshBotsCache(forceRefresh || botsCache.length === 0, maxAgeMs);

    const bot = botsCache.find((b) => b && (b.id === heroId || b.chiefOfStaff));
    if (!bot) return;

    const info = summarizeChiefBot(bot);
    let card = heroBtn.parentElement.querySelector('#ash-chief-status');
    if (!card) {
      card = document.createElement('div');
      card.id = 'ash-chief-status';
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', `${bot.name || 'Chief of Staff'} status`);
      card.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const btn = document.querySelector(`button[data-sidebar-hero="${heroId}"]`) || heroBtn;
        btn?.click?.();
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const btn = document.querySelector(`button[data-sidebar-hero="${heroId}"]`) || heroBtn;
          btn?.click?.();
        }
      });
      heroBtn.parentElement.appendChild(card);
    }

    const modeCls = info.working ? 'working' : info.waiting ? 'waiting' : info.unread ? 'unread' : '';
    const html = `
      <div class="ash-cs-top">
        <span class="ash-cs-dot"></span>
        <span class="ash-cs-state">${esc(info.statusText)}</span>
        ${info.timeLabel ? `<span class="ash-cs-time">· ${esc(info.timeLabel)}</span>` : ''}
      </div>
      ${info.preview ? `<div class="ash-cs-preview${info.isWarn ? ' warn' : ''}">${esc(info.preview)}</div>` : ''}
    `;

    const key = `${modeCls}|${html}`;
    if (card.dataset.ashKey !== key) {
      card.dataset.ashKey = key;
      card.className = modeCls;
      card.innerHTML = html;
      card.title = info.preview ? `${info.statusText} — ${info.preview}` : info.statusText;
    }
  }

  onLiveBotEvent = (force) => {
    if (liveBotTimer) clearTimeout(liveBotTimer);
    liveBotTimer = setTimeout(() => {
      liveBotTimer = null;
      updateRunningModelNote(!!force);
      updateChiefStatusCard(!!force);
    }, 250);
  };

  installSwipeReply();
  setTimeout(() => { updateRunningModelNote(true); updateChiefStatusCard(true); }, 250);
  setInterval(() => { updateRunningModelNote(false); updateChiefStatusCard(false); }, 900);
  }

  if (document.body) {
    mountHubOverlayDom();
  } else {
    window.addEventListener('DOMContentLoaded', mountHubOverlayDom, { once: true });
  }
})();
