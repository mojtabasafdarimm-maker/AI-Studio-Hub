// hub-core.mjs — Shared AI Studio Hub engine for OpenMausBot integration:
// • Native conversation discovery (Antigravity SQLite + brain transcripts, Codex & VS Code rollouts)
// • Stalled-Task Radar & Full-Text Search across all models
// • Real-time Antigravity & Codex quota tracking + Auto-Pilot recommendation
// • Calendar sync (Windows/Outlook + .ics feeds) & Reminders
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const HOME = os.homedir();
export const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
export const DATA_DIR = path.join(LOCAL_APPDATA, 'AIStudioHub');
export const PUBLIC_DIR = path.join(__dirname, 'public');
export const OMB_DATA_DIR = path.join(DATA_DIR, 'openmausbot-data');
export const MUSE_STATE_FILE = path.join(DATA_DIR, 'muse_state.json');
export const MUSE_CAL_DIR = path.join(DATA_DIR, 'calendars');

export const AGY_DB_PATH = path.join(HOME, '.gemini', 'antigravity', 'conversation_summaries.db');
export const AGY_BRAIN_DIR = path.join(HOME, '.gemini', 'antigravity', 'brain');
export const CODEX_DB_PATH = path.join(HOME, '.codex', 'state_5.sqlite');

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(MUSE_CAL_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(OMB_DATA_DIR, { recursive: true }); } catch {}

export function normalizeWinPath(p) {
  if (!p || typeof p !== 'string') return null;
  let s = p.trim();
  if (s.startsWith('file:///')) {
    s = decodeURIComponent(s.slice(8)).replace(/\//g, '\\');
  } else if (s.startsWith('file://')) {
    s = decodeURIComponent(s.slice(7)).replace(/\//g, '\\');
  }
  s = s.replace(/^\/([a-zA-Z]:)/, '$1').replace(/\//g, '\\').replace(/\\+$/, '');
  return s || null;
}

export function truncate(str, max = 140) {
  const s = String(str || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// ---------------------------------------------------------------------------
// 1. Binary Discovery (Codex & Antigravity)
// ---------------------------------------------------------------------------
function parseCodexVersion(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.]+))?/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '', text: m[0] };
}

export function discoverCodexBinaries() {
  const found = new Map();
  const desktopBinDir = path.join(LOCAL_APPDATA, 'OpenAI', 'Codex', 'bin');
  if (fs.existsSync(desktopBinDir)) {
    try {
      for (const entry of fs.readdirSync(desktopBinDir)) {
        const p = path.join(desktopBinDir, entry, 'codex.exe');
        if (fs.existsSync(p)) found.set(p, 'Codex Desktop');
      }
    } catch {}
  }
  const vscodeExtDir = path.join(HOME, '.vscode', 'extensions');
  if (fs.existsSync(vscodeExtDir)) {
    try {
      for (const entry of fs.readdirSync(vscodeExtDir)) {
        if (!entry.startsWith('openai.chatgpt-')) continue;
        const p = path.join(vscodeExtDir, entry, 'bin', 'windows-x86_64', 'codex.exe');
        if (fs.existsSync(p)) found.set(p, `VS Code (${entry.replace('openai.chatgpt-', '')})`);
      }
    } catch {}
  }
  const programsBin = path.join(LOCAL_APPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
  if (fs.existsSync(programsBin)) found.set(programsBin, 'Codex CLI');

  const list = [];
  for (const [p, source] of found) {
    try {
      const out = execFileSync(p, ['--version'], { encoding: 'utf8', timeout: 6000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const v = parseCodexVersion(out);
      if (v) list.push({ path: p, source, version: v.text, stable: !v.pre, _v: v });
    } catch {}
  }
  list.sort((a, b) => {
    if (a.stable !== b.stable) return a.stable ? -1 : 1;
    if (b._v.major !== a._v.major) return b._v.major - a._v.major;
    if (b._v.minor !== a._v.minor) return b._v.minor - a._v.minor;
    return b._v.patch - a._v.patch;
  });
  return list.map(({ _v, ...rest }) => rest);
}

export function getBestCodexBin() {
  const bins = discoverCodexBinaries();
  return bins[0]?.path || 'codex.exe';
}

export function findAgyBin() {
  const candidates = [
    path.join(HOME, '.gemini', 'bin', 'agy.exe'),
    path.join(LOCAL_APPDATA, 'Programs', 'Antigravity', 'bin', 'agy.cmd'),
    path.join(LOCAL_APPDATA, 'Programs', 'Antigravity', 'Antigravity.exe')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'agy';
}

// ---------------------------------------------------------------------------
// 2. Real-Time Quotas (Antigravity + Codex) & Auto-Pilot
// ---------------------------------------------------------------------------
let agyCache = { at: 0, value: null };
let codexCache = { at: 0, value: null };
let cachedAgyHubInfo = null;

async function discoverAgyHubProcess() {
  try {
    const cmd = `Get-CimInstance Win32_Process -Filter "Name='language_server_windows_x64.exe'" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (!out || !out.trim()) return null;
    const raw = JSON.parse(out);
    const procs = Array.isArray(raw) ? raw : [raw];
    for (const p of procs) {
      const cl = String(p.CommandLine || '');
      const tokM = cl.match(/--csrf_token[=\s]+"?([a-f0-9-]+)"?/i);
      const portM = cl.match(/--extension_server_port[=\s]+(\d+)/i) || cl.match(/--server_port[=\s]+(\d+)/i);
      if (tokM && p.ProcessId) {
        // Probe listening ports of this PID
        const pOut = execFileSync('powershell.exe', [
          '-NoProfile', '-Command',
          `(Get-NetTCPConnection -OwningProcess ${p.ProcessId} -State Listen -ErrorAction SilentlyContinue).LocalPort | ConvertTo-Json -Compress`
        ], { encoding: 'utf8', timeout: 4000, windowsHide: true });
        const portsRaw = pOut.trim() ? JSON.parse(pOut) : [];
        const ports = Array.isArray(portsRaw) ? portsRaw : [portsRaw];
        for (const port of ports) {
          if (!port) continue;
          try {
            const r = await fetch(`http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUserStatus`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': tokM[1] },
              body: JSON.stringify({ metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } }),
              signal: AbortSignal.timeout(2000)
            });
            if (r.ok) {
              cachedAgyHubInfo = { port, csrfToken: tokM[1] };
              return cachedAgyHubInfo;
            }
          } catch {}
        }
        if (portM) {
          cachedAgyHubInfo = { port: Number(portM[1]), csrfToken: tokM[1] };
          return cachedAgyHubInfo;
        }
      }
    }
  } catch {}
  return null;
}

export async function getAgyQuotaStatus(force = false) {
  if (!force && agyCache.value && Date.now() - agyCache.at < 20000) return agyCache.value;
  let value = { connected: false, models: [], pools: [], user: null };
  try {
    const hub = cachedAgyHubInfo || await discoverAgyHubProcess();
    if (hub) {
      const r = await fetch(`http://127.0.0.1:${hub.port}/exa.language_server_pb.LanguageServerService/GetUserStatus`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': hub.csrfToken },
        body: JSON.stringify({ metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } }),
        signal: AbortSignal.timeout(3000)
      });
      if (r.ok) {
        const data = await r.json();
        const us = data.userStatus || {};
        const models = (us.cascadeModelConfigData?.clientModelConfigs || [])
          .filter((m) => !m.disabled && !String(m.modelId || '').endsWith('-disabled'))
          .map((m) => {
            let remainingPct = 100;
            if (m.quotaInfo?.remainingFraction != null) {
              remainingPct = Math.round(m.quotaInfo.remainingFraction * 1000) / 10;
            } else if (m.quotaInfo?.resetTime && new Date(m.quotaInfo.resetTime).getTime() > Date.now()) {
              remainingPct = 0;
            }
            return {
              label: m.label,
              modelId: m.modelId,
              family: m.label.replace(/\s*\([^)]+\)\s*$/, '').trim(),
              remainingPct,
              resetTime: m.quotaInfo?.resetTime || null
            };
          });
        const pools = new Map();
        for (const m of models) {
          if (!pools.has(m.family)) pools.set(m.family, { family: m.family, remainingPct: m.remainingPct, resetTime: m.resetTime });
        }
        value = {
          connected: true,
          updatedAt: new Date().toISOString(),
          user: { name: us.name, email: us.email, tier: us.userTier?.name || us.planStatus?.planInfo?.planName || 'Pro' },
          models,
          pools: Array.from(pools.values())
        };
        try { fs.writeFileSync(path.join(PUBLIC_DIR, 'agy-live-quotas.json'), JSON.stringify(value, null, 2), 'utf8'); } catch {}
      } else {
        cachedAgyHubInfo = null;
      }
    }
  } catch {
    cachedAgyHubInfo = null;
  }
  if (!value.connected) {
    try {
      const snapFile = path.join(PUBLIC_DIR, 'agy-live-quotas.json');
      if (fs.existsSync(snapFile)) {
        const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
        if (snap && Array.isArray(snap.models) && snap.models.length) value = { ...snap, stale: true };
      }
    } catch {}
  }
  agyCache = { at: Date.now(), value };
  return value;
}

