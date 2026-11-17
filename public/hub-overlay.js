// hub-overlay.js — Calm-by-Default AI Studio Hub Drawer inside OpenMausBot
(() => {
  if (window.__AI_STUDIO_HUB_OVERLAY__) return;
  window.__AI_STUDIO_HUB_OVERLAY__ = true;

  const style = document.createElement('style');
  style.textContent = `
    #ash-pill {
      position: fixed;
      bottom: 24px;
      left: 20px;
      z-index: 9998;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 999px;
      border: 1px solid rgba(148, 163, 184, 0.28);
      background: rgba(17, 24, 39, 0.88);
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
  `;
  document.head.appendChild(style);

  const pill = document.createElement('button');
  pill.id = 'ash-pill';
  pill.title = 'AI Studio Hub — Quotas, Stalled Radar, Native Chats & Remote Pairing';
  pill.innerHTML = '<span>⚡ Hub</span><span id="ash-pill-dot"></span>';
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
        <button class="ash-tab active" data-tab="radar">📡 Radar</button>
        <button class="ash-tab" data-tab="chats">🔍 Chats</button>
        <button class="ash-tab" data-tab="quotas">⚡ Quotas</button>
        <button class="ash-tab" data-tab="remote">📱 Remote</button>
      </div>
      <div id="ash-body" class="ash-body"></div>
    </div>
  `;
  document.body.appendChild(backdrop);

  let activeTab = 'radar';
  let hubState = null;
  let searchResults = [];
  let searchQuery = '';
  let pairInfo = null;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function originPill(origin) {
    const o = String(origin || '').toLowerCase();
    if (o === 'antigravity') return '<span class="ash-badge" style="background:rgba(139,92,246,0.22); color:#c4b5fd;">🚀 Antigravity</span>';
    if (o === 'vscode') return '<span class="ash-badge" style="background:rgba(56,189,248,0.22); color:#7dd3fc;">💻 VS Code</span>';
    return '<span class="ash-badge" style="background:rgba(16,185,129,0.22); color:#6ee7b7;">⚡ Codex</span>';
  }

  async function loadHubState(force = false) {
    try {
      const res = await fetch('/api/hub/state' + (force ? '?force=1' : ''));
      if (!res.ok) return;
      hubState = await res.json();
      const dot = document.getElementById('ash-pill-dot');
      if (dot) {
        dot.style.display = (hubState?.radar?.stalledTasks?.length || 0) > 0 ? 'inline-block' : 'none';
      }
      if (backdrop.classList.contains('open')) renderBody();
    } catch {}
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
      const ap = hubState.autoPilot || {};
      const agyPools = ap.agy?.pools || [];
      const cx5 = ap.codex?.fiveHourWindow?.remainingPct ?? 100;
      const cx7 = ap.codex?.weeklyWindow?.remainingPct ?? 100;
      const barColor = (pct) => pct <= 15 ? '#ef4444' : pct <= 35 ? '#f59e0b' : '#10b981';

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
          ${agyPools.length === 0 ? '<div style="font-size:12px; color:#94a3b8;">Start Antigravity IDE to refresh live pool quotas.</div>' : agyPools.map((p) => `
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
        const maxW = window.innerWidth - 80;
        const maxH = window.innerHeight - 40;
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

  pill.addEventListener('click', (e) => {
    if (hasMoved) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    backdrop.classList.add('open');
    loadHubState(true);
  });
  backdrop.addEventListener('click', () => backdrop.classList.remove('open'));
  document.getElementById('ash-close-btn')?.addEventListener('click', () => backdrop.classList.remove('open'));
  document.getElementById('ash-refresh-btn')?.addEventListener('click', () => loadHubState(true));
  backdrop.querySelectorAll('.ash-tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      activeTab = tabBtn.getAttribute('data-tab');
      backdrop.querySelectorAll('.ash-tab').forEach((t) => t.classList.toggle('active', t === tabBtn));
      renderBody();
    });
  });

  setTimeout(() => loadHubState(false), 1500);
  setInterval(() => loadHubState(false), 60000);
})();
