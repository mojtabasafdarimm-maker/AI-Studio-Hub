// server.js — AI Studio Hub v2 (OpenMausBot Base + Native Chat Bridge, Quotas, Radar & Self-Healing Tunnel)
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
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

// Load local .env if present
try {
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  }
} catch {}

const GATEWAY_URL = process.env.GATEWAY_URL || 'https://ai-studio-hub.mojtaba-safdari-mm.workers.dev';
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || '8fa19e8ed7ade397c28256f1d21b7a59ced45297a365c9d9';

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

  if (process.env.COMPOSIO_API_KEY && (!cfg.composio || !cfg.composio.apiKey)) {
    cfg.composio = { ...(cfg.composio || {}), apiKey: process.env.COMPOSIO_API_KEY };
  }
  if (!cfg.everyBotRules) {
    const homeDir = process.env.USERPROFILE || 'C:\\Users\\Public';
    const driveDir = path.join(homeDir, 'My Drive');
    cfg.everyBotRules = `You are running locally on the user's Windows PC (${homeDir}). You HAVE full local file and PowerShell (shell) access to this computer. If Google Drive is synced at ${driveDir}, check there for local folders. Never tell the user you cannot see their files or ask them to enable "This computer" screen mode—use PowerShell/shell and file tools directly on ${driveDir} and ${homeDir}.`;
  }

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

// ---------------------------------------------------------------------------
// 1b. Auto-Authentication / Pairing Bypass (Master Session Token)
// ---------------------------------------------------------------------------
let masterTokenCache = null;
function getMasterToken() {
  if (masterTokenCache) return masterTokenCache;
  const tokenFile = path.join(OMB_DIR, 'master-token.txt');
  if (fs.existsSync(tokenFile)) {
    try {
      const t = fs.readFileSync(tokenFile, 'utf8').trim();
      if (t) { masterTokenCache = t; return t; }
    } catch {}
  }
  try {
    execFileSync(
      process.execPath,
      [path.join(OMB_DIR, 'cli.js'), 'token', 'create', 'AutoPass', '--out', 'master-token.txt', '--scope', 'admin', '--expires', '180d', '--force'],
      { cwd: OMB_DIR, encoding: 'utf8', timeout: 15000, windowsHide: true }
    );
    if (fs.existsSync(tokenFile)) {
      masterTokenCache = fs.readFileSync(tokenFile, 'utf8').trim();
      return masterTokenCache;
    }
  } catch (err) {
    console.warn('[AI Hub] Could not create master token:', err.message);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1c. Google Drive Cloud Sync & Persistence (Full Agent State + History)
// ---------------------------------------------------------------------------
const CLOUD_SYNC_DIR = path.join(__dirname, 'cloud-sync');
const CLOUD_SYNC_SKIP_DIRS = new Set(['tools', 'agent-browser-profiles', 'browser', 'events']);

function copyDirRecursive(srcDir, dstDir, { overwrite = true, skipDirs = new Set() } = {}) {
  if (!fs.existsSync(srcDir)) return 0;
  if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === 'openmausbot-server.lease' || entry.name.startsWith('config.json.bak.')) continue;
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      count += copyDirRecursive(srcPath, dstPath, { overwrite });
    } else {
      try {
        if (!overwrite && fs.existsSync(dstPath)) continue;
        const srcStat = fs.statSync(srcPath);
        if (fs.existsSync(dstPath)) {
          const dstStat = fs.statSync(dstPath);
          if (srcStat.size === dstStat.size && Math.abs(srcStat.mtimeMs - dstStat.mtimeMs) < 2000) {
            continue;
          }
        }
        fs.copyFileSync(srcPath, dstPath);
        count++;
      } catch {}
    }
  }
  return count;
}

function restoreDataFromCloudDrive() {
  try {
    if (!fs.existsSync(CLOUD_SYNC_DIR)) return;
    if (!fs.existsSync(OMB_DATA_DIR)) fs.mkdirSync(OMB_DATA_DIR, { recursive: true });
    // Skip slow Google Drive scan if local agent data is already present
    if (fs.existsSync(path.join(OMB_DATA_DIR, 'bots.json')) && fs.existsSync(path.join(OMB_DATA_DIR, 'messages.db'))) {
      return;
    }

    // Restore full agent directory tree if local files are missing (e.g., new PC / fresh install)
    const restored = copyDirRecursive(CLOUD_SYNC_DIR, OMB_DATA_DIR, {
      overwrite: false,
      skipDirs: new Set(['sync-manifest.json'])
    });
    if (restored > 0) {
      console.log(`[Cloud Sync] Restored ${restored} agent files from Google Drive (${CLOUD_SYNC_DIR})`);
    }
    const dbBackup = path.join(CLOUD_SYNC_DIR, 'messages-backup.db');
    const dbDst = path.join(OMB_DATA_DIR, 'messages.db');
    if (fs.existsSync(dbBackup) && !fs.existsSync(dbDst)) {
      fs.copyFileSync(dbBackup, dbDst);
      console.log('[Cloud Sync] Restored messages.db from Google Drive backup');
    }
  } catch (err) {
    console.warn('[Cloud Sync Restore Warning]', err.message);
  }
}