function readTail(filePath, maxBytes = 1024 * 1024) {
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const len = stat.size - start;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(filePath, 'r');
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  return buf.toString('utf8');
}

export function getCodexQuotaStatus(force = false) {
  if (!force && codexCache.value && Date.now() - codexCache.at < 10000) return codexCache.value;
  let rl = null;
  let lastUpdated = null;
  if (fs.existsSync(CODEX_DB_PATH)) {
    try {
      const db = new DatabaseSync(CODEX_DB_PATH, { open: true, readOnly: true, readBigInts: true });
      const rows = db.prepare('SELECT rollout_path FROM threads ORDER BY updated_at_ms DESC LIMIT 8').all();
      db.close();
      for (const r of rows) {
        const p = normalizeWinPath(r.rollout_path);
        if (!p || !fs.existsSync(p)) continue;
        const lines = readTail(p, 1500 * 1024).split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const o = JSON.parse(lines[i]);
            if (o.type === 'event_msg' && o.payload?.type === 'token_count' && o.payload?.rate_limits) {
              rl = o.payload.rate_limits;
              lastUpdated = o.timestamp;
              break;
            }
          } catch {}
        }
        if (rl) break;
      }
    } catch {}
  }
  const now = Date.now();
  const win = (w, fallbackMin) => {
    if (!w) return { usedPct: 0, remainingPct: 100, resetsAt: null, windowMinutes: fallbackMin, estimated: true };
    const resetsAtMs = w.resets_at ? w.resets_at * 1000 : null;
    const expired = !!resetsAtMs && resetsAtMs < now;
    const used = expired ? 0 : (w.used_percent ?? 0);
    return {
      usedPct: used,
      remainingPct: Math.max(0, 100 - used),
      resetsAt: resetsAtMs && !expired ? new Date(resetsAtMs).toISOString() : null,
      windowMinutes: w.window_minutes || fallbackMin,
      estimated: expired
    };
  };
  const value = {
    connected: true,
    binary: getBestCodexBin(),
    planType: rl?.plan_type || 'plus',
    fiveHourWindow: win(rl?.primary, 300),
    weeklyWindow: win(rl?.secondary, 10080),
    lastUpdated
  };
  codexCache = { at: Date.now(), value };
  return value;
}

