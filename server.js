// server.js — AI Studio Hub v2 (OpenMausBot Base + Native Chat Bridge, Quotas, Radar & Self-Healing Tunnel)
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  OMB_DATA_DIR,
  PUBLIC_DIR,
  buildStalledRadar,
  getAutoPilotRecommendation,
  getBestCodexBin,
  listNativeConversations,
  loadMuseState,
  readNativeTranscript,
  saveMuseState,
  searchNativeConversations,
  syncHubCalendars,
  truncate
} from './hub-core.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HUB_PORT = Number(process.env.HUB_PORT || 4747);
const OMB_PORT = Number(process.env.OMB_PORT || 8799);
const OMB_DIR = path.join(__dirname, 'openmausbot');
const GATEWAY_URL = 'https://ai-studio-hub.mojtaba-safdari-mm.workers.dev';
const GATEWAY_SECRET = '8fa19e8ed7ade397c28256f1d21b7a59ced45297a365c9d9';

// ---------------------------------------------------------------------------
// 1. Ensure OpenMausBot config.json has Codex CLI & AI Studio Hub MCP mounted
// ---------------------------------------------------------------------------
function ensureOmbConfig() {
  try { fs.mkdirSync(OMB_DATA_DIR, { recursive: true }); } catch {}
  const cfgPath = path.join(OMB_DATA_DIR, 'config.json');
  let cfg = {};
  try {
    if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {}

  const codexBin = getBestCodexBin();
  cfg.instances = cfg.instances || {};
  cfg.instances.codex = { ...(cfg.instances.codex || {}), driver: 'codex', cli: codexBin, enabled: true };
  cfg.instances.chatgpt = {
    ...(cfg.instances.chatgpt || {}),
    driver: 'codex',
    displayName: 'ChatGPT plan',
    cli: codexBin,
    enabled: true,
    config: { ...(cfg.instances.chatgpt?.config || {}), authMode: 'chatgpt-plan' }
  };
  cfg.instances.antigravity = { ...(cfg.instances.antigravity || {}), driver: 'antigravityAgent', enabled: true };

  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers.ai_studio_hub = {
    enabled: true,
    command: process.execPath,
    args: [path.join(__dirname, 'hub-mcp.mjs')],
    env: {}
  };

  try {
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    console.warn('[AI Hub] Could not write OpenMausBot config.json:', e.message);
  }
}

// Clear stale OpenMausBot lease if its PID is no longer alive
function clearStaleOmbLease() {
  const leasePath = path.join(OMB_DATA_DIR, 'openmausbot-server.lease');
  if (!fs.existsSync(leasePath)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
    const pid = Number(raw?.pid);
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        return; // still alive
      } catch {
        fs.unlinkSync(leasePath);
        console.log(`[AI Hub] Cleared stale OpenMausBot lease (PID ${pid})`);
      }
    } else {
      fs.unlinkSync(leasePath);
    }
  } catch {
    try { fs.unlinkSync(leasePath); } catch {}
  }
}

// ---------------------------------------------------------------------------
// 2. Managed OpenMausBot Child Process
// ---------------------------------------------------------------------------
let ombProcess = null;
let ombReady = false;