function syncDataToCloudDrive() {
  try {
    if (!fs.existsSync(CLOUD_SYNC_DIR)) fs.mkdirSync(CLOUD_SYNC_DIR, { recursive: true });
    const fileCount = copyDirRecursive(OMB_DATA_DIR, CLOUD_SYNC_DIR, {
      overwrite: true,
      skipDirs: CLOUD_SYNC_SKIP_DIRS
    });

    // Keep explicit messages-backup.db copy as well
    const dbSrc = path.join(OMB_DATA_DIR, 'messages.db');
    if (fs.existsSync(dbSrc)) {
      try { fs.copyFileSync(dbSrc, path.join(CLOUD_SYNC_DIR, 'messages-backup.db')); } catch {}
    }

    // Also mirror master-token.txt & LIVE_SHARED_CONTEXT.md so login & cross-app context never break
    const tokenSrc = path.join(OMB_DIR, 'master-token.txt');
    if (fs.existsSync(tokenSrc)) {
      try { fs.copyFileSync(tokenSrc, path.join(CLOUD_SYNC_DIR, 'master-token.txt')); } catch {}
    }
    const liveSharedSrc = path.join(process.env.LOCALAPPDATA || '', 'AIStudioHub', 'LIVE_SHARED_CONTEXT.md');
    if (fs.existsSync(liveSharedSrc)) {
      try { fs.copyFileSync(liveSharedSrc, path.join(CLOUD_SYNC_DIR, 'LIVE_SHARED_CONTEXT.md')); } catch {}
    }

    const manifest = {
      syncedAt: new Date().toISOString(),
      location: CLOUD_SYNC_DIR,
      fileCount,
      status: 'active'
    };
    fs.writeFileSync(path.join(CLOUD_SYNC_DIR, 'sync-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Cloud Sync Backup Warning]', err.message);
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
  restoreDataFromCloudDrive();
  ensureOmbConfig();
  clearStaleOmbLease();

  const codexDir = path.dirname(getBestCodexBin());
  const env = {
    ...process.env,
    PATH: `${codexDir}${path.delimiter}${process.env.PATH || ''}`,
    OMB_PORT: String(OMB_PORT),
    OMB_DATA_DIR: OMB_DATA_DIR,
    COMPOSIO_API_KEY: process.env.COMPOSIO_API_KEY || ''
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
        const text = chunk.toString();
        const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
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
        if (text.includes('ERR') || text.includes('error') || text.includes('failed') || text.includes('closed')) {
          console.warn('[cloudflared log]', text.trim());
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
// 3b. Local Loopback SSE Tap (Captures live 8799 SSE events for JSON Mobile Polling)
// ---------------------------------------------------------------------------
let hubEventSeq = 0;
let latestOmbCursor = 'hub:0';
const hubEventHistory = [];
let localSseTapActive = false;

function processSseBlock(rawBlock) {
  const lines = rawBlock.split(/\r?\n/);
  let eventId = '';
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('id:')) {
      eventId = line.slice(3).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return;
  const dataStr = dataLines.join('\n');
  try {
    const parsed = JSON.parse(dataStr);
    if (parsed.kind === 'ping') return;
    if (parsed.kind === 'hello') {
      if (parsed.cursor) latestOmbCursor = parsed.cursor;
      return;
    }
    if (eventId) latestOmbCursor = eventId;
    hubEventSeq++;
    hubEventHistory.push({
      seq: hubEventSeq,
      id: eventId || latestOmbCursor || `hub:${hubEventSeq}`,
      data: dataStr,
      at: Date.now()
    });
    if (hubEventHistory.length > 600) {
      hubEventHistory.shift();
    }
  } catch {}
}

function startLocalSseTap() {
  if (localSseTapActive) return;
  if (!ombReady) {
    setTimeout(startLocalSseTap, 1000);
    return;
  }
  const masterToken = getMasterToken();
  const cookieName = 'omb_session_' + OMB_PORT + '_33ce60cb46e1';
  localSseTapActive = true;

  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: OMB_PORT,
      path: '/api/events?screens=off&window=1&frames=thread',
      method: 'GET',
      headers: {
        ...(masterToken ? { Authorization: `Bearer ${masterToken}`, Cookie: `${cookieName}=${masterToken}` } : {})
      }
    },
    (res) => {
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          processSseBlock(block);
        }
      });
      res.on('end', () => {
        localSseTapActive = false;
        setTimeout(startLocalSseTap, 1500);
      });
      res.on('error', () => {
        localSseTapActive = false;
        setTimeout(startLocalSseTap, 1500);
      });
    }
  );
  req.on('error', () => {
    localSseTapActive = false;
    setTimeout(startLocalSseTap, 1500);
  });
  req.end();
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
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://127.0.0.1:${HUB_PORT}`);
  const pathname = urlObj.pathname;
  if (pathname.startsWith('/api/') && pathname !== '/api/hub/events-poll') {
    console.log(`[REQ] ${req.method} ${pathname}`);
  }

  try {
    const masterToken = getMasterToken();
    const cookieName = 'omb_session_' + OMB_PORT + '_33ce60cb46e1';

    // 0. Frictionless Auto-Pairing: If visiting /pair, redirect directly to / with valid session cookie
    if (pathname === '/pair' || pathname.startsWith('/pair/')) {
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': masterToken ? `${cookieName}=${masterToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=315360000; Secure` : ''
      });
      return res.end();
    }

    // 1. Hub Overlay Script
    if (pathname === '/hub-overlay.js' && req.method === 'GET') {
      const p = path.join(PUBLIC_DIR, 'hub-overlay.js');
      if (!fs.existsSync(p)) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return fs.createReadStream(p).pipe(res);
    }

    // 1b. Cloudflare-proof JSON Polling endpoint for real-time OpenMausBot events
    if (pathname === '/api/hub/events-poll' && req.method === 'GET') {
      const sinceParam = urlObj.searchParams.get('since');
      const since = sinceParam !== null ? Number(sinceParam) : null;
      const needsSnapshot =
        since === null ||
        !Number.isFinite(since) ||
        since > hubEventSeq ||
        (hubEventHistory.length > 0 && since < hubEventHistory[0].seq - 1);

      if (needsSnapshot) {
        return sendJson(res, 200, {
          ok: true,
          seq: hubEventSeq,
          events: [
            {
              id: '',
              data: JSON.stringify({ kind: 'hello', cursor: latestOmbCursor || 'hub:0', resumed: false })
            }
          ]
        });
      }

      const fresh = hubEventHistory
        .filter((e) => e.seq > since)
        .map((e) => ({ id: e.id, data: e.data }));

      return sendJson(res, 200, {
        ok: true,
        seq: hubEventSeq,
        events: fresh
      });
    }

    // Helper: safely serve local files inside allowed roots
    function resolveAllowedLocalFile(rawInput) {
      let s = String(rawInput || '').trim();
      try { s = decodeURIComponent(s); } catch {}
      if (s.startsWith('file:///')) s = s.slice(8);
      if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1);
      // Strip optional :line or :line:col suffix if the stripped path exists
      const lineMatch = s.match(/^([A-Za-z]:[\\/].+?):\d+(?::\d+)?$/);
      if (lineMatch && !fs.existsSync(s) && fs.existsSync(lineMatch[1])) s = lineMatch[1];
      let filePath;
      try { filePath = path.resolve(s); } catch { return { allowed: false, filePath: null }; }
      const home = process.env.USERPROFILE || 'C:\\Users\\msafdari';
      const roots = [
        path.resolve(OMB_DATA_DIR),
        path.resolve(home, 'My Drive'),
        path.resolve(home, 'OneDrive - University of Guelph'),
        path.resolve(__dirname, '..')
      ];
      const allowed = roots.some((r) => filePath.toLowerCase().startsWith(r.toLowerCase() + path.sep));
      return { allowed, filePath };
    }

    function sendLocalFileResponse(filePath, res, headOnly = false) {
      let st;
      try { st = fs.statSync(filePath); } catch { st = null; }
      if (!st || !st.isFile()) return false;
      const ext = path.extname(filePath).toLowerCase();
      const MIME = {
        '.md': 'text/markdown; charset=utf-8', '.markdown': 'text/markdown; charset=utf-8',
        '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
        '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.py': 'text/plain; charset=utf-8',
        '.js': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8', '.pdf': 'application/pdf',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
        '.zip': 'application/zip', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      };
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-store',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`
      });
      if (headOnly) { res.end(); return true; }
      fs.createReadStream(filePath).pipe(res);
      return true;
    }

    // 1c. Direct local file URLs (e.g. /C:/Users/.../report.md)
    if (/^\/[A-Za-z]:\//.test(pathname) && (req.method === 'GET' || req.method === 'HEAD')) {
      const { allowed, filePath } = resolveAllowedLocalFile(pathname);
      if (!allowed) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Forbidden: outside shared folders'); }
      if (!sendLocalFileResponse(filePath, res, req.method === 'HEAD')) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('File not found');
      }
      return;
    }

    // 1d. OpenMausBot chat file-link click handler (/api/threads/:id/messages/:msgId/file)
    if (/^\/api\/threads\/[^/]+\/messages\/[^/]+\/file$/.test(pathname) && req.method === 'POST') {
      const rawBody = (await readBody(req)).toString('utf8');
      let body = {};
      try { body = rawBody ? JSON.parse(rawBody) : {}; } catch {}
      const normalizedReqPath = typeof body.path === 'string' && /^\/[A-Za-z]:[\\/]/.test(body.path)
        ? body.path.slice(1)
        : body.path;
      const forwardBody = JSON.stringify({ ...body, path: normalizedReqPath });
      const upstreamRes = await fetch(`http://127.0.0.1:${OMB_PORT}${req.url}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(masterToken ? { Authorization: `Bearer ${masterToken}` } : {})
        },
        body: forwardBody
      }).catch(() => null);

      if (upstreamRes && upstreamRes.ok) {
        const buf = Buffer.from(await upstreamRes.arrayBuffer());
        const outH = { 'Content-Type': upstreamRes.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-store' };
        const folderHdr = upstreamRes.headers.get('x-openmausbot-folder');
        if (folderHdr) outH['x-openmausbot-folder'] = folderHdr;
        res.writeHead(upstreamRes.status, outH);
        return res.end(buf);
      }

      // Fallback: serve allowed local file directly if OpenMausBot returned 404/403 (e.g. /C:/... or outside task sandbox)
      const { allowed, filePath } = resolveAllowedLocalFile(body.path || normalizedReqPath);
      if (allowed && filePath && sendLocalFileResponse(filePath, res, false)) {
        return;
      }
      const errStatus = upstreamRes ? upstreamRes.status : 404;
      const errText = upstreamRes ? await upstreamRes.text().catch(() => '{"error":"File unavailable"}') : '{"error":"File unavailable"}';
      res.writeHead(errStatus, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(errText);
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
        const out = await new Promise((resolve, reject) => {
          execFile(
            process.execPath,
            [
              path.join(OMB_DIR, 'cli.js'),
              'pair',
              '--label', 'Phone / Remote Browser',
              '--ttl', '24h',
              '--public-url', GATEWAY_URL
            ],
            {
              cwd: OMB_DIR,
              env: { ...process.env, OMB_PORT: String(OMB_PORT), OMB_DATA_DIR: OMB_DATA_DIR },
              encoding: 'utf8',
              timeout: 15000,
              windowsHide: true
            },
            (err, stdout, stderr) => {
              if (err) return reject(new Error(stderr || err.message));
              resolve(stdout);
            }
          );
        });
        const linkMatch = out.match(/https?:\/\/[^\s]+/i);
        const codeMatch = out.match(/Pairing code\s+([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/i);
        return sendJson(res, 200, {
          ok: true,
          link: linkMatch ? linkMatch[0] : null,
          code: codeMatch ? codeMatch[1] : null,
          raw: out.trim()
        });
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

    // Seamless auto-authentication: Pass master session so user is never prompted for pairing
    if (masterToken) {
      if (!proxyHeaders['authorization']) {
        proxyHeaders['authorization'] = `Bearer ${masterToken}`;
      }
      const existingCookie = proxyHeaders['cookie'] || '';
      if (!existingCookie.includes(cookieName)) {
        proxyHeaders['cookie'] = existingCookie ? `${existingCookie}; ${cookieName}=${masterToken}` : `${cookieName}=${masterToken}`;
      }
    }

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

        const outHeaders = { ...proxyRes.headers };

        // Ensure browser receives the persistent session cookie
        if (masterToken && !req.headers.cookie?.includes(cookieName)) {
          const autoCookie = `${cookieName}=${masterToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=315360000; Secure`;
          if (outHeaders['set-cookie']) {
            if (Array.isArray(outHeaders['set-cookie'])) {
              outHeaders['set-cookie'].push(autoCookie);
            } else {
              outHeaders['set-cookie'] = [outHeaders['set-cookie'], autoCookie];
            }
          } else {
            outHeaders['set-cookie'] = autoCookie;
          }
        }

        const isSse = ct.includes('text/event-stream') || pathname === '/api/events';
        if (isSse) {
          console.log('[SSE] Client connected to SSE stream:', pathname);
          outHeaders['cache-control'] = 'no-cache, no-transform';
          outHeaders['x-accel-buffering'] = 'no';
          outHeaders['connection'] = 'keep-alive';
          delete outHeaders['content-length'];
          res.socket?.setNoDelay(true);
          res.writeHead(proxyRes.statusCode || 200, outHeaders);
          if (typeof res.flushHeaders === 'function') res.flushHeaders();

          // Cloudflare Quick Tunnels buffer chunked streams in 128KB blocks.
          // By writing the real SSE data chunk FIRST and flushing a 128KB comment padding
          // 40ms AFTER each event burst, Cloudflare immediately delivers every event to mobile!
          const SSE_PAD = ': ' + ' '.repeat(131072) + '\n\n';
          let padTimer = null;
          let lastPadAt = 0;
          const schedulePadFlush = (delayMs = 40) => {
            if (padTimer) return;
            padTimer = setTimeout(() => {
              padTimer = null;
              if (!res.writableEnded && !res.destroyed) {
                res.write(SSE_PAD);
                lastPadAt = Date.now();
              }
            }, delayMs);
          };

          proxyRes.on('data', (chunk) => {
            res.write(chunk);
            const text = chunk.toString('utf8');
            const isPing = text.includes('"kind":"ping"');
            if (!isPing) {
              console.log('[SSE Event from 8799]', chunk.length, 'bytes -> flushing to edge');
              schedulePadFlush(40);
            } else if (Date.now() - lastPadAt > 20000) {
              schedulePadFlush(40);
            }
          });
          proxyRes.on('end', () => {
            if (padTimer) clearTimeout(padTimer);
            console.log('[SSE End]');
            res.end();
          });
          proxyRes.on('error', (err) => {
            if (padTimer) clearTimeout(padTimer);
            console.warn('[SSE Error]', err.message);
            res.end();
          });
          req.on('close', () => {
            if (padTimer) clearTimeout(padTimer);
            console.log('[SSE Request Closed by client]');
            proxyReq.destroy();
          });
          return;
        }

        if (isRootHtml) {
          const chunks = [];
          proxyRes.on('data', (c) => chunks.push(c));
          proxyRes.on('end', () => {
            let html = Buffer.concat(chunks).toString('utf8');
            if (!html.includes('/hub-overlay.js')) {
              html = html.replace('<head>', `<head><script src="/hub-overlay.js?v=${Date.now()}"></script>`);
            }
            outHeaders['cache-control'] = 'no-store, no-cache, must-revalidate';
            delete outHeaders['content-length'];
            delete outHeaders['etag'];
            res.writeHead(proxyRes.statusCode || 200, outHeaders);
            res.end(html);
          });
        } else {
          res.writeHead(proxyRes.statusCode || 200, outHeaders);
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

// Forward WebSocket upgrades directly to OpenMausBot with auto-authentication
server.on('upgrade', (req, socket, head) => {
  const masterToken = getMasterToken();
  const cookieName = 'omb_session_' + OMB_PORT + '_33ce60cb46e1';

  const upstream = net.connect(OMB_PORT, '127.0.0.1', () => {
    const headers = { ...req.headers };
    if (masterToken) {
      if (!headers['authorization']) headers['authorization'] = `Bearer ${masterToken}`;
      const existingCookie = headers['cookie'] || '';
      if (!existingCookie.includes(cookieName)) {
        headers['cookie'] = existingCookie ? `${existingCookie}; ${cookieName}=${masterToken}` : `${cookieName}=${masterToken}`;
      }
    }

    const headerLines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (const [k, v] of Object.entries(headers)) {
      if (Array.isArray(v)) {
        for (const item of v) headerLines.push(`${k}: ${item}`);
      } else if (v !== undefined) {
        headerLines.push(`${k}: ${v}`);
      }
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
  syncDataToCloudDrive();
  if (tunnelProcess) killTree(tunnelProcess);
  if (ombProcess) killTree(ombProcess);
  process.exit(0);
});

server.listen(HUB_PORT, '127.0.0.1', () => {
  console.log(`\n⚡ AI Studio Hub v2 (OpenMausBot Base) running → http://127.0.0.1:${HUB_PORT}`);
  startOpenMausBot();
  startLocalSseTap();
  startCloudflareTunnel().catch(() => {});
  setTimeout(() => syncDataToCloudDrive(), 5000);
  setInterval(() => {
    checkTunnelWatchdog().catch(() => {});
  }, 15000);
  setInterval(() => {
    syncDataToCloudDrive();
  }, 180000); // sync every 3 minutes
});