export async function getAutoPilotRecommendation() {
  const [agy, codex] = await Promise.all([getAgyQuotaStatus(false), Promise.resolve(getCodexQuotaStatus(false))]);
  const cx5 = codex.fiveHourWindow?.remainingPct ?? 100;
  const cx7 = codex.weeklyWindow?.remainingPct ?? 100;
  const bestAgyPool = [...(agy.pools || [])].sort((a, b) => (b.remainingPct ?? 0) - (a.remainingPct ?? 0))[0] || null;
  let recommendedEngine = 'codex';
  let reason = `Codex has ${cx5}% (5h) and ${cx7}% (7d) quota remaining.`;
  if ((cx5 < 15 || cx7 < 10) && bestAgyPool && bestAgyPool.remainingPct > 20) {
    recommendedEngine = 'antigravity';
    reason = `Codex is low (${cx5}% 5h), while Antigravity (${bestAgyPool.family}) has ${bestAgyPool.remainingPct}% remaining.`;
  } else if (bestAgyPool && bestAgyPool.remainingPct >= 80 && cx5 < 60) {
    recommendedEngine = 'antigravity';
    reason = `Antigravity (${bestAgyPool.family}) is at ${bestAgyPool.remainingPct}% vs Codex at ${cx5}% (5h).`;
  }
  return { recommendedEngine, reason, agy, codex };
}

// ---------------------------------------------------------------------------
// 3. Native Conversation Discovery, Transcript Reader & Stalled-Task Radar
// ---------------------------------------------------------------------------
function parseAgyTranscript(convId, maxMsgs = 40) {
  const p = path.join(AGY_BRAIN_DIR, convId, '.system_generated', 'logs', 'transcript.jsonl');
  if (!fs.existsSync(p)) return [];
  const msgs = [];
  try {
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'USER_INPUT' && obj.content) {
          msgs.push({ role: 'user', content: String(obj.content), timestamp: obj.created_at || null });
        } else if (obj.type === 'PLANNER_RESPONSE' && obj.content) {
          msgs.push({ role: 'assistant', content: String(obj.content), timestamp: obj.created_at || null });
        }
      } catch {}
    }
  } catch {}
  return msgs.slice(-maxMsgs);
}

function parseCodexTranscript(rolloutPath, maxMsgs = 40) {
  if (!rolloutPath || !fs.existsSync(rolloutPath)) return [];
  const msgs = [];
  try {
    const raw = readTail(rolloutPath, 2 * 1024 * 1024);
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.type === 'response_item' && o.payload?.type === 'message') {
          const role = o.payload.role === 'user' ? 'user' : o.payload.role === 'assistant' ? 'assistant' : null;
          if (!role) continue;
          const parts = Array.isArray(o.payload.content) ? o.payload.content : [];
          const text = parts.map((c) => c?.text || '').filter(Boolean).join('\n').trim();
          if (text && !text.startsWith('<environment_context>') && !text.startsWith('# AGENTS.md')) {
            msgs.push({ role, content: text, timestamp: o.timestamp || null });
          }
        }
      } catch {}
    }
  } catch {}
  return msgs.slice(-maxMsgs);
}

export function listNativeConversations(limit = 60) {
  const items = [];

  // 1. Antigravity conversations
  if (fs.existsSync(AGY_DB_PATH)) {
    try {
      const db = new DatabaseSync(AGY_DB_PATH, { open: true, readOnly: true, readBigInts: true, timeout: 2000 });
      const rows = db.prepare(`
        SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris
        FROM conversation_summaries
        WHERE nesting_depth = 0 AND (title != '' OR preview != '')
        ORDER BY last_modified_time DESC
        LIMIT ?
      `).all(limit);
      db.close();
      for (const r of rows) {
        let wsPath = '';
        try {
          const uris = r.workspace_uris ? JSON.parse(r.workspace_uris) : [];
          if (Array.isArray(uris) && uris[0]) wsPath = normalizeWinPath(uris[0]) || '';
        } catch {}
        const updatedAt = r.last_modified_time ? new Date(String(r.last_modified_time).replace(' ', 'T')).toISOString() : new Date().toISOString();
        items.push({
          id: `agy-${r.conversation_id}`,
          nativeId: r.conversation_id,
          origin: 'antigravity',
          title: truncate(r.title || r.preview || 'Antigravity Session', 80),
          projectPath: wsPath,
          projectName: wsPath ? path.basename(wsPath) : 'Workspace',
          updatedAt,
          updatedMs: Date.parse(updatedAt) || 0,
          stepCount: Number(r.step_count || 0)
        });
      }
    } catch {}
  }

  // 2. Codex / VS Code conversations
  if (fs.existsSync(CODEX_DB_PATH)) {
    try {
      const db = new DatabaseSync(CODEX_DB_PATH, { open: true, readOnly: true, readBigInts: true, timeout: 2000 });
      const rows = db.prepare(`
        SELECT id, title, cwd, rollout_path, source, updated_at_ms
        FROM threads
        ORDER BY updated_at_ms DESC
        LIMIT ?
      `).all(limit);
      db.close();
      for (const r of rows) {
        const wsPath = normalizeWinPath(r.cwd) || '';
        const src = String(r.source || '').toLowerCase();
        const origin = src.includes('vscode') ? 'vscode' : 'codex';
        const updatedMs = Number(r.updated_at_ms || 0);
        items.push({
          id: `${origin}-${r.id}`,
          nativeId: r.id,
          origin,
          title: truncate(r.title || 'Codex Session', 80),
          projectPath: wsPath,
          projectName: wsPath ? path.basename(wsPath) : 'Workspace',
          rolloutPath: normalizeWinPath(r.rollout_path),
          updatedAt: updatedMs ? new Date(updatedMs).toISOString() : new Date().toISOString(),
          updatedMs
        });
      }
    } catch {}
  }

  items.sort((a, b) => b.updatedMs - a.updatedMs);
  return items.slice(0, limit);
}