function startOpenMausBot() {
  ensureOmbConfig();
  clearStaleOmbLease();

  const codexDir = path.dirname(getBestCodexBin());
  const env = {
    ...process.env,
    PATH: `${codexDir}${path.delimiter}${process.env.PATH || ''}`,
    OMB_PORT: String(OMB_PORT),
    OMB_DATA_DIR: OMB_DATA_DIR
  };

  const child = spawn(
    process.execPath,
    [
      path.join(OMB_DIR, 'cli.js'),
      'serve',
      '--no-pair',
      '--port', String(OMB_PORT),
      '--data-dir', OMB_DATA_DIR,
      '--public-url', GATEWAY_URL,
      '--label', 'AI Studio Hub'
    ],
    { cwd: OMB_DIR, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  ombProcess = child;

  child.stdout.on('data', (chunk) => {
    const s = chunk.toString().trim();
    if (s) console.log(`[OpenMausBot] ${s}`);
    if (s.includes(`http://127.0.0.1:${OMB_PORT}`)) ombReady = true;
  });
  child.stderr.on('data', (chunk) => {
    const s = chunk.toString().trim();
    if (s && !s.includes('OMB_DEV_TRUST_LOCAL_BROWSER')) console.error(`[OpenMausBot] ${s}`);
  });
  child.on('close', (code) => {
    ombReady = false;
    ombProcess = null;
    console.warn(`[OpenMausBot] Exited with code ${code} — restarting in 3s...`);
    setTimeout(startOpenMausBot, 3000);
  });
}

// ---------------------------------------------------------------------------
// 3. Self-Healing Cloudflare Tunnel + Watchdog
// ---------------------------------------------------------------------------
let tunnelProcess = null;
let tunnelUrl = null;
let tunnelStatus = 'inactive';
let tunnelManuallyStopped = false;
let isStartingTunnel = false;
let tunnelProbeFailCount = 0;
let lastTunnelProbeAt = 0;

function findCloudflaredBin() {
  const p1 = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
  const p2 = 'C:\\Program Files\\cloudflared\\cloudflared.exe';
  if (fs.existsSync(p1)) return p1;
  if (fs.existsSync(p2)) return p2;
  return 'cloudflared';
}

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
  } catch {}
}

async function registerWithGateway(url) {
  try {
    const activeFile = path.join(PUBLIC_DIR, 'active-tunnel.json');
    fs.writeFileSync(activeFile, JSON.stringify({ url, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  } catch {}
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${GATEWAY_URL}/_gateway/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GATEWAY_SECRET}` },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(6000)
      });
      if (res.ok) {
        console.log(`[AI Hub] 🌟 Permanent Gateway registered: ${GATEWAY_URL}`);
        break;
      }
    } catch {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

function startCloudflareTunnel() {
  if (isStartingTunnel || (tunnelProcess && !tunnelProcess.killed && tunnelUrl && tunnelStatus === 'active')) {
    return Promise.resolve({ running: tunnelStatus === 'active', url: tunnelUrl, status: tunnelStatus });
  }
  isStartingTunnel = true;
  tunnelStatus = 'starting';
  return new Promise((resolve) => {
    try {
      const child = spawn(findCloudflaredBin(), ['tunnel', '--url', `http://127.0.0.1:${HUB_PORT}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
      tunnelProcess = child;
      let resolved = false;
      const handleOut = (chunk) => {
        const m = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (m && !resolved) {
          resolved = true;
          isStartingTunnel = false;
          tunnelUrl = m[0];
          tunnelStatus = 'active';
          tunnelProbeFailCount = 0;
          lastTunnelProbeAt = Date.now();
          console.log(`[AI Hub] 📱 Cloudflare Tunnel Live: ${tunnelUrl}`);
          registerWithGateway(tunnelUrl).catch(() => {});
          resolve({ running: true, url: tunnelUrl, status: tunnelStatus });
        }
      };
      child.stdout.on('data', handleOut);
      child.stderr.on('data', handleOut);
      child.on('close', () => {
        tunnelProcess = null;
        tunnelUrl = null;
        tunnelStatus = 'inactive';
        isStartingTunnel = false;
        if (!resolved) {
          resolved = true;
          resolve({ running: false, status: 'inactive' });
        }
        if (!tunnelManuallyStopped) setTimeout(() => startCloudflareTunnel().catch(() => {}), 5000);
      });
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          isStartingTunnel = false;
          killTree(child);
          tunnelProcess = null;
          tunnelStatus = 'inactive';
          resolve({ running: false, status: 'timeout' });
        }
      }, 30000);
    } catch {
      isStartingTunnel = false;
      tunnelStatus = 'error';
      resolve({ running: false, status: 'error' });
    }
  });
}

