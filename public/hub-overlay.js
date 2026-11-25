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
          for (const ev of events) {
            if (this._closed) return;
            if (typeof this.onmessage === 'function') {
              this.onmessage({ data: ev.data, lastEventId: ev.id || '' });
            }
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
    const p = origFetch.apply(this, args);
    if (method === 'POST' && (url.includes('/messages') || url.includes('/tasks') || url.includes('/turns'))) {
      p.then(() => {
        nudgeAllEventSources();
        setTimeout(nudgeAllEventSources, 250);
        setTimeout(nudgeAllEventSources, 600);
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
    @media (max-width: 640px) {
      :root {
        --chat-bubble-max: 100% !important;
        --chat-bubble-pct: 94% !important;
        --chat-card-pct: 96% !important;
        --chat-prose-max: 100% !important;
      }
      .chat-text, [data-chat-bubble], [data-reply-bubble], .reply-bubble {
        max-width: min(94%, calc(100vw - 24px)) !important;
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
    @media (max-width: 768px) {
      body:has([data-browser-surface]) #ash-pill {
        display: none !important;
      }
    }
  `;
  document.head.appendChild(style);

  const pill = document.createElement('div');
  pill.id = 'ash-pill';
  pill.title = 'Drag to move · Click Hub, Allowances, or Go';
  pill.innerHTML = `
    <button type="button" id="ash-btn-hub" class="ash-pill-seg" title="Open AI Studio Hub"><span>⚡ Hub</span><span id="ash-pill-dot"></span></button>
    <span class="ash-pill-div"></span>
    <button type="button" id="ash-btn-allowances" class="ash-pill-seg allowances" title="View Model Allowances & Reset Times Across All Accounts"><span id="ash-allow-dot"></span><span>📊 Allowances</span></button>
    <span class="ash-pill-div"></span>
    <button type="button" id="ash-btn-go" class="ash-pill-seg go" title="Send &quot;Go&quot; in the current chat"><span>▶ Go</span></button>
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
        const pillW = pill.offsetWidth || 240;
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

  let goSending = false;
  let goFlashTimer = null;

  function flashGoBtn(btn, label, cls, ms = 1100) {
    if (!btn) return;
    if (goFlashTimer) {
      clearTimeout(goFlashTimer);
      goFlashTimer = null;
    }
    btn.classList.remove('sent', 'warn');
    if (cls) btn.classList.add(cls);
    btn.textContent = label;
    btn.disabled = true;
    goFlashTimer = setTimeout(() => {
      goFlashTimer = null;
      btn.classList.remove('sent', 'warn');
      btn.innerHTML = '<span>▶ Go</span>';
      btn.disabled = false;
    }, ms);
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
      if (/stop|dictat|voice|record|mic/i.test(aria)) return false;
      return true;
    });
    return candidates[candidates.length - 1] || null;
  }

  function triggerQuickGo(btn) {
    if (goSending) return;
    const found = findVisibleComposer();
    if (!found || !found.ta) {
      flashGoBtn(btn, 'No chat', 'warn');
      return;
    }
    const { actionsEl, ta } = found;
    if (ta.disabled) {
      flashGoBtn(btn, 'Busy', 'warn');
      return;
    }
    const current = String(ta.value || '').trim();
    if (current.length > 0 && current.toLowerCase() !== 'go') {
      flashGoBtn(btn, 'Clear box', 'warn', 1300);
      return;
    }

    goSending = true;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(ta, 'Go');
    else ta.value = 'Go';
    ta.dispatchEvent(new Event('input', { bubbles: true }));

    let frames = 0;
    const maxFrames = 12;
    const trySend = () => {
      const sendBtn = findComposerSendButton(actionsEl);
      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
        goSending = false;
        flashGoBtn(btn, '✓ Sent', 'sent', 950);
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
        goSending = false;
        if (String(ta.value || '').trim() === '') {
          flashGoBtn(btn, '✓ Sent', 'sent', 950);
          nudgeAllEventSources();
        } else {
          flashGoBtn(btn, 'Retry', 'warn', 1200);
        }
      }, 100);
    };
    requestAnimationFrame(trySend);
  }

  pill.addEventListener('click', (e) => {
    if (hasMoved) {
      e.preventDefault();
      e.stopPropagation();
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

  setTimeout(() => loadHubState(false), 1500);
  setInterval(() => loadHubState(false), 60000);
  }

  if (document.body) {
    mountHubOverlayDom();
  } else {
    window.addEventListener('DOMContentLoaded', mountHubOverlayDom, { once: true });
  }
})();