export function readNativeTranscript(threadId, maxMsgs = 30) {
  const all = listNativeConversations(120);
  const item = all.find((x) => x.id === threadId || x.nativeId === threadId);
  if (item) {
    const messages = item.origin === 'antigravity'
      ? parseAgyTranscript(item.nativeId, maxMsgs)
      : parseCodexTranscript(item.rolloutPath, maxMsgs);
    return { ...item, messages };
  }
  // Fallback: direct Antigravity brain lookup by UUID for older conversations
  const rawId = String(threadId || '').replace(/^agy-/, '');
  if (rawId && fs.existsSync(path.join(AGY_BRAIN_DIR, rawId))) {
    const messages = parseAgyTranscript(rawId, maxMsgs);
    if (messages.length > 0) {
      return {
        id: `agy-${rawId}`,
        nativeId: rawId,
        origin: 'antigravity',
        title: `Antigravity Session (${rawId.slice(0, 8)})`,
        projectPath: '',
        projectName: 'Workspace',
        updatedAt: new Date().toISOString(),
        updatedMs: Date.now(),
        messages
      };
    }
  }
  return null;
}

export function buildStalledRadar() {
  const now = Date.now();
  const state = loadMuseState();
  const dismissed = state.dismissedStalled || {};
  const threads = listNativeConversations(45);
  const activeToday = [];
  const stalledTasks = [];
  const UNFINISHED_RE = /\b(next step|next steps|todo|to-do|remaining|unfinished|in progress|continue|shall i|would you like|let me know if|waiting for|interrupted|stopped by user|phase \d|step \d|pending)\b/i;

  for (const t of threads) {
    const ageHours = Math.max(0, (now - t.updatedMs) / 3600000);
    const msgs = t.origin === 'antigravity'
      ? parseAgyTranscript(t.nativeId, 8)
      : parseCodexTranscript(t.rolloutPath, 8);
    if (msgs.length === 0) continue;

    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const lastAsst = [...msgs].reverse().find((m) => m.role === 'assistant');
    const lastMsg = msgs[msgs.length - 1];

    const summary = {
      ...t,
      hoursIdle: Math.round(ageHours * 10) / 10,
      lastUserPrompt: lastUser ? truncate(lastUser.content, 140) : '',
      lastAssistantSummary: lastAsst ? truncate(lastAsst.content, 160) : ''
    };
    delete summary.rolloutPath;

    if (ageHours <= 48) activeToday.push(summary);

    const dis = dismissed[t.id];
    if (dis && dis >= t.updatedMs) continue;

    let checkpointTodo = '';
    if (t.projectPath) {
      try {
        const cp = path.join(t.projectPath, 'CHECKPOINT.md');
        if (fs.existsSync(cp)) {
          const m = fs.readFileSync(cp, 'utf8').match(/^[ \t]*[-*]\s+\[\s\]\s+(.+)$/m);
          if (m) checkpointTodo = truncate(m[1].trim(), 120);
        }
      } catch {}
    }

    const lastIsUser = lastMsg?.role === 'user';
    const hasUnfinishedSignal = Boolean(lastAsst && UNFINISHED_RE.test(lastAsst.content));
    if ((ageHours >= 1 && (lastIsUser || hasUnfinishedSignal || checkpointTodo)) || (ageHours >= 6 && msgs.length >= 2)) {
      let reason = summary.lastAssistantSummary || summary.lastUserPrompt;
      let severity = 'normal';
      if (lastIsUser) {
        reason = `Unanswered prompt: "${summary.lastUserPrompt}"`;
        severity = 'high';
      } else if (checkpointTodo) {
        reason = `Open CHECKPOINT.md item: ${checkpointTodo}`;
      } else if (hasUnfinishedSignal) {
        reason = `Paused mid-task: ${summary.lastAssistantSummary}`;
      }
      stalledTasks.push({ ...summary, reason, severity });
    }
  }

  return {
    totalScanned: threads.length,
    activeToday: activeToday.slice(0, 10),
    stalledTasks: stalledTasks.slice(0, 12)
  };
}