async function checkTunnelWatchdog() {
  if (tunnelManuallyStopped) return;
  if (!tunnelProcess || !tunnelUrl || tunnelStatus !== 'active') {
    if (!isStartingTunnel) startCloudflareTunnel().catch(() => {});
    return;
  }
  const now = Date.now();
  if (now - lastTunnelProbeAt < 30000) return;
  lastTunnelProbeAt = now;
  try {
    const res = await fetch(`${tunnelUrl}/api/hub/health`, { signal: AbortSignal.timeout(7000) });
    if (res.ok) {
      tunnelProbeFailCount = 0;
    } else {
      tunnelProbeFailCount++;
    }
  } catch {
    tunnelProbeFailCount++;
  }
  if (tunnelProbeFailCount >= 2) {
    console.log('[AI Hub] 🔄 Tunnel watchdog: Tunnel unreachable — restarting fresh...');
    tunnelProbeFailCount = 0;
    killTree(tunnelProcess);
    tunnelProcess = null;
    tunnelUrl = null;
    tunnelStatus = 'inactive';
    startCloudflareTunnel().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 4. Hub Bridge HTTP + WebSocket Reverse Proxy on Port 4747
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://127.0.0.1:${HUB_PORT}`);
  const pathname = urlObj.pathname;

  try {
    // 1. Hub Overlay Script
    if (pathname === '/hub-overlay.js' && req.method === 'GET') {
      const p = path.join(PUBLIC_DIR, 'hub-overlay.js');
      if (!fs.existsSync(p)) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return fs.createReadStream(p).pipe(res);
    }

    // 2. Hub Health
    if (pathname === '/api/hub/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ombReady, tunnelStatus, tunnelUrl, gatewayUrl: GATEWAY_URL });
    }

    // 3. Hub State (Radar, Recent Native Chats, Quotas & Auto-Pilot, Tunnel)
    if (pathname === '/api/hub/state' && req.method === 'GET') {
      const force = urlObj.searchParams.get('force') === '1';
      const [autoPilot, radar, recentNative] = await Promise.all([
        getAutoPilotRecommendation(),
        Promise.resolve(buildStalledRadar()),
        Promise.resolve(listNativeConversations(20).map(({ rolloutPath: _rp, ...rest }) => rest))
      ]);
      if (force) await syncHubCalendars(false);
      return sendJson(res, 200, {
        ok: true,
        autoPilot,
        radar,
        recentNative,
        tunnel: { status: tunnelStatus, url: tunnelUrl, gatewayUrl: GATEWAY_URL }
      });
    }

    // 4. Native Search across Antigravity / Codex / VS Code
    if (pathname === '/api/hub/search' && req.method === 'GET') {
      const q = (urlObj.searchParams.get('q') || '').trim();
      const matches = q ? searchNativeConversations(q, 12) : [];
      return sendJson(res, 200, { ok: true, query: q, matches });
    }

    // 5. Dismiss stalled item
    if (pathname === '/api/hub/dismiss-stalled' && req.method === 'POST') {
      const raw = (await readBody(req)).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      const state = loadMuseState();
      state.dismissedStalled[String(body.threadId || '')] = Date.now();
      saveMuseState({ dismissedStalled: state.dismissedStalled });
      return sendJson(res, 200, { ok: true });
    }

    // 6. Generate 1-Tap OpenMausBot Phone Pairing Link
    if (pathname === '/api/hub/pair-link' && req.method === 'POST') {
      try {
        const out = execFileSync(
          process.execPath,
          [path.join(OMB_DIR, 'cli.js'), 'pair', '--label', 'Phone / Remote Browser'],
          {
            cwd: OMB_DIR,
            env: { ...process.env, OMB_PORT: String(OMB_PORT), OMB_DATA_DIR: OMB_DATA_DIR },
            encoding: 'utf8',
            timeout: 10000,
            windowsHide: true
          }
        );
        const m = out.match(/https?:\/\/[^\s]+/i);
        return sendJson(res, 200, { ok: true, link: m ? m[0] : null, raw: out.trim() });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }

    // 7. Continue a Native Antigravity/Codex/VS Code Chat inside OpenMausBot
    if (pathname === '/api/hub/continue-in-omb' && req.method === 'POST') {
      const raw = (await readBody(req)).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      const conv = readNativeTranscript(String(body.threadId || ''), 24);
      if (!conv) return sendJson(res, 404, { ok: false, error: 'Conversation not found' });

      const botsRes = await fetch(`http://127.0.0.1:${OMB_PORT}/api/bots`);
      const botsData = await botsRes.json();
      const bots = botsData?.bots || [];
      const targetBot = bots.find((b) => /chief|muse|maus/i.test(b.name || '')) || bots[0];
      if (!targetBot) return sendJson(res, 400, { ok: false, error: 'No OpenMausBot bot available yet' });

      const transcriptText = conv.messages
        .slice(-10)
        .map((m) => `**${m.role.toUpperCase()}**: ${truncate(m.content, 500)}`)
        .join('\n\n');

      const prompt = `Continue this ${conv.origin.toUpperCase()} conversation ("${conv.title}"${conv.projectPath ? `, workspace: \`${conv.projectPath}\`` : ''}).\n\nRecent context:\n${transcriptText}\n\nPlease summarize where things left off and continue with the next step.`;

      const taskRes = await fetch(`http://127.0.0.1:${OMB_PORT}/api/bots/${targetBot.id}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: conv.title,
          ...(conv.projectPath && fs.existsSync(conv.projectPath) ? { cwd: conv.projectPath } : {})
        })
      });
      const taskData = await taskRes.json().catch(() => ({}));
      const threadId = taskData?.task?.threadId || targetBot.threadId;

      await fetch(`http://127.0.0.1:${OMB_PORT}/api/bots/${targetBot.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, text: prompt })
      });

      return sendJson(res, 200, { ok: true, botId: targetBot.id, threadId });
    }

    // 8. Reverse Proxy all other HTTP / SSE requests to OpenMausBot (127.0.0.1:8799)
    const proxyHeaders = { ...req.headers };
    delete proxyHeaders['accept-encoding']; // avoid gzip so we can cleanly inject <script> into HTML

    const proxyReq = http.request(
      {
        hostname: '127.0.0.1',
        port: OMB_PORT,
        path: req.url,
        method: req.method,
        headers: proxyHeaders
      },
      (proxyRes) => {
        const ct = String(proxyRes.headers['content-type'] || '').toLowerCase();
        const isRootHtml = ct.includes('text/html') && (pathname === '/' || pathname === '/index.html');
        if (isRootHtml) {
          const chunks = [];
          proxyRes.on('data', (c) => chunks.push(c));
          proxyRes.on('end', () => {
            let html = Buffer.concat(chunks).toString('utf8');
            if (!html.includes('/hub-overlay.js')) {
              html = html.replace('</body>', '<script src="/hub-overlay.js" defer></script></body>');
            }
            const outHeaders = { ...proxyRes.headers };
            delete outHeaders['content-length'];
            res.writeHead(proxyRes.statusCode || 200, outHeaders);
            res.end(html);
          });
        } else {
          res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
          proxyRes.pipe(res);
        }
      }
    );

    proxyReq.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body style="background:#0f172a;color:#f8fafc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;"><div>⚡ Starting OpenMausBot + AI Studio Hub... <script>setTimeout(()=>location.reload(),1500)</script></div></body></html>');
      }
    });

    req.pipe(proxyReq);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
  }
});

// Forward WebSocket upgrades directly to OpenMausBot
server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(OMB_PORT, '127.0.0.1', () => {
    const headerLines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      headerLines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(headerLines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

process.on('SIGINT', () => {
  tunnelManuallyStopped = true;
  if (tunnelProcess) killTree(tunnelProcess);
  if (ombProcess) killTree(ombProcess);
  process.exit(0);
});

server.listen(HUB_PORT, '127.0.0.1', () => {
  console.log(`\n⚡ AI Studio Hub v2 (OpenMausBot Base) running → http://127.0.0.1:${HUB_PORT}`);
  startOpenMausBot();
  startCloudflareTunnel().catch(() => {});
  setInterval(() => {
    checkTunnelWatchdog().catch(() => {});
  }, 15000);
});