export function searchNativeConversations(query, limit = 10) {
  const raw = String(query || '').trim().toLowerCase();
  if (!raw) return [];
  const tokens = raw.replace(/[^a-z0-9_\-\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 2);
  const threads = listNativeConversations(80);
  if (tokens.length === 0) return threads.slice(0, limit);

  const scoredMap = new Map();

  // 1. Full-history Antigravity FTS5 search
  if (fs.existsSync(AGY_DB_PATH) && tokens.length > 0) {
    try {
      const db = new DatabaseSync(AGY_DB_PATH, { open: true, readOnly: true, readBigInts: true, timeout: 2000 });
      const ftsQuery = tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
      const ftsRows = db.prepare(`
        SELECT f.conversation_id, s.title, s.preview, s.last_modified_time, s.workspace_uris,
               f.user_body, f.agent_body
        FROM conversations_fts f
        LEFT JOIN conversation_summaries s ON s.conversation_id = f.conversation_id
        WHERE conversations_fts MATCH ?
        ORDER BY s.last_modified_time DESC
        LIMIT 30
      `).all(ftsQuery);
      db.close();

      for (const r of ftsRows) {
        const id = `agy-${r.conversation_id}`;
        const combined = `${r.title || ''} ${r.user_body || ''} ${r.agent_body || ''}`;
        const low = combined.toLowerCase();
        let score = 0;
        for (const tok of tokens) {
          if (String(r.title || '').toLowerCase().includes(tok)) score += 12;
          if (low.includes(tok)) score += 4;
        }
        const firstTok = tokens.find((tk) => low.includes(tk));
        const idx = firstTok ? low.indexOf(firstTok) : 0;
        const start = Math.max(0, idx - 40);
        const snippet = (start > 0 ? '…' : '') + truncate(combined.slice(start), 160);
        let wsPath = '';
        try {
          const uris = r.workspace_uris ? JSON.parse(r.workspace_uris) : [];
          if (Array.isArray(uris) && uris[0]) wsPath = normalizeWinPath(uris[0]) || '';
        } catch {}
        const updatedAt = r.last_modified_time ? new Date(String(r.last_modified_time).replace(' ', 'T')).toISOString() : new Date().toISOString();
        const prev = scoredMap.get(id);
        if (!prev || score > prev.score) {
          scoredMap.set(id, {
            id,
            nativeId: r.conversation_id,
            origin: 'antigravity',
            title: truncate(r.title || r.preview || 'Antigravity Session', 80),
            projectPath: wsPath,
            projectName: wsPath ? path.basename(wsPath) : 'Workspace',
            updatedAt,
            updatedMs: Date.parse(updatedAt) || 0,
            score,
            snippet
          });
        }
      }
    } catch {}
  }

  // 2. Recent transcripts across Antigravity, Codex, and VS Code
  for (const t of threads) {
    let score = 0;
    let snippet = '';
    const hay = `${t.title} ${t.projectName} ${t.projectPath}`.toLowerCase();
    for (const tok of tokens) {
      if (hay.includes(tok)) score += 10;
    }
    const msgs = t.origin === 'antigravity'
      ? parseAgyTranscript(t.nativeId, 18)
      : parseCodexTranscript(t.rolloutPath, 18);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const c = String(msgs[i].content || '');
      const cLow = c.toLowerCase();
      let hits = 0;
      for (const tok of tokens) if (cLow.includes(tok)) hits++;
      if (hits > 0) {
        score += hits * 3;
        if (!snippet) {
          const first = tokens.find((tk) => cLow.includes(tk));
          const idx = first ? cLow.indexOf(first) : 0;
          const start = Math.max(0, idx - 40);
          snippet = (start > 0 ? '…' : '') + truncate(c.slice(start), 150);
        }
      }
    }
    if (score > 0) {
      const { rolloutPath: _rp, ...clean } = t;
      const prev = scoredMap.get(t.id);
      if (!prev || score > prev.score) {
        scoredMap.set(t.id, { ...clean, score, snippet: snippet || prev?.snippet || '' });
      }
    }
  }
  const scored = Array.from(scoredMap.values());
  scored.sort((a, b) => b.score - a.score || b.updatedMs - a.updatedMs);
  return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// 4. Muse Reminders & Calendar Sync
// ---------------------------------------------------------------------------
export function loadMuseState() {
  try {
    if (fs.existsSync(MUSE_STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(MUSE_STATE_FILE, 'utf8'));
      return {
        reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
        calendarSources: {
          icsUrls: Array.isArray(parsed.calendarSources?.icsUrls) ? parsed.calendarSources.icsUrls : [],
          syncWindowsOutlook: parsed.calendarSources?.syncWindowsOutlook !== false
        },
        cachedCalendarEvents: Array.isArray(parsed.cachedCalendarEvents) ? parsed.cachedCalendarEvents : [],
        dismissedStalled: parsed.dismissedStalled && typeof parsed.dismissedStalled === 'object' ? parsed.dismissedStalled : {}
      };
    }
  } catch {}
  return {
    reminders: [],
    calendarSources: { icsUrls: [], syncWindowsOutlook: true },
    cachedCalendarEvents: [],
    dismissedStalled: {}
  };
}

export function saveMuseState(nextState) {
  try {
    let existing = {};
    if (fs.existsSync(MUSE_STATE_FILE)) {
      existing = JSON.parse(fs.readFileSync(MUSE_STATE_FILE, 'utf8'));
    }
    fs.writeFileSync(MUSE_STATE_FILE, JSON.stringify({ ...existing, ...nextState }, null, 2), 'utf8');
  } catch {}
}

function parseIcsDate(rawVal) {
  const val = String(rawVal || '').trim();
  const m = val.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, hh = '09', mm = '00', ss = '00', z] = m;
  if (z === 'Z') return new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss)).toISOString();
  return new Date(+y, +mo - 1, +d, +hh, +mm, +ss).toISOString();
}

function parseIcsEvents(icsText, sourceLabel) {
  const unfolded = String(icsText || '').replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const events = [];
  const blocks = unfolded.split(/BEGIN:VEVENT/i).slice(1);
  for (const blk of blocks) {
    const endIdx = blk.search(/END:VEVENT/i);
    const body = endIdx >= 0 ? blk.slice(0, endIdx) : blk;
    const getProp = (name) => {
      const m = body.match(new RegExp(`^${name}(?:;[^:]*)?:(.*)$`, 'im'));
      return m ? m[1].trim() : '';
    };
    const title = getProp('SUMMARY').replace(/\\,/g, ',').replace(/\\n/g, ' ');
    const startAt = parseIcsDate(getProp('DTSTART'));
    if (!title || !startAt) continue;
    const endAt = parseIcsDate(getProp('DTEND')) || startAt;
    const startMs = Date.parse(startAt) || 0;
    const endMs = Date.parse(endAt) || startMs;
    events.push({
      id: getProp('UID') || `${sourceLabel}-${startAt}-${title.slice(0, 20)}`,
      summary: title,
      startAt,
      endAt,
      startMs,
      endMs,
      location: getProp('LOCATION').replace(/\\,/g, ','),
      source: sourceLabel
    });
  }
  return events;
}

let lastCalSyncAt = 0;
export async function syncHubCalendars(force = false) {
  const state = loadMuseState();
  if (!force && Date.now() - lastCalSyncAt < 5 * 60 * 1000 && state.cachedCalendarEvents.length > 0) {
    return state.cachedCalendarEvents;
  }
  lastCalSyncAt = Date.now();
  const events = [];
  for (const url of state.calendarSources?.icsUrls || []) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
      if (res.ok) events.push(...parseIcsEvents(await res.text(), 'Calendar Feed'));
    } catch {}
  }
  try {
    for (const f of fs.readdirSync(MUSE_CAL_DIR)) {
      if (f.toLowerCase().endsWith('.ics')) {
        events.push(...parseIcsEvents(fs.readFileSync(path.join(MUSE_CAL_DIR, f), 'utf8'), f));
      }
    }
  } catch {}
  saveMuseState({ cachedCalendarEvents: events.slice(0, 120) });
  return events;
}

// ---------------------------------------------------------------------------
// 5. Multi-Account Model Allowances & Smart Routing (OpenMausBot + Antigravity)
// ---------------------------------------------------------------------------
function formatResetInfo(isoStr) {
  if (!isoStr) return { resetsAt: null, resetsInHuman: null, resetsAtEastern: null, hoursUntilReset: null };
  const ms = Date.parse(isoStr);
  if (!Number.isFinite(ms)) return { resetsAt: isoStr, resetsInHuman: null, resetsAtEastern: null, hoursUntilReset: null };
  const diffMs = ms - Date.now();
  const hoursUntilReset = Math.max(0, +(diffMs / 3600000).toFixed(2));
  let resetsInHuman = 'now';
  if (diffMs > 0) {
    const totalMins = Math.round(diffMs / 60000);
    const days = Math.floor(totalMins / 1440);
    const hrs = Math.floor((totalMins % 1440) / 60);
    const mins = totalMins % 60;
    if (days > 0) resetsInHuman = `${days}d ${hrs}h`;
    else if (hrs > 0) resetsInHuman = `${hrs}h ${mins}m`;
    else resetsInHuman = `${Math.max(1, mins)}m`;
  }
  let resetsAtEastern = null;
  try {
    resetsAtEastern = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).format(new Date(ms)) + ' ET';
  } catch {
    resetsAtEastern = new Date(ms).toLocaleString();
  }
  return { resetsAt: new Date(ms).toISOString(), resetsInHuman, resetsAtEastern, hoursUntilReset };
}

function normWindow(win, fallbackLabel) {
  if (!win) return null;
  const rem = typeof win.remainingPercent === 'number'
    ? +win.remainingPercent.toFixed(1)
    : typeof win.remainingPct === 'number'
      ? +win.remainingPct.toFixed(1)
      : null;
  const used = typeof win.usedPercent === 'number'
    ? +win.usedPercent.toFixed(1)
    : rem !== null ? +(100 - rem).toFixed(1) : null;
  if (rem === null && !win.available) return null;
  return {
    label: win.label || fallbackLabel,
    remainingPercent: rem,
    usedPercent: used,
    ...formatResetInfo(win.resetsAt || win.resetTime || null)
  };
}

const ALLOWANCES_CACHE_FILE = path.join(DATA_DIR, 'allowances-cache.json');
const ALLOWANCES_TTL_MS = 45_000;
const AGY_IDE_MAX_AGE_MS = 2 * 3600 * 1000;
let allowancesMemCache = { at: 0, value: null };
let inFlightAllowances = null;

function readAllowancesDiskCache() {
  try {
    if (!fs.existsSync(ALLOWANCES_CACHE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(ALLOWANCES_CACHE_FILE, 'utf8'));
    return Array.isArray(data?.accounts) && data.accounts.length > 0 ? data : null;
  } catch {
    return null;
  }
}

function writeAllowancesDiskCache(data) {
  try {
    if (!Array.isArray(data?.accounts) || data.accounts.length === 0) return;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ALLOWANCES_CACHE_FILE, JSON.stringify(data), 'utf8');
  } catch {}
}

export async function getUnifiedAccountAllowances({ ombBaseUrl = 'http://127.0.0.1:8799', refresh = false, authHeaders = {} } = {}) {
  if (!refresh && allowancesMemCache.value && (Date.now() - allowancesMemCache.at) < ALLOWANCES_TTL_MS) {
    return allowancesMemCache.value;
  }
  if (!refresh && inFlightAllowances) {
    return inFlightAllowances;
  }

  const runPromise = (async () => {
    const fetchJson = async (url, timeoutMs = 12000) => {
      try {
        const res = await fetch(url, { headers: authHeaders, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    };

    const [planUsage, instancesData, botsData, autoPilot] = await Promise.all([
      fetchJson(`${ombBaseUrl}/api/plan-usage${refresh ? '?refresh=1' : ''}`, refresh ? 24000 : 18000),
      fetchJson(`${ombBaseUrl}/api/instances`, 8000),
      fetchJson(`${ombBaseUrl}/api/bots`, 8000),
      getAutoPilotRecommendation().catch(() => null)
    ]);

    const instancesById = new Map();
    for (const inst of instancesData?.instances || []) {
      instancesById.set(inst.instanceId, inst);
    }

    const botsByInstance = new Map();
    for (const b of botsData?.bots || []) {
      const iid = b.modelSelection?.instanceId || 'codex';
      if (!botsByInstance.has(iid)) botsByInstance.set(iid, []);
      botsByInstance.get(iid).push({
        id: b.id,
        name: b.name,
        model: b.modelSelection?.model || null
      });
    }

    const agyIdeEmail = String(autoPilot?.agy?.user?.email || '').toLowerCase();
    const agyIdePools = Array.isArray(autoPilot?.agy?.pools) ? autoPilot.agy.pools : [];
    const agyUpdatedMs = autoPilot?.agy?.updatedAt ? Date.parse(autoPilot.agy.updatedAt) : NaN;
    const agyIdeFresh = Number.isFinite(agyUpdatedMs) && (Date.now() - agyUpdatedMs) <= AGY_IDE_MAX_AGE_MS;

    const providers = Array.isArray(planUsage?.providers) ? planUsage.providers : [];
    const accounts = [];
    const disconnected = [];

    for (const p of providers) {
      const inst = instancesById.get(p.id);
      const email = inst?.snapshot?.account?.email || (p.id === 'antigravity' ? 'mina.khoshbazmf@gmail.com' : p.driver === 'codex' ? 'OpenAI / ChatGPT Plus' : null);
      const displayName = inst?.displayName || p.name || p.id;
      const authenticated = p.ok === true || inst?.snapshot?.authenticated === true;
      const assignedBots = botsByInstance.get(p.id) || [];

      const fiveHour = normWindow(p.fiveHour, '5-hour');
      const weekly = normWindow(p.weekly, 'Weekly');

      const availOpts = (inst?.models?.options || []).map((o) => ({ id: o.id, label: o.label }));
      const availLabels = availOpts.map((o) => o.label);
      const geminiBucketModels = availLabels.filter((l) => (/gemini/i.test(l) && !/argon/i.test(l)) || /orchestrator \(neon\)/i.test(l));
      const argonBucketModels = availLabels.filter((l) => /argon|orchestrator \(argon\)/i.test(l));
      const claudeBucketModels = availLabels.filter((l) => /claude|gpt-oss/i.test(l));
      const hasGemini4 = availLabels.some((l) => /gemini 4|orchestrator/i.test(l));

      if (fiveHour && p.driver === 'antigravity' && geminiBucketModels.length > 0) {
        fiveHour.modelsIncluded = geminiBucketModels;
      }
      if (weekly && p.driver === 'antigravity' && geminiBucketModels.length > 0) {
        weekly.modelsIncluded = geminiBucketModels;
      }

      const models = [];
      for (const m of p.models || []) {
        const wins = (m.windows || []).map((w) => normWindow(w, w.label || 'Window')).filter(Boolean);
        if (wins.length > 0) {
          const isClaudeGroup = /claude|gpt/i.test(m.name);
          models.push({
            name: m.name,
            modelsIncluded: isClaudeGroup && claudeBucketModels.length > 0 ? claudeBucketModels : (/argon/i.test(m.name) ? (argonBucketModels.length > 0 ? argonBucketModels : ['Gemini 4 Argon']) : null),
            windows: wins
          });
        }
      }

      // Attach live Antigravity IDE per-family pools only to matching Antigravity account when fresh
      if (p.driver === 'antigravity' && agyIdeFresh && email && agyIdeEmail && email.toLowerCase() === agyIdeEmail && agyIdePools.length > 0) {
        for (const pool of agyIdePools) {
          const already = models.some((m) => m.name.toLowerCase() === String(pool.family || '').toLowerCase());
          if (!already) {
            models.push({
              name: `${pool.family} (IDE Pool)`,
              windows: [normWindow({ label: '5-hour / Pool', remainingPct: pool.remainingPct, resetTime: pool.resetTime }, 'Pool')].filter(Boolean)
            });
          }
        }
      }

      // Compute smart routing priority score for this account
      const hasKnownQuota = Boolean(fiveHour || weekly);
      const effWeekly = hasKnownQuota ? (weekly?.remainingPercent ?? fiveHour.remainingPercent) : null;
      const effFive = hasKnownQuota ? (fiveHour?.remainingPercent ?? weekly.remainingPercent) : null;
      const effectiveMin = hasKnownQuota ? Math.min(effWeekly, effFive) : null;

      // Bonus for expiring soon when plenty is left ("burn before reset" optimization)
      const weeklyHours = weekly?.hoursUntilReset;
      const soonResetBonus = (hasKnownQuota && effWeekly >= 45 && typeof weeklyHours === 'number' && weeklyHours > 0 && weeklyHours <= 96)
        ? Math.round((96 - weeklyHours) / 4)
        : 0;
      const proBonus = (p.driver === 'antigravity' && hasGemini4) ? 5 : 0;
      const routingScore = !authenticated
        ? -1
        : (!hasKnownQuota ? 50 : Math.round(effWeekly * 0.65 + effFive * 0.35 + soonResetBonus + proBonus));

      let statusTag = 'ready';
      let statusLabel = 'Plenty Left';
      if (!authenticated) {
        statusTag = 'disconnected';
        statusLabel = p.error || 'Not Signed In';
      } else if (!hasKnownQuota) {
        statusTag = 'unknown';
        statusLabel = 'Quota Unknown';
      } else if (effectiveMin <= 15) {
        statusTag = 'critical';
        statusLabel = 'Nearly Exhausted';
      } else if (effWeekly <= 30) {
        statusTag = 'conserve';
        statusLabel = 'Low Weekly — Conserve';
      } else if (soonResetBonus >= 8) {
        statusTag = 'use-soon';
        statusLabel = 'Use Before Reset';
      }

      const entry = {
        instanceId: p.id,
        displayName,
        driver: p.driver,
        email,
        plan: p.plan || (p.driver === 'antigravity' ? (hasGemini4 ? 'Google AI Pro' : 'Free Tier') : null),
        authenticated,
        error: p.error || null,
        hasGemini4: p.driver === 'antigravity' ? hasGemini4 : false,
        geminiSharedModels: p.driver === 'antigravity' ? geminiBucketModels : [],
        fiveHour,
        weekly,
        models,
        availableModels: availOpts,
        assignedBots,
        routingScore,
        statusTag,
        statusLabel
      };

      if (authenticated) accounts.push(entry);
      else disconnected.push(entry);
    }

    if (providers.length === 0) {
      const cached = allowancesMemCache.value || readAllowancesDiskCache();
      if (cached && Array.isArray(cached.accounts) && cached.accounts.length > 0) {
        return {
          ...cached,
          stale: true,
          staleReason: 'Live plan-usage unavailable or timed out; serving last known allowances.'
        };
      }
    }

    // Sort active accounts by routingScore descending (best choice first)
    accounts.sort((a, b) => b.routingScore - a.routingScore);

    const bestOverall = accounts[0] || null;
    const bestGemini = accounts.find((a) => a.driver === 'antigravity') || null;
    const bestCodex = accounts.find((a) => a.driver === 'codex') || null;

    // Find best account for Claude/GPT shared pool on Antigravity
    let bestClaudePool = null;
    for (const a of accounts.filter((x) => x.driver === 'antigravity')) {
      const claudeModel = a.models.find((m) => /claude/i.test(m.name));
      const rem = claudeModel?.windows?.[0]?.remainingPercent ?? null;
      if (rem !== null && (!bestClaudePool || rem > bestClaudePool.remainingPercent)) {
        bestClaudePool = {
          instanceId: a.instanceId,
          displayName: a.displayName,
          email: a.email,
          modelPool: claudeModel.name,
          remainingPercent: rem,
          resetsAtEastern: claudeModel.windows[0].resetsAtEastern,
          resetsInHuman: claudeModel.windows[0].resetsInHuman
        };
      }
    }

    const conserveWarnings = accounts
      .filter((a) => a.statusTag === 'conserve' || a.statusTag === 'critical')
      .map((a) => {
        const parts = [];
        if (a.weekly && a.weekly.remainingPercent <= 30) {
          parts.push(`Weekly ${a.weekly.remainingPercent}% left (resets ${a.weekly.resetsInHuman ? `in ${a.weekly.resetsInHuman} · ` : ''}${a.weekly.resetsAtEastern || 'unknown'})`);
        }
        if (a.fiveHour && a.fiveHour.remainingPercent <= 20) {
          parts.push(`5-hour ${a.fiveHour.remainingPercent}% left (resets ${a.fiveHour.resetsInHuman ? `in ${a.fiveHour.resetsInHuman} · ` : ''}${a.fiveHour.resetsAtEastern || 'unknown'})`);
        }
        return `${a.displayName}${a.email ? ` (${a.email})` : ''}: ${parts.join(', ')}`;
      });

    const bestKnown = accounts.find((a) => a.statusTag !== 'unknown') || bestOverall;
    const summaryParts = [];
    if (bestKnown) {
      const bestPct = bestKnown.weekly?.remainingPercent ?? bestKnown.fiveHour?.remainingPercent ?? null;
      const pctText = bestPct !== null ? `${bestPct}% left` : 'quota unknown';
      summaryParts.push(
        `Best right now: ${bestKnown.displayName}${bestKnown.email ? ` (${bestKnown.email})` : ''} (${pctText}${bestKnown.weekly?.resetsInHuman ? `, resets in ${bestKnown.weekly.resetsInHuman}` : ''}).`
      );
    }
    if (conserveWarnings.length > 0) {
      summaryParts.push(`Conserve: ${conserveWarnings.join(' | ')}.`);
    }

    const result = {
      ok: true,
      fetchedAt: planUsage?.fetchedAt || new Date().toISOString(),
      accounts,
      disconnected,
      routingAdvice: {
        summary: summaryParts.join(' '),
        bestOverall: bestOverall ? { instanceId: bestOverall.instanceId, displayName: bestOverall.displayName, email: bestOverall.email, statusLabel: bestOverall.statusLabel } : null,
        bestGemini: bestGemini ? { instanceId: bestGemini.instanceId, displayName: bestGemini.displayName, email: bestGemini.email, weeklyRemaining: bestGemini.weekly?.remainingPercent ?? null, resetsInHuman: bestGemini.weekly?.resetsInHuman ?? null } : null,
        bestClaudePool,
        bestCodex: bestCodex ? { instanceId: bestCodex.instanceId, displayName: bestCodex.displayName, fiveHourRemaining: bestCodex.fiveHour?.remainingPercent ?? null, weeklyRemaining: bestCodex.weekly?.remainingPercent ?? null, weeklyResetsIn: bestCodex.weekly?.resetsInHuman ?? null } : null,
        conserveWarnings
      }
    };

    if (result.accounts.length > 0) {
      allowancesMemCache = { at: Date.now(), value: result };
      writeAllowancesDiskCache(result);
    }
    return result;
  })();

  if (!refresh) {
    inFlightAllowances = runPromise;
  }
  try {
    return await runPromise;
  } finally {
    if (inFlightAllowances === runPromise) {
      inFlightAllowances = null;
    }
  }
}
