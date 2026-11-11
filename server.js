/**
 * AI Studio Hub — local bridge between Google Antigravity (agy) and OpenAI Codex.
 *
 * - Imports existing Antigravity, Codex Desktop and VS Code (Codex) chats and projects.
 * - Shows live quota for both engines and switches engines when credits run low.
 * - Continues any chat on either engine, handing off conversation, recent actions and git changes.
 *
 * Security: binds to 127.0.0.1 only, rejects foreign Host/Origin headers and requires a
 * per-launch token (embedded in index.html) on every /api request.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------------------
// 0. Constants, Data Location & Security Token
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 4747;
const HOME = os.homedir();
const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
// Hub data lives outside Google Drive so chat transcripts are not synced to the cloud.
const DATA_DIR = path.join(LOCAL_APPDATA, 'AIStudioHub');
const ATTACH_DIR = path.join(DATA_DIR, 'attachments');
const CONTEXT_DIR = path.join(DATA_DIR, 'context');
const STATE_FILE = path.join(DATA_DIR, 'hub_state.json');
const LEGACY_DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_PROJECT_PATH = path.join(HOME, 'My Drive');
const MAX_PROMPT_CHARS = 24000; // Windows command lines are capped at ~32k characters.
const AGY_DB_PATH = path.join(HOME, '.gemini', 'antigravity', 'conversation_summaries.db');
const CODEX_DB_PATH = path.join(HOME, '.codex', 'state_5.sqlite');

// Persistent secret stored in local AppData so server restarts never break an open browser tab.
const TOKEN_FILE = path.join(DATA_DIR, 'hub_token.txt');
for (const d of [DATA_DIR, ATTACH_DIR, CONTEXT_DIR]) fs.mkdirSync(d, { recursive: true });
let HUB_TOKEN;
try {
  if (fs.existsSync(TOKEN_FILE)) {
    HUB_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  }
} catch {}
if (!HUB_TOKEN || HUB_TOKEN.length < 32) {
  HUB_TOKEN = crypto.randomBytes(24).toString('hex');
  try {
    fs.writeFileSync(TOKEN_FILE, HUB_TOKEN, 'utf8');
  } catch {}
}
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, 'ai-studio-hub.mojtaba-safdari-mm.workers.dev', 'parlez-french.mojtaba-safdari-mm.workers.dev']);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, 'https://ai-studio-hub.mojtaba-safdari-mm.workers.dev', 'https://parlez-french.mojtaba-safdari-mm.workers.dev']);

// ---------------------------------------------------------------------------
// 1. Small Helpers
// ---------------------------------------------------------------------------
function truncate(text, max) {
  const s = String(text || '');
  return s.length > max ? s.slice(0, max) + '\n…[truncated]…' : s;
}

function safeFileName(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function existsDir(p) {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function normalizeWinPath(rawPath) {
  if (!rawPath) return null;
  let p = String(rawPath).trim();
  // Strip \\?\ prefix used by Codex for extended-length paths.
  if (p.startsWith('\\\\?\\')) p = p.slice(4);
  // Decode file:/// URIs from Antigravity and VS Code.
  if (p.startsWith('file:///')) {
    try {
      p = decodeURIComponent(p.replace(/^file:\/\/\//, '')).replace(/\//g, '\\');
    } catch {}
  }
  try {
    return path.resolve(p);
  } catch {
    return p;
  }
}

function projectIdForPath(cleanPath) {
  const key = (cleanPath || HOME).toLowerCase();
  return crypto.createHash('md5').update(key).digest('hex').slice(0, 10);
}

function isInside(child, parent) {
  if (!child || !parent) return false;
  const c = child.toLowerCase();
  const p = parent.toLowerCase().replace(/\\+$/, '');
  return c === p || c.startsWith(p + '\\');
}

function readTail(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function runPowerShell(script, { timeoutMs = 5000, sta = false } = {}) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const args = ['-NoProfile', '-NonInteractive'];
    if (sta) args.push('-Sta');
    args.push('-EncodedCommand', encoded);
    execFile('powershell.exe', args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout || '').trim());
    });
  });
}

// ---------------------------------------------------------------------------
// 2. Discover CLI Binaries (Antigravity & newest *stable* Codex)
// ---------------------------------------------------------------------------
function findAgyBinary() {
  const candidates = [
    path.join(LOCAL_APPDATA, 'agy', 'bin', 'agy.exe'),
    path.join(HOME, '.gemini', 'bin', 'agy.exe')
  ];
  const found = candidates.find((c) => fs.existsSync(c));
  if (found) return found;
  // Antigravity self-updates by renaming agy.exe -> agy.exe.<stamp>.old; copy newest to agy.exe
  for (const dir of [path.join(HOME, '.gemini', 'bin'), path.join(LOCAL_APPDATA, 'agy', 'bin')]) {
    try {
      const olds = fs.readdirSync(dir)
        .filter((n) => /^agy\.exe(\..+)?$/i.test(n))
        .map((n) => path.join(dir, n))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (olds.length) {
        const target = path.join(dir, 'agy.exe');
        try { fs.copyFileSync(olds[0], target); return target; } catch {}
        return olds[0];
      }
    } catch {}
  }
  return 'agy.exe';
}

function parseCodexVersion(out) {
  const m = String(out).match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null, text: m[0] };
}

function compareVersions(a, b) {
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return a[k] - b[k];
  }
  if (!a.pre && b.pre) return 1;
  if (a.pre && !b.pre) return -1;
  return 0;
}

function discoverCodexBinaries() {
  const found = new Map(); // path -> source label

  const vscodeExtDir = path.join(HOME, '.vscode', 'extensions');
  if (existsDir(vscodeExtDir)) {
    for (const entry of fs.readdirSync(vscodeExtDir)) {
      if (!entry.startsWith('openai.chatgpt-')) continue;
      const p = path.join(vscodeExtDir, entry, 'bin', 'windows-x86_64', 'codex.exe');
      if (fs.existsSync(p)) found.set(p, `VS Code extension (${entry.replace('openai.chatgpt-', '')})`);
    }
  }

  const desktopBinDir = path.join(LOCAL_APPDATA, 'OpenAI', 'Codex', 'bin');
  if (existsDir(desktopBinDir)) {
    for (const entry of fs.readdirSync(desktopBinDir)) {
      const p = path.join(desktopBinDir, entry, 'codex.exe');
      if (fs.existsSync(p)) found.set(p, 'Codex Desktop');
    }
  }

  const programsBin = path.join(LOCAL_APPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
  if (fs.existsSync(programsBin)) found.set(programsBin, 'Codex CLI (PATH)');

  const list = [];
  for (const [p, source] of found) {
    try {
      const out = execFileSync(p, ['--version'], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const v = parseCodexVersion(out);
      if (v) list.push({ path: p, source, version: v.text, stable: !v.pre, _v: v });
    } catch {}
  }

  // Prefer stable builds, then the highest version.
  list.sort((a, b) => (a.stable !== b.stable ? (a.stable ? -1 : 1) : compareVersions(b._v, a._v)));
  return list.map(({ _v, ...rest }) => rest);
}

const AGY_BIN = findAgyBinary();
const CODEX_BINARIES = discoverCodexBinaries();

function getCodexBin() {
  const chosen = appState && appState.settings && appState.settings.codexBinary;
  if (chosen && CODEX_BINARIES.some((b) => b.path === chosen) && fs.existsSync(chosen)) return chosen;
  return CODEX_BINARIES[0] ? CODEX_BINARIES[0].path : 'codex.exe';
}

// ---------------------------------------------------------------------------
// 3. Detect Chats That Are Open in Another App (lock files held by the native app)
// ---------------------------------------------------------------------------
function isLockHeld(lockPath) {
  if (!fs.existsSync(lockPath)) return false;
  let fd;
  try {
    fd = fs.openSync(lockPath, 'r');
    fs.readSync(fd, Buffer.alloc(1), 0, 1, 0);
    return false;
  } catch (e) {
    return e.code === 'EBUSY' || e.code === 'EPERM';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function isAgyConversationOpen(id) {
  return !!id && isLockHeld(path.join(HOME, '.gemini', 'antigravity', 'presence', `${id}.lock`));
}

function isCodexSessionOpen(id) {
  return !!id && isLockHeld(path.join(HOME, '.codex', 'thread-writer-locks', `${id}.lock`));
}

// ---------------------------------------------------------------------------
// 4. Discover All Existing Projects & Chats (Antigravity + Codex Desktop + VS Code)
// ---------------------------------------------------------------------------
const TEST_PROMPT_RE = /^Reply with the single word [A-Z]+$/;

function discoverAllProjectsAndChats(existingState) {
  const projectMap = new Map(); // lowerPath -> project
  const threadMap = new Map(); // threadId -> thread
  const hidden = new Set(existingState?.hiddenThreadIds || []);

  // Sessions created by the hub itself belong to hub threads; never import them twice.
  const hubOwnedSessions = new Set();
  for (const t of existingState?.threads || []) {
    for (const id of t.hubSessionIds || []) hubOwnedSessions.add(id);
  }

  const registerProject = (rawPath, preferredName, sourceTag) => {
    const clean = normalizeWinPath(rawPath);
    if (!clean) return null;
    const key = clean.toLowerCase();
    if (key.includes('windows\\system32') || key.includes('.codex\\sessions')) return null;

    if (!projectMap.has(key)) {
      projectMap.set(key, {
        id: projectIdForPath(clean),
        name: preferredName || path.basename(clean) || clean,
        path: clean,
        exists: existsDir(clean),
        sources: sourceTag ? [sourceTag] : [],
        createdAt: new Date().toISOString()
      });
    } else if (sourceTag) {
      const proj = projectMap.get(key);
      if (!proj.sources.includes(sourceTag)) proj.sources.push(sourceTag);
    }
    return projectMap.get(key);
  };

  const fallbackProject = (p) => ({ id: projectIdForPath(p), name: path.basename(p) || p, path: p });

  // Seed projects saved by the hub (including folders the user added manually).
  for (const p of existingState?.projects || []) {
    const sources = p.sources && p.sources.length ? p.sources : [null];
    for (const s of sources) registerProject(p.path, p.name, s);
  }
  registerProject(DEFAULT_PROJECT_PATH, 'My Drive', 'AGY');

  // A. Antigravity projects (~/.gemini/projects.json)
  const geminiProjectsPath = path.join(HOME, '.gemini', 'projects.json');
  if (fs.existsSync(geminiProjectsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(geminiProjectsPath, 'utf8'));
      for (const [p, name] of Object.entries(data?.projects || {})) registerProject(p, name, 'AGY');
    } catch {}
  }

  // B. VS Code workspaces (%APPDATA%\Code\User\globalStorage\storage.json)
  const vscStoragePath = path.join(
    process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'),
    'Code',
    'User',
    'globalStorage',
    'storage.json'
  );
  if (fs.existsSync(vscStoragePath)) {
    try {
      const vs = JSON.parse(fs.readFileSync(vscStoragePath, 'utf8'));
      for (const uri of Object.keys(vs.profileAssociations?.workspaces || {})) registerProject(uri, null, 'VS Code');
      for (const f of vs.backupWorkspaces?.folders || []) {
        if (f.folderUri) registerProject(f.folderUri, null, 'VS Code');
      }
    } catch {}
  }

  // C. Codex trusted projects (~/.codex/config.toml)
  const codexConfigPath = path.join(HOME, '.codex', 'config.toml');
  if (fs.existsSync(codexConfigPath)) {
    try {
      const raw = fs.readFileSync(codexConfigPath, 'utf8');
      const regex = /\[projects\.'([^']+)'\]/g;
      let match;
      while ((match = regex.exec(raw)) !== null) registerProject(match[1], null, 'Codex');
    } catch {}
  }

  // Keep hub threads (and imported threads that already have hub turns) as they are.
  for (const t of existingState?.threads || []) threadMap.set(t.id, t);

  // D. Antigravity conversations (root conversations only; subagents are skipped)
  if (fs.existsSync(AGY_DB_PATH)) {
    let db;
    try {
      db = new DatabaseSync(AGY_DB_PATH, { open: true, readOnly: true, readBigInts: true, timeout: 2500 });
      const rows = db
        .prepare(
          `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris
           FROM conversation_summaries
           WHERE nesting_depth = 0
           ORDER BY last_modified_time DESC`
        )
        .all();
      db.close();
      db = null;

      for (const r of rows) {
        const convId = r.conversation_id;
        const label = String(r.title || r.preview || '').trim();
        if (!convId || TEST_PROMPT_RE.test(label) || hubOwnedSessions.has(convId)) continue;

        let wsPath = DEFAULT_PROJECT_PATH;
        try {
          const uris = r.workspace_uris ? JSON.parse(r.workspace_uris) : [];
          if (Array.isArray(uris) && uris.length > 0) wsPath = normalizeWinPath(uris[0]) || wsPath;
        } catch {}

        const proj = registerProject(wsPath, null, 'AGY') || fallbackProject(wsPath);
        const hubThreadId = `agy-${convId}`;
        const isoTime = r.last_modified_time
          ? new Date(String(r.last_modified_time).replace(' ', 'T')).toISOString()
          : new Date().toISOString();

        let t = threadMap.get(hubThreadId);
        if (!t) {
          t = {
            id: hubThreadId,
            origin: 'antigravity',
            originatorLabel: 'Antigravity',
            title: (label || 'Antigravity Session').split('\n')[0].slice(0, 80),
            createdAt: isoTime,
            updatedAt: isoTime,
            agyConversationId: convId,
            codexSessionId: null,
            hubSessionIds: [],
            messagesLoaded: false,
            messages: []
          };
          threadMap.set(hubThreadId, t);
        }
        t.nativeSource = { type: 'agy', id: convId };
        t.nativeUpdatedAt = isoTime;
        t.stepCount = Number(r.step_count || 0);
        t.projectId = proj.id;
        t.projectName = proj.name;
        t.projectPath = proj.path;
        if (new Date(isoTime) > new Date(t.updatedAt || 0)) t.updatedAt = isoTime;
      }
    } catch (e) {
      console.error('[AI Hub] Error reading Antigravity DB:', e.message);
    } finally {
      if (db) {
        try {
          db.close();
        } catch {}
      }
    }
  }

  // E. Codex Desktop & VS Code (Codex extension) conversations
  const sessionNames = new Map();
  const sessionIdxPath = path.join(HOME, '.codex', 'session_index.jsonl');
  if (fs.existsSync(sessionIdxPath)) {
    try {
      for (const l of fs.readFileSync(sessionIdxPath, 'utf8').trim().split('\n')) {
        try {
          const o = JSON.parse(l);
          if (o.id && o.thread_name) sessionNames.set(o.id, o.thread_name);
        } catch {}
      }
    } catch {}
  }

  if (fs.existsSync(CODEX_DB_PATH)) {
    let db;
    try {
      db = new DatabaseSync(CODEX_DB_PATH, { open: true, readOnly: true, readBigInts: true, timeout: 2500 });
      try {
        const cProjs = db.prepare('SELECT p.name, r.path FROM projects p LEFT JOIN project_roots r ON p.id = r.project_id').all();
        for (const cp of cProjs) if (cp.path) registerProject(cp.path, cp.name, 'Codex');
      } catch {}

      const cThreads = db
        .prepare(
          `SELECT id, title, name, preview, first_user_message, cwd, source, originator, model,
                  reasoning_effort, rollout_path, created_at_ms, updated_at_ms
           FROM threads
           WHERE archived = 0
           ORDER BY updated_at_ms DESC`
        )
        .all();
      db.close();
      db = null;

      for (const ct of cThreads) {
        if (String(ct.source || '').includes('"subagent"')) continue;
        if (hubOwnedSessions.has(ct.id)) continue;
        const rawTitle = sessionNames.get(ct.id) || ct.name || ct.title || ct.preview || ct.first_user_message || '';
        if (TEST_PROMPT_RE.test(rawTitle.trim())) continue;

        const isVsCode = ct.originator === 'codex_vscode' || (ct.source === 'vscode' && ct.originator !== 'Codex Desktop');
        const cleanCwd = normalizeWinPath(ct.cwd) || DEFAULT_PROJECT_PATH;
        const proj = registerProject(cleanCwd, null, isVsCode ? 'VS Code' : 'Codex') || fallbackProject(cleanCwd);

        const hubThreadId = `codex-${ct.id}`;
        const updatedIso = ct.updated_at_ms ? new Date(Number(ct.updated_at_ms)).toISOString() : new Date().toISOString();
        const createdIso = ct.created_at_ms ? new Date(Number(ct.created_at_ms)).toISOString() : updatedIso;
        let cleanTitle = rawTitle.replace(/^# Files mentioned by the user:[\s\S]*?## My request:\s*/i, '').trim();
        cleanTitle = cleanTitle.split('\n')[0].slice(0, 85) || 'Codex Session';

        let t = threadMap.get(hubThreadId);
        if (!t) {
          t = {
            id: hubThreadId,
            origin: isVsCode ? 'vscode' : 'codex',
            originatorLabel: isVsCode ? 'VS Code (Codex)' : 'Codex Desktop',
            title: cleanTitle,
            createdAt: createdIso,
            updatedAt: updatedIso,
            agyConversationId: null,
            codexSessionId: ct.id,
            hubSessionIds: [],
            model: ct.model,
            effort: ct.reasoning_effort,
            messagesLoaded: false,
            messages: []
          };
          threadMap.set(hubThreadId, t);
        }
        if (sessionNames.get(ct.id)) t.title = sessionNames.get(ct.id);
        t.nativeSource = { type: 'codex', id: ct.id, rolloutPath: normalizeWinPath(ct.rollout_path) };
        t.nativeUpdatedAt = updatedIso;
        t.projectId = proj.id;
        t.projectName = proj.name;
        t.projectPath = proj.path;
        if (new Date(updatedIso) > new Date(t.updatedAt || 0)) t.updatedAt = updatedIso;
      }
    } catch (e) {
      console.error('[AI Hub] Error reading Codex DB:', e.message);
    } finally {
      if (db) {
        try {
          db.close();
        } catch {}
      }
    }
  }

  const threads = Array.from(threadMap.values())
    .filter((t) => !hidden.has(t.id))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return { projects: Array.from(projectMap.values()), threads };
}

// ---------------------------------------------------------------------------
// 5. Load Native Chat History (reloads automatically when the source file changes)
// ---------------------------------------------------------------------------
const rolloutPathCache = new Map();

function findCodexRollout(sessionId) {
  if (rolloutPathCache.has(sessionId)) return rolloutPathCache.get(sessionId);
  const sessionsDir = path.join(HOME, '.codex', 'sessions');
  let found = null;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (found) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.includes(sessionId) && e.name.endsWith('.jsonl')) found = full;
    }
  };
  if (existsDir(sessionsDir)) {
    try {
      walk(sessionsDir);
    } catch {}
  }
  rolloutPathCache.set(sessionId, found);
  return found;
}

function nativeSourceInfo(thread) {
  const ns = thread.nativeSource;
  if (!ns) return null;
  if (ns.type === 'agy') {
    const trFull = path.join(HOME, '.gemini', 'antigravity', 'brain', ns.id, '.system_generated', 'logs', 'transcript_full.jsonl');
    const tr = path.join(HOME, '.gemini', 'antigravity', 'brain', ns.id, '.system_generated', 'logs', 'transcript.jsonl');
    return { ...ns, file: fs.existsSync(trFull) ? trFull : fs.existsSync(tr) ? tr : null };
  }
  if (ns.type === 'codex') {
    const file = ns.rolloutPath && fs.existsSync(ns.rolloutPath) ? ns.rolloutPath : findCodexRollout(ns.id);
    return { ...ns, file };
  }
  return null;
}

function getThreadExtraCodexFiles(thread, primaryId) {
  if (!thread) return [];
  const sids = new Set([...(thread.hubSessionIds || []), thread.codexSessionId].filter(Boolean));
  if (primaryId) sids.delete(primaryId);
  const files = [];
  for (const sid of sids) {
    const f = findCodexRollout(sid);
    if (f && fs.existsSync(f)) files.push(f);
  }
  return files;
}

function sourceKey(info, thread) {
  const parts = [];
  if (info && info.file) {
    try {
      const st = fs.statSync(info.file);
      parts.push(`${info.file}:${st.mtimeMs}:${st.size}`);
    } catch {}
  }
  if (info && info.type === 'codex') {
    for (const ef of getThreadExtraCodexFiles(thread, info.id)) {
      try {
        const st = fs.statSync(ef);
        parts.push(`${ef}:${st.mtimeMs}:${st.size}`);
      } catch {}
    }
  }
  return parts.length ? parts.join('|') : `db:${thread.nativeUpdatedAt || ''}`;
}

function forEachJsonlLine(file, onObj, maxTailBytes = 25 * 1024 * 1024, lineFilter = null) {
  if (!file || !fs.existsSync(file)) return;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    let pos = Math.max(0, size - maxTailBytes);
    const chunkBuf = Buffer.alloc(512 * 1024);
    let carry = '';
    let skipPartialFirst = pos > 0;

    while (pos < size) {
      const toRead = Math.min(chunkBuf.length, size - pos);
      const bytesRead = fs.readSync(fd, chunkBuf, 0, toRead, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      carry += chunkBuf.slice(0, bytesRead).toString('utf8');
      const lines = carry.split('\n');
      carry = lines.pop();
      for (const l of lines) {
        if (skipPartialFirst) {
          skipPartialFirst = false;
          continue;
        }
        const trimmed = l.trim();
        if (!trimmed) continue;
        if (lineFilter && !lineFilter(trimmed)) continue;
        try {
          onObj(JSON.parse(trimmed));
        } catch {}
      }
    }
    if (carry.trim() && !skipPartialFirst) {
      const trimmed = carry.trim();
      if (!lineFilter || lineFilter(trimmed)) {
        try {
          onObj(JSON.parse(trimmed));
        } catch {}
      }
    }
  } catch {} finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function humanizeToolAction(name, args) {
  const n = String(name || '').toLowerCase();
  const a = args && typeof args === 'object' ? args : {};
  if (a.toolSummary) return String(a.toolSummary).replace(/^"|"$/g, '');
  const rawFile = a.Path || a.AbsolutePath || a.TargetFile || a.path || a.file || '';
  const base = rawFile ? path.basename(String(rawFile).replace(/^"|"$/g, '')) : '';
  if (n.includes('read') || n.includes('view')) return base ? `Reading ${base}…` : 'Reading file…';
  if (n.includes('edit') || n.includes('replace') || n.includes('sed')) return base ? `Editing ${base}…` : 'Editing file…';
  if (n.includes('write')) return base ? `Writing ${base}…` : 'Writing file…';
  if (n.includes('grep') || n.includes('search') || n.includes('find')) {
    const q = a.query || a.Query || a.Pattern || base || '';
    return q ? `Searching for "${truncate(String(q).replace(/^"|"$/g, ''), 40)}"…` : 'Searching codebase…';
  }
  if (n.includes('list_dir')) return base ? `Listing ${base}…` : 'Inspecting directory…';
  if (n.includes('run_command') || n.includes('command')) return 'Running workspace check…';
  return name ? `Running ${name.replace(/_/g, ' ')}…` : 'Working…';
}

function summarizeToolCall(name, args) {
  let detail = '';
  if (args && typeof args === 'object') {
    detail =
      args.toolSummary ||
      args.CommandLine ||
      args.command ||
      args.cmd ||
      args.AbsolutePath ||
      args.Path ||
      args.TargetFile ||
      args.path ||
      args.query ||
      '';
    if (Array.isArray(detail)) detail = detail.join(' ');
    if (!detail) detail = JSON.stringify(args);
  } else if (args) {
    detail = String(args);
  }
  return `${name || 'tool'}: ${truncate(String(detail).replace(/\s+/g, ' '), 160)}`;
}

function readAgyNative(convId, file, thread) {
  const messages = [];
  const actions = [];

  if (file) {
    let currentTurn = null;
    forEachJsonlLine(
      file,
      (step) => {
      if (step.type === 'USER_INPUT' && step.content) {
        const cleaned = step.content
          .replace(/<USER_REQUEST>\s*/g, '')
          .replace(/\s*<\/USER_REQUEST>[\s\S]*$/g, '')
          .replace(/\[(Cross-Engine Context Sync|Compacted Checkpoint Session)[\s\S]*?<\/conversation_history>\s*/g, '')
          .replace(/<lightweight_query_hint>[\s\S]*?<\/lightweight_query_hint>/gi, '')
          .replace(/<autopilot_step_instruction>[\s\S]*?<\/autopilot_step_instruction>/gi, '')
          .trim();
        if (cleaned) {
          currentTurn = null;
          messages.push({
            id: `agy-${convId}-${step.step_index}`,
            role: 'user',
            content: cleaned,
            timestamp: step.created_at || thread.createdAt
          });
        }
      } else if (step.type === 'PLANNER_RESPONSE') {
        const stepTools = [];
        for (const tc of step.tool_calls || []) {
          const name = tc.name || tc.tool_name || tc.function?.name;
          let args = tc.args || tc.arguments || tc.input || tc.parameters;
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args);
            } catch {}
          }
          if (name) {
            const summary = summarizeToolCall(name, args);
            actions.push(summary);
            stepTools.push(summary);
          }
        }
        const thought = (step.thinking || '').trim();
        const text = (step.content || '').trim();
        if (!thought && !text && stepTools.length === 0) return;

        if (!currentTurn) {
          currentTurn = {
            id: `agy-${convId}-${step.step_index}`,
            role: 'assistant',
            engine: 'antigravity',
            model: 'Antigravity',
            content: '',
            narratives: [],
            thinkingSteps: [],
            actions: [],
            usage: null,
            timestamp: step.created_at || thread.updatedAt
          };
          messages.push(currentTurn);
        }
        if (thought && !currentTurn.thinkingSteps.includes(thought)) {
          currentTurn.thinkingSteps.push(thought);
        }
        for (const st of stepTools) {
          if (!currentTurn.actions.includes(st)) currentTurn.actions.push(st);
        }
        if (text) {
          if (currentTurn.content) {
            currentTurn.narratives.push(currentTurn.content);
          }
          currentTurn.content = text;
        }
        if (step.input_tokens || step.output_tokens || step.cache_read_tokens) {
          const prev = currentTurn.usage || { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cached_input_tokens: 0, total_tokens: 0 };
          const stepIn = Number(step.input_tokens || 0);
          const stepCache = Number(step.cache_read_tokens || 0);
          const stepOut = Number(step.output_tokens || 0);
          const contextIn = Math.max(prev.input_tokens || 0, stepIn + stepCache);
          const nextOut = (prev.output_tokens || 0) + stepOut;
          const maxCache = Math.max(prev.cache_read_tokens || 0, stepCache);
          currentTurn.usage = {
            input_tokens: contextIn,
            output_tokens: nextOut,
            cache_read_tokens: maxCache,
            cached_input_tokens: maxCache,
            total_tokens: contextIn + nextOut
          };
        }
        if (step.created_at) currentTurn.timestamp = step.created_at;
      }
    },
    40 * 1024 * 1024,
    (line) => line.includes('"USER_INPUT"') || line.includes('"PLANNER_RESPONSE"')
    );
  }

  // Fallback: the searchable index inside conversation_summaries.db.
  if (messages.length === 0 && fs.existsSync(AGY_DB_PATH)) {
    try {
      const db = new DatabaseSync(AGY_DB_PATH, { open: true, readOnly: true, readBigInts: true });
      const chunks = db
        .prepare(
          `SELECT chunk_index, last_step_created_at, user_body, agent_body
           FROM conversations_fts
           WHERE conversation_id = ? AND chunk_index >= 0
           ORDER BY chunk_index ASC`
        )
        .all(convId);
      db.close();
      for (const c of chunks) {
        const ts = c.last_step_created_at ? new Date(String(c.last_step_created_at).replace(' ', 'T')).toISOString() : thread.updatedAt;
        if (c.user_body && c.user_body.trim()) {
          messages.push({ id: `agy-fts-u-${c.chunk_index}`, role: 'user', content: c.user_body.trim(), timestamp: ts });
        }
        if (c.agent_body && c.agent_body.trim()) {
          messages.push({ id: `agy-fts-a-${c.chunk_index}`, role: 'assistant', engine: 'antigravity', model: 'Antigravity', content: c.agent_body.trim(), timestamp: ts });
        }
      }
    } catch {}
  }

  return { messages, actions: actions.slice(-25) };
}

function extractCodexText(contentArr) {
  if (typeof contentArr === 'string') return contentArr.trim();
  if (!Array.isArray(contentArr)) return '';
  return contentArr
    .map((c) => c.text || c.input_text || c.output_text || '')
    .join('')
    .trim();
}

function stripInternalCodexTags(text) {
  return String(text || '')
    .replace(/<external_codex_apps_open_page>[\s\S]*?<\/external_codex_apps_open_page>/gi, '')
    .replace(/<codex_apps_client_time_context>[\s\S]*?<\/codex_apps_client_time_context>/gi, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '')
    .replace(/<in-app-browser-context[\s\S]*?<\/in-app-browser-context>/gi, '')
    .replace(/<turn_aborted>[\s\S]*?<\/turn_aborted>/gi, '')
    .replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/gi, '')
    .replace(/<model_switch>[\s\S]*?<\/model_switch>/gi, '')
    .replace(/<permissions[\s\S]*?<\/permissions>/gi, '')
    .replace(/<collaboration_mode>[\s\S]*?<\/collaboration_mode>/gi, '')
    .replace(/\[(Cross-Engine Context Sync|Compacted Checkpoint Session)[\s\S]*?<\/conversation_history>\s*/g, '')
    .replace(/<lightweight_query_hint>[\s\S]*?<\/lightweight_query_hint>/gi, '')
    .replace(/<autopilot_step_instruction>[\s\S]*?<\/autopilot_step_instruction>/gi, '')
    .trim();
}

function readCodexNative(file, thread) {
  const messages = [];
  const actions = [];
  if (!file || !fs.existsSync(file)) return { messages, actions };

  const modelLabel = `${thread.model || 'Codex'}${thread.origin === 'vscode' ? ' • VS Code' : ''}`;
  let currentTurn = null;
  let lastUserText = '';

  const ensureAssistantTurn = (ts) => {
    if (!currentTurn) {
      currentTurn = {
        id: `cx-${messages.length}`,
        role: 'assistant',
        engine: 'codex',
        model: modelLabel,
        content: '',
        narratives: [],
        thinkingSteps: [],
        actions: [],
        timestamp: ts || thread.updatedAt
      };
      messages.push(currentTurn);
    }
    if (ts) currentTurn.timestamp = ts;
    return currentTurn;
  };

  const addUserTurn = (text, ts) => {
    const clean = stripInternalCodexTags(text);
    if (!clean || clean === lastUserText) return;
    if (
      clean.startsWith('<codex_apps_') ||
      clean.startsWith('<external_codex_') ||
      clean.startsWith('<environment_context>') ||
      clean.startsWith('# AGENTS.md instructions') ||
      clean.startsWith('<INSTRUCTIONS>') ||
      clean.startsWith('<skills_instructions>') ||
      clean.startsWith('<turn_aborted>') ||
      clean.startsWith('<!-- AI-STUDIO-HUB-SHARED-CONTEXT:START -->')
    ) {
      return;
    }
    lastUserText = clean;
    currentTurn = null;
    messages.push({ id: `cx-u-${messages.length}`, role: 'user', content: clean, timestamp: ts || thread.createdAt });
  };

  forEachJsonlLine(file, (o) => {
    const p = o.payload || {};
    const ts = o.timestamp || thread.updatedAt;

    // 1. User messages (both modern response_item and legacy event_msg)
    if (o.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      const kinds = p.internal_chat_message_metadata_passthrough?.content_item_kinds;
      if (Array.isArray(kinds) && kinds.length > 0 && kinds.every((k) => String(k).startsWith('additional_content.'))) {
        return;
      }
      addUserTurn(extractCodexText(p.content), ts);
    } else if (o.type === 'event_msg' && p.type === 'user_message' && p.message) {
      addUserTurn(p.message, ts);
    } else if (o.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'UserMessage') {
      addUserTurn(extractCodexText(p.item.content), ts);
    }
    // 2. Assistant messages (capture both intermediate commentary narratives and final answer)
    else if (o.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      const txt = extractCodexText(p.content);
      if (!txt) return;
      const turn = ensureAssistantTurn(ts);
      if (p.phase === 'final_answer') {
        turn.finalAnswer = txt;
        turn.content = txt;
      } else if (p.phase === 'commentary') {
        turn.commentary = txt;
        if (!turn.narratives.includes(txt)) turn.narratives.push(txt);
      } else if (!turn.finalAnswer) {
        turn.commentary = txt;
      }
    } else if (o.type === 'event_msg' && p.type === 'agent_message' && p.message) {
      const txt = p.message.trim();
      if (!txt) return;
      const turn = ensureAssistantTurn(ts);
      if (p.phase === 'final_answer' || (!p.phase && p.phase !== 'commentary')) {
        turn.finalAnswer = txt;
        turn.content = txt;
      } else if (p.phase === 'commentary') {
        turn.commentary = txt;
        if (!turn.narratives.includes(txt)) turn.narratives.push(txt);
      } else if (!turn.finalAnswer) {
        turn.commentary = txt;
      }
    } else if (o.type === 'event_msg' && p.type === 'task_complete') {
      if (p.last_agent_message) {
        const txt = p.last_agent_message.trim();
        if (txt) {
          const turn = ensureAssistantTurn(ts);
          turn.finalAnswer = txt;
          turn.content = txt;
        }
      } else if (p.error?.message) {
        const turn = ensureAssistantTurn(ts);
        const mins = p.duration_ms ? Math.round(p.duration_ms / 60000) : 0;
        const errNote = `⚠️ **Turn interrupted by server${mins > 0 ? ` after ${mins}m` : ''}:** ${p.error.message}`;
        turn.finalAnswer = turn.commentary ? `${turn.commentary}\n\n${errNote}` : errNote;
        turn.content = turn.finalAnswer;
      }
    }
    // 3. Tool calls, commands, file edits, MCP calls
    else if (o.type === 'event_msg' && p.type === 'item_completed' && p.item) {
      const it = p.item;
      let summary = null;
      if (it.type === 'CommandExecution') {
        const cmdStr = Array.isArray(it.command) ? it.command.slice(-1)[0] : it.command;
        summary = `Command: ${truncate(String(cmdStr || 'shell').replace(/\s+/g, ' '), 150)}`;
      } else if (it.type === 'FileChange' && it.changes) {
        const files = Object.keys(it.changes).map((f) => path.basename(f)).join(', ');
        summary = `Edited: ${files || 'files'}`;
      } else if (it.type === 'McpToolCall') {
        summary = `MCP: ${it.server || ''}/${it.tool || ''}`;
      } else if (it.type === 'ImageView' && it.path) {
        summary = `Viewed image: ${path.basename(it.path)}`;
      }
      if (summary) {
        actions.push(summary);
        const turn = ensureAssistantTurn(ts);
        if (!turn.actions.includes(summary)) turn.actions.push(summary);
      }
    } else if (o.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
      let args = p.arguments || p.input;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {}
      }
      const summary = summarizeToolCall(p.name, args);
      actions.push(summary);
      const turn = ensureAssistantTurn(ts);
      if (!turn.actions.includes(summary)) turn.actions.push(summary);
    }
    // 4. Token usage per step (both token_usage_record and event_msg token_count)
    else if (o.type === 'token_usage_record' || (o.type === 'event_msg' && p.type === 'token_count')) {
      const u = o.type === 'token_usage_record' ? (o.payload || o) : (p.info?.last_token_usage || p.usage);
      if (u && (u.input_tokens || u.output_tokens || u.total_tokens)) {
        const turn = ensureAssistantTurn(ts);
        const prev = turn.usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0, _lastSig: '' };
        const stepIn = Number(u.input_tokens || 0);
        const stepOut = Number(u.output_tokens || 0);
        const sig = `${stepIn}:${stepOut}:${u.total_tokens || 0}`;
        if (prev._lastSig !== sig) {
          const contextIn = Math.max(prev.input_tokens || 0, stepIn);
          const nextOut = (prev.output_tokens || 0) + stepOut;
          turn.usage = {
            input_tokens: contextIn,
            output_tokens: nextOut,
            cached_input_tokens: Number(u.cached_input_tokens || prev.cached_input_tokens || 0),
            total_tokens: contextIn + nextOut,
            _lastSig: sig
          };
        }
      }
    }
  });

  for (const m of messages) {
    if (m.role === 'assistant') {
      if (m.finalAnswer) m.content = m.finalAnswer;
      else if (m.commentary && !m.content) m.content = m.commentary;
      if (Array.isArray(m.narratives)) {
        if (m.content) m.narratives = m.narratives.filter((n) => n.trim() !== m.content.trim());
        m.narratives = m.narratives.slice(-25);
      }
      if (Array.isArray(m.actions)) {
        m.actions = m.actions.slice(-15);
      }
      if (m.usage && m.usage._lastSig) {
        delete m.usage._lastSig;
      }
      delete m.finalAnswer;
      delete m.commentary;
    }
  }

  return { messages, actions: actions.slice(-25) };
}

function sameContent(a, b) {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if (!x || !y) return false;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  return longer.includes(shorter.slice(0, 120));
}

function updateThreadContextStats(thread) {
  if (!thread) return;
  if (thread.pendingCompact) {
    thread.contextTokens = 0;
    return;
  }
  const msgs = thread.messages || [];
  const startIdx = Number(thread.compactedAtMsgCount || 0);
  const activeSlice = startIdx > 0 && startIdx <= msgs.length ? msgs.slice(startIdx) : msgs;
  const lastAsst = [...activeSlice].reverse().find((m) => m.role === 'assistant' && m.usage && (m.usage.input_tokens || m.usage.total_tokens));
  if (lastAsst && lastAsst.usage) {
    const u = lastAsst.usage;
    const ctxTok = Number(u.input_tokens || 0);
    const cachedTok = Number(u.cached_input_tokens || u.cache_read_tokens || 0);
    thread.contextTokens = ctxTok;
    thread.cachePct = ctxTok > 0 ? Math.min(100, Math.round((cachedTok / ctxTok) * 100)) : 0;
  } else if (startIdx > 0 && activeSlice.length === 0) {
    thread.contextTokens = 0;
    thread.cachePct = 0;
  }
}

function compactThreadSession(thread, reason = 'manual') {
  if (!thread) return null;
  loadThreadHistory(thread);
  updateThreadContextStats(thread);
  const prevTokens = thread.contextTokens || thread.compactedFromTokens || 0;
  if (thread.codexSessionId && thread.codexSessionId !== thread.nativeSource?.id) {
    thread.hubSessionIds = thread.hubSessionIds || [];
    if (!thread.hubSessionIds.includes(thread.codexSessionId)) thread.hubSessionIds.push(thread.codexSessionId);
  }
  if (thread.agyConversationId && thread.agyConversationId !== thread.nativeSource?.id) {
    thread.hubSessionIds = thread.hubSessionIds || [];
    if (!thread.hubSessionIds.includes(thread.agyConversationId)) thread.hubSessionIds.push(thread.agyConversationId);
  }
  thread.pendingCompact = true;
  thread.compactedFromTokens = prevTokens;
  thread.compactedAtMsgCount = (thread.messages || []).length;
  thread.contextTokens = 0;
  writeContextFile(thread, thread.messages || []);
  return { prevTokens, reason };
}

function loadThreadHistory(thread, force = false) {
  if (!thread) return thread;
  const hubTurns = (thread.messages || []).filter((m) => m.fromHub);
  const info = nativeSourceInfo(thread);
  if (!info) {
    thread.messages = hubTurns;
    thread.messagesLoaded = true;
    updateThreadContextStats(thread);
    return thread;
  }

  const key = sourceKey(info, thread);
  if (!force && thread.messagesLoaded && thread.loadedKey === key) {
    updateThreadContextStats(thread);
    return thread;
  }

  const native = info.type === 'agy' ? readAgyNative(info.id, info.file, thread) : readCodexNative(info.file, thread);
  if (info.type === 'codex') {
    for (const extraFile of getThreadExtraCodexFiles(thread, info.id)) {
      const forkData = readCodexNative(extraFile, thread);
      for (const fm of forkData.messages) {
        const fmTs = Date.parse(fm.timestamp) || 0;
        const isDuplicate = native.messages.some((m) =>
          m.role === fm.role &&
          ((fmTs && m.timestamp && Math.abs((Date.parse(m.timestamp) || 0) - fmTs) < 2000) ||
            (m.timestamp === fm.timestamp && sameContent(m.content, fm.content)))
        );
        if (!isDuplicate) {
          native.messages.push({ ...fm, id: `${fm.id}-fork` });
        }
      }
      for (const act of forkData.actions) {
        if (!native.actions.includes(act)) native.actions.push(act);
      }
    }
    native.actions = native.actions.slice(-25);
  }
  // Hub turns that resumed the original session also appear in the native log; drop duplicates.
  const extraHub = hubTurns.filter((h) => !native.messages.some((n) => n.role === h.role && sameContent(n.content, h.content)));
  const ts = (m) => Date.parse(m.timestamp) || 0;
  thread.messages = [...native.messages, ...extraHub].sort((a, b) => ts(a) - ts(b));
  const lastMsg = thread.messages[thread.messages.length - 1];
  if (lastMsg?.timestamp && (Date.parse(lastMsg.timestamp) || 0) > (Date.parse(thread.updatedAt) || 0)) {
    thread.updatedAt = lastMsg.timestamp;
  }
  thread.nativeActions = native.actions;
  thread.messagesLoaded = true;
  thread.loadedKey = key;
  updateThreadContextStats(thread);
  return thread;
}

// ---------------------------------------------------------------------------
// 6. Persistent State (stored in %LOCALAPPDATA%\AIStudioHub, transcripts not duplicated)
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  defaultEngine: 'auto',
  autoSwitchThresholdPct: 12,
  agyModel: 'gemini-4-argon-medium',
  agyEffort: 'medium',
  codexModel: 'gpt-6.1-sol',
  codexEffort: 'high',
  executionMode: 'agent',
  codexBinary: '',
  mobilePin: '849201',
  autoStartTunnel: true
};

function sanitizeForDisk(state) {
  return {
    settings: state.settings || DEFAULT_SETTINGS,
    hiddenThreadIds: state.hiddenThreadIds || [],
    projects: (state.projects || []).map(({ id, name, path: p, sources, createdAt }) => ({ id, name, path: p, sources, createdAt })),
    threads: (state.threads || []).map((t) => {
      const { messages, messagesLoaded, loadedKey, nativeActions, ...rest } = t;
      // Imported transcripts stay in the native apps; only turns made in the hub are saved.
      return { ...rest, messages: (messages || []).filter((m) => m.fromHub), messagesLoaded: false };
    })
  };
}

function saveState(state) {
  try {
    const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(sanitizeForDisk(state), null, 2), 'utf8');
    try {
      fs.renameSync(tmp, STATE_FILE);
    } catch {
      fs.writeFileSync(STATE_FILE, JSON.stringify(sanitizeForDisk(state), null, 2), 'utf8');
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  } catch (err) {
    console.error('[AI Hub] saveState warning:', err.message);
  }
}

function migrateLegacyData() {
  const legacyState = path.join(LEGACY_DATA_DIR, 'hub_state.json');
  if (!fs.existsSync(LEGACY_DATA_DIR)) return;
  try {
    if (fs.existsSync(legacyState) && !fs.existsSync(STATE_FILE)) {
      const legacy = JSON.parse(fs.readFileSync(legacyState, 'utf8'));
      fs.writeFileSync(STATE_FILE, JSON.stringify(sanitizeForDisk(legacy), null, 2), 'utf8');
    }
    fs.rmSync(LEGACY_DATA_DIR, { recursive: true, force: true });
    console.log(`[AI Hub] Moved hub data out of Google Drive to ${DATA_DIR}`);
  } catch (e) {
    console.error('[AI Hub] Could not migrate legacy data folder:', e.message);
  }
}

function loadState() {
  let saved = null;
  if (fs.existsSync(STATE_FILE)) {
    try {
      saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {}
  }
  const discovered = discoverAllProjectsAndChats(saved);
  const state = {
    projects: discovered.projects,
    threads: discovered.threads,
    hiddenThreadIds: saved?.hiddenThreadIds || [],
    settings: { ...DEFAULT_SETTINGS, ...(saved?.settings || {}) }
  };
  if (!state.settings.mobilePin || String(state.settings.mobilePin).length !== 6) {
    state.settings.mobilePin = String(Math.floor(100000 + Math.random() * 900000));
  }
  saveState(state);
  return state;
}

migrateLegacyData();
let appState = loadState();
let lastDiscoveryAt = Date.now();

function syncDiscovery(force = false) {
  if (!force && Date.now() - lastDiscoveryAt < 15000) return;
  const d = discoverAllProjectsAndChats(appState);
  appState.projects = d.projects;
  appState.threads = d.threads;
  lastDiscoveryAt = Date.now();
}

function summarizeThread(t) {
  const { messages, nativeActions, loadedKey, ...rest } = t;
  return { ...rest, messageCount: (messages || []).length };
}

function publicState() {
  return { projects: appState.projects, threads: appState.threads.map(summarizeThread), settings: appState.settings };
}

function isHomeRoot(p) {
  const clean = normalizeWinPath(p);
  return !!clean && clean.toLowerCase().replace(/\\+$/, '') === HOME.toLowerCase().replace(/\\+$/, '');
}

const SENSITIVE_DIRS = [
  path.join(HOME, '.ssh'),
  path.join(HOME, '.codex'),
  path.join(HOME, '.gemini'),
  path.join(HOME, '.aws'),
  path.join(HOME, 'AppData')
];

function isAllowedWorkspacePath(p) {
  const clean = normalizeWinPath(p);
  if (!clean) return false;
  if (SENSITIVE_DIRS.some((s) => isInside(clean, s))) return false;
  return (
    appState.projects.some((pr) => !isHomeRoot(pr.path) && isInside(clean, pr.path)) ||
    appState.threads.some((t) => t.projectPath && !isHomeRoot(t.projectPath) && isInside(clean, t.projectPath))
  );
}

// ---------------------------------------------------------------------------
// 7. Live Quota & Model Telemetry
// ---------------------------------------------------------------------------
let cachedAgyHubInfo = null;
let agyStatusCache = { at: 0, value: null };
let codexStatusCache = { at: 0, value: null };

const DEFAULT_AGY_MODELS = [
  ['Gemini 4 Argon', ['high', 'medium', 'low'], 'gemini-4-argon'],
  ['Gemini 3.8 Flash', ['high', 'medium', 'low'], 'gemini-3.8-flash'],
  ['Claude Opus 5.5', ['high', 'medium', 'low'], 'claude-opus-5-5'],
  ['Claude Sonnet 5.5', ['high', 'medium', 'low'], 'claude-sonnet-5-5'],
  ['GPT-OSS 120B', ['medium'], 'gpt-oss-120b']
].flatMap(([family, efforts, slug]) =>
  efforts.map((e) => ({
    label: `${family} (${e[0].toUpperCase()}${e.slice(1)})`,
    modelId: `${slug}-${e}`,
    family,
    effort: e,
    remainingPct: null,
    resetTime: null
  }))
);

let lastHubCheckTime = 0;
async function discoverAgyHubProcess() {
  if (cachedAgyHubInfo) return cachedAgyHubInfo;
  if (Date.now() - lastHubCheckTime < 25000) return null;
  lastHubCheckTime = Date.now();
  // Unofficial: the Antigravity app runs `agy --hub` with a port and CSRF token on its command line.
  try {
    const out = await runPowerShell(
      `Get-CimInstance Win32_Process -Filter "Name = 'agy.exe' AND CommandLine LIKE '%--hub-port=%'" | Select-Object -First 1 -ExpandProperty CommandLine`,
      { timeoutMs: 3000 }
    );
    const portMatch = out && out.match(/--hub-port=(\d+)/);
    const csrfMatch = out && out.match(/--csrf_token=([^\s"]+)/);
    cachedAgyHubInfo = portMatch && csrfMatch ? { port: portMatch[1], csrf: csrfMatch[1] } : null;
    return cachedAgyHubInfo;
  } catch {
    return null;
  }
}

async function queryAgyHub(h) {
  const res = await fetch(`http://127.0.0.1:${h.port}/exa.language_server_pb.LanguageServerService/GetUserStatus`, {
    method: 'POST',
    headers: { 'x-codeium-csrf-token': h.csrf, 'Connect-Protocol-Version': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } }),
    signal: AbortSignal.timeout(4000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getAgyStatus(force = false) {
  if (!force && agyStatusCache.value && Date.now() - agyStatusCache.at < 20000) return agyStatusCache.value;

  let value = { connected: false, source: 'unofficial-local-api', models: DEFAULT_AGY_MODELS, pools: [], user: null };
  try {
    let hub = cachedAgyHubInfo || (await discoverAgyHubProcess());
    if (!hub) {
      agyStatusCache = { at: Date.now(), value };
      return value;
    }
    let data;
    try {
      data = await queryAgyHub(hub);
    } catch {
      cachedAgyHubInfo = null;
      agyStatusCache = { at: Date.now(), value };
      return value;
    }

    const us = data.userStatus || {};
    const models = (us.cascadeModelConfigData?.clientModelConfigs || []).map((m) => {
      const effortMatch = m.label.match(/\((Low|Medium|High)\)/i);
      let remainingPct = 100;
      if (m.quotaInfo?.remainingFraction != null) {
        remainingPct = Math.round(m.quotaInfo.remainingFraction * 1000) / 10;
      } else if (m.quotaInfo?.resetTime) {
        const resetMs = new Date(m.quotaInfo.resetTime).getTime();
        if (resetMs > Date.now()) remainingPct = 0;
      }
      return {
        label: m.label,
        modelId: m.modelId,
        family: m.label.replace(/\s*\([^)]+\)\s*$/, '').trim(),
        effort: effortMatch ? effortMatch[1].toLowerCase() : 'medium',
        remainingPct,
        resetTime: m.quotaInfo?.resetTime || null,
        supportsImages: !!m.supportsImages
      };
    });

    const pools = new Map();
    for (const m of models) {
      if (!pools.has(m.family)) pools.set(m.family, { family: m.family, remainingPct: m.remainingPct, resetTime: m.resetTime });
    }

    value = {
      connected: true,
      source: 'unofficial-local-api',
      user: { name: us.name, email: us.email, tier: us.userTier?.name || us.planStatus?.planInfo?.planName || 'Pro' },
      models: models.length ? models : DEFAULT_AGY_MODELS,
      pools: Array.from(pools.values())
    };
  } catch (err) {
    value.error = err.message;
  }
  agyStatusCache = { at: Date.now(), value };
  return value;
}

function findLatestCodexRateLimits() {
  const candidates = [];
  if (fs.existsSync(CODEX_DB_PATH)) {
    try {
      const db = new DatabaseSync(CODEX_DB_PATH, { open: true, readOnly: true, readBigInts: true });
      const rows = db.prepare('SELECT rollout_path FROM threads ORDER BY updated_at_ms DESC LIMIT 8').all();
      db.close();
      for (const r of rows) {
        const p = normalizeWinPath(r.rollout_path);
        if (p) candidates.push(p);
      }
    } catch {}
  }
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const lines = readTail(file, 2 * 1024 * 1024).split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const o = JSON.parse(lines[i]);
          if (o.type === 'event_msg' && o.payload?.type === 'token_count' && o.payload?.rate_limits) {
            return { rateLimits: o.payload.rate_limits, timestamp: o.timestamp };
          }
        } catch {}
      }
    } catch {}
  }
  return null;
}

function getCodexStatus(force = false) {
  if (!force && codexStatusCache.value && Date.now() - codexStatusCache.at < 10000) return codexStatusCache.value;

  let models = [
    { slug: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    { slug: 'gpt-6-astra', name: 'GPT-6-Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    { slug: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }
  ];
  const modelsCachePath = path.join(HOME, '.codex', 'models_cache.json');
  if (fs.existsSync(modelsCachePath)) {
    try {
      const mc = JSON.parse(fs.readFileSync(modelsCachePath, 'utf8'));
      if (Array.isArray(mc.models) && mc.models.length) {
        models = mc.models
          .filter((m) => m.visibility === 'list' || !m.visibility)
          .map((m) => ({
            slug: m.slug,
            name: m.display_name || m.slug,
            description: m.description || '',
            efforts: (m.supported_reasoning_levels || []).map((r) => r.effort)
          }));
      }
    } catch {}
  }

  const latest = findLatestCodexRateLimits();
  const rl = latest?.rateLimits || null;
  const now = Date.now();
  const windowInfo = (w, fallbackMinutes) => {
    if (!w) return { usedPct: 0, remainingPct: 100, resetsAt: null, windowMinutes: fallbackMinutes, estimated: true };
    const resetsAtMs = w.resets_at ? w.resets_at * 1000 : null;
    // If the window has reset since the last Codex turn, the stored usage is stale.
    const expired = !!resetsAtMs && resetsAtMs < now;
    const used = expired ? 0 : w.used_percent ?? 0;
    return {
      usedPct: used,
      remainingPct: Math.max(0, 100 - used),
      resetsAt: resetsAtMs && !expired ? new Date(resetsAtMs).toISOString() : null,
      windowMinutes: w.window_minutes || fallbackMinutes,
      estimated: expired
    };
  };

  const value = {
    connected: true,
    binary: getCodexBin(),
    planType: rl?.plan_type || 'plus',
    fiveHourWindow: windowInfo(rl?.primary, 300),
    weeklyWindow: windowInfo(rl?.secondary, 10080),
    lastUpdated: latest?.timestamp || null,
    models
  };
  codexStatusCache = { at: Date.now(), value };
  return value;
}

function invalidateQuotaCaches() {
  agyStatusCache.at = 0;
  codexStatusCache.at = 0;
}

// ---------------------------------------------------------------------------
// 8. Cross-Engine Handoff (conversation + recent actions + git changes)
// ---------------------------------------------------------------------------
function writeContextFile(thread, history) {
  const file = path.join(CONTEXT_DIR, `${safeFileName(thread.id)}.md`);
  const msgs = (history || thread.messages || []).slice(-60);
  const body = msgs
    .map((m) => {
      const who = m.role === 'user' ? 'USER' : `ASSISTANT (${m.engine || 'unknown'}${m.model ? ' • ' + m.model : ''})`;
      const when = m.timestamp ? ` — ${m.timestamp}` : '';
      const att = m.attachments?.length ? `\nAttachments: ${m.attachments.map((a) => a.path).join(', ')}` : '';
      const acts = m.actions?.length ? `\nActions: ${m.actions.join('; ')}` : '';
      return `### ${who}${when}${att}${acts}\n\n${truncate(m.content, 4000)}`;
    })
    .join('\n\n---\n\n');
  fs.writeFileSync(
    file,
    `# AI Studio Hub — session transcript\n\nTitle: ${thread.title}\nWorkspace: ${thread.projectPath}\nOrigin: ${thread.originatorLabel || thread.origin}\nUpdated: ${new Date().toISOString()}\n\n${body || '_No messages yet._'}\n`,
    'utf8'
  );
  return file;
}

function getGitSummary(cwd) {
  if (!existsDir(cwd)) return '';
  try {
    const opts = { cwd, encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };
    const status = execFileSync('git', ['status', '--short'], opts).trim();
    const stat = execFileSync('git', ['diff', '--stat'], opts).trim();
    if (!status && !stat) return 'Git working tree is clean.';
    return truncate(`git status --short:\n${status || '(clean)'}\n\ngit diff --stat:\n${stat || '(no unstaged changes)'}`, 2500);
  } catch {
    return ''; // Not a git repository, or git is not installed.
  }
}

function collectRecentActions(thread, history) {
  const nativeEngine = thread.nativeSource?.type === 'agy' ? 'antigravity' : 'codex';
  const native = (thread.nativeActions || []).map((a) => `[${nativeEngine}] ${a}`);
  const hub = history
    .filter((m) => m.role === 'assistant' && Array.isArray(m.actions))
    .flatMap((m) => m.actions.map((a) => `[${m.engine}] ${a}`));
  return [...native, ...hub].slice(-15).map((a) => truncate(a, 200).replace(/\n/g, ' '));
}

function resumeDecision(thread, engine) {
  const autoCompactThreshold = Number(appState?.settings?.autoCompactThresholdTokens ?? 150000);
  if (thread.pendingCompact || (autoCompactThreshold > 0 && (thread.contextTokens || 0) >= autoCompactThreshold)) {
    const prevTokens = thread.compactedFromTokens || thread.contextTokens || 0;
    return {
      resume: false,
      fork: false,
      compact: true,
      prevTokens,
      reason: thread.pendingCompact ? 'manual-compact' : 'auto-compact',
      sessionId: null
    };
  }
  const lastAssistant = [...(thread.messages || [])].reverse().find((m) => m.role === 'assistant');
  const sessionId = engine === 'antigravity' ? thread.agyConversationId : thread.codexSessionId;
  if (!sessionId) return { resume: false, reason: 'no-session' };
  const openElsewhere = engine === 'antigravity' ? isAgyConversationOpen(sessionId) : isCodexSessionOpen(sessionId);
  if (openElsewhere) {
    if (engine === 'codex') {
      // Native Codex CLI supports `codex exec fork <ID>` which clones the active session cleanly without lock conflicts
      return {
        resume: false,
        fork: true,
        deltaOnly: Boolean(lastAssistant && lastAssistant.engine !== 'codex'),
        reason: 'open-elsewhere-fork',
        sessionId
      };
    }
    return { resume: false, reason: 'open-elsewhere', sessionId };
  }
  if (lastAssistant && lastAssistant.engine !== engine) {
    // Resume the existing native session and inject only the turns that happened on the other engine!
    return { resume: true, deltaOnly: true, reason: 'engine-switch-resume', sessionId };
  }
  return { resume: true, deltaOnly: false, sessionId };
}

function classifyPromptIntent(prompt, attachments = []) {
  const clean = String(prompt || '').trim();
  if (!clean || clean.length > 260 || (attachments && attachments.length > 0) || clean.includes('```')) {
    return { isLightweightQuestion: false };
  }
  const ACTION_RE = /\b(go|proceed|continue|implement|build|fix|edit|write|create|patch|run|execute|test|verify|seal|commit|push|deploy|draw|plot|render|refactor|update|change|add|remove|delete|install|keep running|do these|step by step|one at a time)\b/i;
  if (ACTION_RE.test(clean)) {
    return { isLightweightQuestion: false };
  }
  const QUESTION_RE = /^(what|whats|what's|why|how|when|where|who|which|status|tell me|explain|summarize|summary|can you explain|do we have|is there|check carefully and give me a road\s*map|give me a road\s*map)\b|\?$/i;
  if (QUESTION_RE.test(clean)) {
    const isRoadmap = /road\s*map|left|architecture|plan|overview/i.test(clean);
    return {
      isLightweightQuestion: true,
      suggestedEffort: isRoadmap ? 'medium' : 'low'
    };
  }
  return { isLightweightQuestion: false };
}

function detectAutopilotLoop(prompt, autopilotFlag) {
  const clean = String(prompt || '').trim();
  const naturalMatch = /keep\s+(running|working|going)\s+until|until\s+you\s+get\s+close\s+to.*limit|do\s+these\s+steps\s+one\s+at\s+a\s+time\s+until|^\/(loop|goal)\b/i.test(clean);
  if (!autopilotFlag && !naturalMatch) {
    return { enabled: false };
  }
  const pctMatch = clean.match(/(\d{2})\s*(?:%|percent)/i);
  const targetUsedPct = pctMatch ? Math.min(99, Math.max(50, Number(pctMatch[1]))) : 95;
  const minRemainingPct = Math.max(1, 100 - targetUsedPct);
  return {
    enabled: true,
    targetUsedPct,
    minRemainingPct,
    maxSteps: 12
  };
}

function buildEnginePrompt({ thread, history, userPrompt, attachments, engine, decision, handoffReason, lightweightHint, autopilotStep }) {
  let userText = userPrompt;
  if (userText.length > 16000) {
    const f = path.join(CONTEXT_DIR, `${safeFileName(thread.id)}-message-${Date.now()}.md`);
    fs.writeFileSync(f, userPrompt, 'utf8');
    userText = `${userPrompt.slice(0, 3000)}\n…\n[The full message is saved at: ${f}. Read that file first.]`;
  }
  const attachmentBlock = attachments.length
    ? `\n\n[Attached files]:\n${attachments.map((a) => `- ${a.path} (${a.name})`).join('\n')}\nRead these files directly if needed.`
    : '';
  const queryHintBlock = lightweightHint
    ? `\n\n<lightweight_query_hint>Note: This is a status or informational question. Answer concisely using existing context/checkpoint files without running heavy test suites or modifying files.</lightweight_query_hint>`
    : '';
  const autopilotBlock = autopilotStep
    ? `\n\n<autopilot_step_instruction>[AI Studio Hub — Multi-Turn Autopilot Loop (Step ${autopilotStep.step}/${autopilotStep.maxSteps} • Target: ${autopilotStep.targetUsedPct}% quota used)]\nIMPORTANT: AI Studio Hub is orchestrating an automated multi-turn loop for you so your connection never times out.\nDo NOT try to run hours of work inside a single monolithic turn.\nExecute ONLY THE NEXT SINGLE BOUNDED STEP (or milestone) right now, verify it, update CHECKPOINT.md (if used), and finish your turn with a concise summary of what was completed and what the next step is.\nAs soon as you finish this turn, the Hub will check the live quota and automatically trigger the next turn for you.\nIf all planned steps are 100% complete and nothing remains to be done, include [AUTOPILOT_DONE] at the end of your reply.</autopilot_step_instruction>`
    : '';
  const request = `${userText}${attachmentBlock}${queryHintBlock}${autopilotBlock}`;

  // If resuming or forking the same engine with no intervening turns on the other engine, send the user's prompt directly
  if (((decision.resume || decision.fork) && !decision.deltaOnly) || history.length === 0) {
    return { prompt: request, usedBriefing: false };
  }

  // If resuming or forking an existing native session after turns occurred on the other engine, pass only the delta turns
  let relevantHistory = history;
  if ((decision.resume || decision.fork) && decision.deltaOnly) {
    const syncedCount = engine === 'antigravity' ? (thread.agySyncedMsgCount || 0) : (thread.codexSyncedMsgCount || 0);
    let lastIdx = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'assistant' && history[i].engine === engine) {
        lastIdx = i;
        break;
      }
    }
    const startIdx = Math.max(lastIdx + 1, syncedCount);
    if (startIdx >= history.length) {
      return { prompt: request, usedBriefing: false };
    }
    if (startIdx > 0) {
      relevantHistory = history.slice(startIdx);
    }
  }

  const transcriptFile = writeContextFile(thread, history);
  const recentActions = collectRecentActions(thread, relevantHistory);
  const gitSummary = getGitSummary(thread.projectPath);

  if (decision.compact) {
    const cpPath = thread.projectPath ? path.join(thread.projectPath, 'CHECKPOINT.md') : null;
    const hasCheckpoint = cpPath && fs.existsSync(cpPath);
    const compactHeader = [
      `[Compacted Checkpoint Session — continuing on ${engine.toUpperCase()}]`,
      handoffReason ? `Note: ${handoffReason}` : '',
      hasCheckpoint ? `Primary Workspace Checkpoint File (READ THIS FIRST if you need project state): ${cpPath}` : '',
      `Full historical session transcript file (read only if older details are needed): ${transcriptFile}`,
      recentActions.length ? `Recent tool/file actions:\n${recentActions.slice(-6).map((a) => `  - ${a}`).join('\n')}` : '',
      gitSummary && gitSummary !== 'Git working tree is clean.' ? `Workspace git status:\n${gitSummary}` : '',
      'Please continue the dialogue naturally based on the recent exchange below.'
    ].filter(Boolean).join('\n');
    const recentHist = relevantHistory
      .slice(-4)
      .map((m) => `[${m.role === 'user' ? 'USER' : `ASSISTANT (${m.engine || 'agent'})`}]:\n${truncate(m.content, 1200)}`)
      .join('\n\n');
    return {
      prompt: `${compactHeader}\n\n<conversation_history>\n${recentHist}\n</conversation_history>\n\n${request}`,
      usedBriefing: true
    };
  }

  const header = [
    `[Cross-Engine Context Sync — continuing on ${engine.toUpperCase()}]`,
    handoffReason ? `Note: ${handoffReason}` : '',
    `Full session transcript file (if deeper history is needed): ${transcriptFile}`,
    recentActions.length ? `Recent tool/file actions:\n${recentActions.slice(-8).map((a) => `  - ${a}`).join('\n')}` : '',
    gitSummary && gitSummary !== 'Git working tree is clean.' ? `Workspace git status:\n${gitSummary}` : '',
    'Please continue the dialogue naturally based on the recent exchange below.'
  ].filter(Boolean).join('\n');

  for (const turns of [12, 8, 6, 4, 2]) {
    const hist = relevantHistory
      .slice(-turns)
      .map((m) => `[${m.role === 'user' ? 'USER' : `ASSISTANT (${m.engine || 'agent'})`}]:\n${truncate(m.content, 2000)}`)
      .join('\n\n');
    const prompt = `${header}\n\n<conversation_history>\n${hist}\n</conversation_history>\n\n${request}`;
    if (prompt.length <= MAX_PROMPT_CHARS) return { prompt, usedBriefing: true };
  }
  return { prompt: request, usedBriefing: false };
}

// ---------------------------------------------------------------------------
// 8b. Automatic Live Cross-App Context Sync (Antigravity IDE <-> VS Code Codex <-> Hub)
// ---------------------------------------------------------------------------
const SHARED_CTX_START = '<!-- AI-STUDIO-HUB-SHARED-CONTEXT:START -->';
const SHARED_CTX_END = '<!-- AI-STUDIO-HUB-SHARED-CONTEXT:END -->';
let lastSyncedDigestHash = '';

function upsertSharedContextBlock(filePath, blockContent) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const wrapped = `${SHARED_CTX_START}\n${blockContent}\n${SHARED_CTX_END}`;
    let nextContent = wrapped + '\n';
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, 'utf8');
      const sIdx = existing.indexOf(SHARED_CTX_START);
      const eIdx = existing.indexOf(SHARED_CTX_END);
      if (sIdx !== -1 && eIdx !== -1 && eIdx > sIdx) {
        nextContent = existing.slice(0, sIdx) + wrapped + existing.slice(eIdx + SHARED_CTX_END.length);
      } else {
        nextContent = existing.trimEnd() + '\n\n' + wrapped + '\n';
      }
      if (existing === nextContent) return;
    }
    fs.writeFileSync(filePath, nextContent, 'utf8');
  } catch {}
}

function stripSharedContextFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf8');
    const sIdx = content.indexOf(SHARED_CTX_START);
    const eIdx = content.indexOf(SHARED_CTX_END);
    if (sIdx !== -1 && eIdx !== -1 && eIdx > sIdx) {
      const stripped = (content.slice(0, sIdx) + content.slice(eIdx + SHARED_CTX_END.length)).trim();
      if (stripped.length === 0) fs.unlinkSync(filePath);
      else fs.writeFileSync(filePath, stripped + '\n', 'utf8');
    }
  } catch {}
}

function syncCrossAppMemory() {
  try {
    const sorted = [...(appState.threads || [])]
      .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
    if (sorted.length === 0) return;

    // Keep top 5 recent threads in the on-demand file (zero prompt overhead until read)
    const pickedThreads = sorted.slice(0, 5);

    const sections = [];
    for (const t of pickedThreads) {
      loadThreadHistory(t, false);
      const msgs = (t.messages || []).filter((m) => m.content && m.content.trim());
      if (msgs.length === 0) continue;
      const ctxFile = writeContextFile(t, msgs);
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
      const lastAsst = [...msgs].reverse().find((m) => m.role === 'assistant');
      const userSummary = lastUser ? truncate(lastUser.content.replace(/\s+/g, ' ').trim(), 160) : '';
      const asstSummary = lastAsst ? truncate(lastAsst.content.replace(/\s+/g, ' ').trim(), 200) : '';
      sections.push(
        `### [${t.originatorLabel || t.origin || 'Hub'}] ${t.title || 'Untitled'}\n` +
        `- **Workspace:** \`${t.projectPath || DEFAULT_PROJECT_PATH}\` | **Updated:** ${t.updatedAt || 'recent'}\n` +
        `- **Transcript:** \`${ctxFile}\`\n` +
        (userSummary ? `- **Latest Request:** ${userSummary}\n` : '') +
        (asstSummary ? `- **Latest Outcome:** ${asstSummary}` : '')
      );
    }
    if (sections.length === 0) return;

    const liveSharedFile = path.join(DATA_DIR, 'LIVE_SHARED_CONTEXT.md');
    const digestBody = [
      '# Live Cross-App Shared Context (Antigravity + VS Code Codex + AI Studio Hub)',
      '> **Note for Agents:** Most recent cross-app state across Antigravity, VS Code, and Codex. For complete history, read the linked transcript file.',
      '',
      ...sections
    ].join('\n\n');

    const hash = crypto.createHash('sha1').update(digestBody).digest('hex');
    if (hash !== lastSyncedDigestHash) {
      lastSyncedDigestHash = hash;
      // 1. Write changing state ONLY to the external on-demand file so prompt caches are never invalidated
      fs.writeFileSync(liveSharedFile, digestBody, 'utf8');
    }

    // 2. Keep global AGENTS.md 100% STATIC (~35 tokens) so KV prefix cache hit rate stays 99%+ across turns
    const staticPointerBlock = [
      '# Cross-App Shared Context (Antigravity + VS Code Codex + AI Studio Hub)',
      `When the user refers to a recent conversation, plan, or change from another window/assistant, read \`${liveSharedFile}\` for the live cross-app summary and full transcript links.`
    ].join('\n');
    upsertSharedContextBlock(path.join(HOME, '.codex', 'AGENTS.md'), staticPointerBlock);
    upsertSharedContextBlock(path.join(HOME, '.gemini', 'config', 'rules', 'AGENTS.md'), staticPointerBlock);

    // 3. Clean up legacy duplicate blocks in .gemini/config/AGENTS.md and workspace AGENTS.md files
    stripSharedContextFromFile(path.join(HOME, '.gemini', 'config', 'AGENTS.md'));
    stripSharedContextFromFile(path.join(DEFAULT_PROJECT_PATH, 'AGENTS.md'));
    for (const p of appState.projects || []) {
      if (p.path) stripSharedContextFromFile(path.join(p.path, 'AGENTS.md'));
    }
  } catch (err) {
    console.error('[AI Hub] syncCrossAppMemory warning:', err.message);
  }
}

// ---------------------------------------------------------------------------
// 8c. Local App Mirror (Protects against Google Drive sync delays / unlinks)
// ---------------------------------------------------------------------------
const LOCAL_APP_MIRROR_DIR = path.join(DATA_DIR, 'app');

function syncLocalAppMirror() {
  try {
    // Only copy when running from a source outside the mirror itself
    if (path.resolve(__dirname).toLowerCase() === path.resolve(LOCAL_APP_MIRROR_DIR).toLowerCase()) return;
    const srcServer = path.join(__dirname, 'server.js');
    const srcIndex = path.join(__dirname, 'public', 'index.html');
    if (!fs.existsSync(srcServer) || !fs.existsSync(srcIndex)) return;
    fs.mkdirSync(path.join(LOCAL_APP_MIRROR_DIR, 'public'), { recursive: true });
    fs.copyFileSync(srcServer, path.join(LOCAL_APP_MIRROR_DIR, 'server.js'));
    fs.copyFileSync(srcIndex, path.join(LOCAL_APP_MIRROR_DIR, 'public', 'index.html'));
  } catch {}
}

// ---------------------------------------------------------------------------
// 9. Engine Runners (streamed to the UI over SSE + live re-attachable buffer)
// ---------------------------------------------------------------------------
const activeProcesses = new Map(); // threadId -> child process
const activeTurns = new Map(); // threadId -> { threadId, userPrompt, engine, model, statusText, accumulatedText, switchNotices, startedAt, subscribers: Set<res> }
const cancelledThreads = new Set();
const QUOTA_RE = /RESOURCE_EXHAUSTED|\b429\b|rate[ _-]?limit|quota (exceeded|exhausted|reached)|usage[ _-]?limit|out of credits|insufficient credits/i;

function getPublicActiveTurns() {
  const out = {};
  for (const [tid, turn] of activeTurns.entries()) {
    out[tid] = {
      threadId: turn.threadId,
      userPrompt: turn.userPrompt,
      engine: turn.engine,
      model: turn.model,
      statusText: turn.statusText,
      accumulatedText: turn.accumulatedText,
      narratives: turn.narratives || [],
      thinkingSteps: turn.thinkingSteps || [],
      switchNotices: turn.switchNotices,
      usage: turn.usage || null,
      startedAt: turn.startedAt
    };
  }
  return out;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    // Kill the whole tree so shell commands started by the agent stop too.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch {
    try {
      child.kill();
    } catch {}
  }
}

function cancelledError(partialText) {
  const e = new Error('Stopped by user');
  e.cancelled = true;
  e.partialText = partialText || '';
  return e;
}

function alignAgyModelAndEffort(modelId, effort) {
  const cleanEffort = ['low', 'medium', 'high'].includes(effort) ? effort : 'medium';
  if (!modelId) return { modelId: `gemini-4-argon-${cleanEffort}`, effort: cleanEffort };
  const replaced = modelId.replace(/-(low|medium|high)$/i, `-${cleanEffort}`);
  return { modelId: replaced, effort: cleanEffort };
}

function runAntigravityTurn({ thread, promptText, modelId, effort, mode, cwd, resumeSessionId, extraDirs = [], onEvent }) {
  return new Promise((resolve, reject) => {
    cancelledThreads.delete(thread.id);
    const aligned = alignAgyModelAndEffort(modelId, effort);
    const args = [
      '-p', promptText,
      '--output-format', 'stream-json',
      '--print-timeout', '60m',
      '--dangerously-skip-permissions',
      '--mode', mode === 'plan' ? 'plan' : 'accept-edits'
    ];
    if (aligned.modelId) args.push('--model', aligned.modelId);
    if (aligned.effort) args.push('--effort', aligned.effort);
    if (resumeSessionId) args.push('--conversation', resumeSessionId);
    for (const d of extraDirs) args.push('--add-dir', d);

    onEvent({ type: 'status', message: `Starting Antigravity (${aligned.modelId}${resumeSessionId ? ', resuming session' : ''})…` });

    const child = spawn(findAgyBinary(), args, { cwd: existsDir(cwd) ? cwd : HOME, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    activeProcesses.set(thread.id, child);

    let fullText = '';
    let conversationId = resumeSessionId || null;
    const estInput = Math.max(1, Math.round((promptText || '').length / 4));
    let usage = { input_tokens: estInput, output_tokens: 0, total_tokens: estInput, live: true };
    let gotStepUsage = false;
    let liveDeltaChars = 0;
    let finished = false;
    let buffer = '';
    let stderrText = '';
    let gotFirstOutput = false;

    onEvent({ type: 'usage', usage });

    const emitLiveDeltaUsage = (addedChars) => {
      liveDeltaChars += Math.max(0, addedChars || 0);
      const extraOut = Math.round(liveDeltaChars / 4);
      const baseIn = usage?.input_tokens || estInput;
      const baseOut = (usage?.output_tokens || 0) + extraOut;
      onEvent({
        type: 'usage',
        usage: {
          input_tokens: baseIn,
          output_tokens: baseOut,
          total_tokens: Math.max(usage?.total_tokens || 0, baseIn + baseOut),
          live: true
        }
      });
    };

    const startupTimer = setTimeout(() => {
      if (!gotFirstOutput && !finished) {
        const err = new Error(truncate(stderrText.trim(), 500) || 'Antigravity CLI timed out while starting (45s with no response).');
        if (QUOTA_RE.test(stderrText)) err.isQuotaError = true;
        settle(() => reject(err));
        killTree(child);
      }
    }, 45000);

    const settle = (fn) => {
      if (finished) return;
      finished = true;
      clearTimeout(startupTimer);
      activeProcesses.delete(thread.id);
      fn();
    };

    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      gotFirstOutput = true;
      let evt;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (evt.event === 'init') {
        if (evt.conversation_id) conversationId = evt.conversation_id;
        onEvent({ type: 'init', engine: 'antigravity', sessionId: conversationId });
      } else if (evt.event === 'step_update' && evt.step_update) {
        const su = evt.step_update;
        if (su.conversation_id) conversationId = su.conversation_id;
        if (su.thinking_delta) {
          onEvent({ type: 'thinking', delta: su.thinking_delta });
          emitLiveDeltaUsage(su.thinking_delta.length);
        }

        // Handle Antigravity CLI v2.26+ `step_type: "tool"` with `su.tool_info`
        if (su.step_type === 'tool' || su.tool_name || su.tool_info) {
          const tName = su.tool_info?.name || su.tool_name || 'tool';
          const tParams = su.tool_info?.parameters || su.tool_info?.args || {};
          const friendly = humanizeToolAction(tName, tParams);
          if (su.state === 'ACTIVE') {
            onEvent({ type: 'status', message: friendly });
            onEvent({ type: 'narrative', text: friendly });
            emitLiveDeltaUsage(120);
          }
          onEvent({ type: 'tool', name: summarizeToolCall(tName, tParams), status: su.state || 'RUNNING' });
        }

        for (const tc of su.tool_calls || []) {
          const friendly = humanizeToolAction(tc.name, tc.args || tc.arguments);
          onEvent({ type: 'status', message: friendly });
          onEvent({ type: 'narrative', text: friendly });
          onEvent({ type: 'tool', name: summarizeToolCall(tc.name, tc.args || tc.arguments), status: su.state || 'RUNNING' });
          emitLiveDeltaUsage(120);
        }

        if (su.text_delta) {
          fullText += su.text_delta;
          onEvent({ type: 'delta', delta: su.text_delta });
          emitLiveDeltaUsage(su.text_delta.length);
        } else if (su.step_type === 'agent_response' && su.state === 'DONE' && !fullText) {
          onEvent({ type: 'status', message: 'Thinking & planning next step…' });
        }
        if (su.usage) {
          const stepIn = Number(su.usage.input_tokens || 0) + Number(su.usage.cache_read_tokens || 0);
          const stepOut = Number(su.usage.output_tokens || 0) + Number(su.usage.thinking_tokens || 0);
          const prevIn = gotStepUsage ? (usage?.input_tokens || 0) : 0;
          const prevOut = gotStepUsage ? (usage?.output_tokens || 0) : 0;
          const nextIn = Math.max(prevIn, stepIn);
          const nextOut = prevOut + stepOut;
          gotStepUsage = true;
          liveDeltaChars = 0;
          usage = {
            input_tokens: nextIn,
            output_tokens: nextOut,
            thinking_tokens: (usage?.thinking_tokens || 0) + Number(su.usage.thinking_tokens || 0),
            cache_read_tokens: Math.max(usage?.cache_read_tokens || 0, Number(su.usage.cache_read_tokens || 0)),
            total_tokens: nextIn + nextOut
          };
          onEvent({ type: 'usage', usage });
        }
      } else if (evt.event === 'result' && evt.result) {
        const r = evt.result;
        if (r.conversation_id) conversationId = r.conversation_id;
        // NOTE: r.usage in Antigravity CLI is cumulative across the entire conversation history when resuming.
        // Only use r.usage if we did not already collect per-step usage for this turn.
        if (r.usage && !gotStepUsage) {
          usage = r.usage;
          onEvent({ type: 'usage', usage });
        }
        if (r.response && r.response.trim()) {
          fullText = r.response.trim();
          onEvent({ type: 'replace_delta', text: fullText });
        } else if (!fullText && r.response) {
          fullText = r.response;
          onEvent({ type: 'delta', delta: fullText });
        }
        settle(() => {
          // Check if fullText or r.error or r.status is actually a quota / rate limit failure
          const combined = `${r.error || ''} ${r.status || ''} ${fullText || ''}`;
          if (QUOTA_RE.test(combined)) {
            const err = new Error(r.error || fullText.trim() || 'Individual quota reached');
            err.isQuotaError = true;
            return reject(err);
          }
          // NOTE: Antigravity CLI returns `r.status: "ERROR"` with a historical `r.error` string whenever a resumed
          // conversation had *any* failed step in its past history, even when the current turn produced a valid `fullText`!
          // Only treat it as an error if the current turn produced no text output.
          if (r.status && r.status !== 'SUCCESS' && !fullText.trim()) {
            const err = new Error(r.error || `Antigravity finished with status ${r.status}`);
            return reject(err);
          } else {
            resolve({ text: fullText.trim() || '(Task completed with no text output)', conversationId, usage });
          }
        });
        killTree(child);
      }
    };

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const l of lines) handleLine(l);
    });
    child.stderr.on('data', (chunk) => {
      stderrText = (stderrText + chunk.toString()).slice(-4000);
    });
    child.on('error', (err) => settle(() => reject(err)));
    child.on('close', (code) => {
      if (buffer.trim()) handleLine(buffer);
      settle(() => {
        if (cancelledThreads.delete(thread.id)) return reject(cancelledError(fullText));
        const combined = `${stderrText || ''} ${fullText || ''}`;
        if (QUOTA_RE.test(combined)) {
          const err = new Error(truncate(stderrText.trim() || fullText.trim(), 600) || 'Individual quota reached');
          err.isQuotaError = true;
          return reject(err);
        }
        if (fullText.trim()) return resolve({ text: fullText.trim(), conversationId, usage });
        const err = new Error(truncate(stderrText.trim(), 600) || `Antigravity exited with code ${code}`);
        reject(err);
      });
    });
  });
}

function runCodexTurn({ thread, promptText, modelSlug, effort, mode, cwd, resumeSessionId, forkSessionId, attachments, onEvent }) {
  return new Promise((resolve, reject) => {
    cancelledThreads.delete(thread.id);
    const args = ['exec'];
    const subSessionId = resumeSessionId || forkSessionId || null;
    if (resumeSessionId) args.push('resume', resumeSessionId);
    else if (forkSessionId) args.push('fork', forkSessionId);
    args.push('--json', '--skip-git-repo-check');
    // `exec resume` and `exec fork` reject -C and -s; the working directory comes from the process cwd instead.
    if (!subSessionId && existsDir(cwd)) args.push('-C', cwd);
    if (modelSlug) args.push('-m', modelSlug);
    if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
    if (mode === 'plan') {
      args.push(...(subSessionId ? ['-c', 'sandbox_mode=read-only'] : ['-s', 'read-only']));
    } else {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }
    for (const att of attachments || []) {
      if (att.path && /\.(png|jpe?g|webp|gif)$/i.test(att.path) && fs.existsSync(att.path)) args.push('-i', att.path);
    }
    // Pass `-` to read prompt from stdin, completely bypassing Windows 32k CreateProcessW command-line limits!
    args.push('-');

    const modeTag = resumeSessionId ? ', resuming session' : forkSessionId ? ', cloning active session' : '';
    onEvent({
      type: 'status',
      message: `Starting OpenAI Codex (${modelSlug || 'default'} • ${effort || 'default'}${modeTag})…`
    });

    const child = spawn(getCodexBin(), args, { cwd: existsDir(cwd) ? cwd : HOME, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    // Pipe prompt via stdin and close immediately so Codex never stalls on Windows
    child.stdin.on('error', () => {});
    child.stdin.end(promptText, 'utf8');
    activeProcesses.set(thread.id, child);

    let fullText = '';
    let lastCommentary = '';
    let sessionId = resumeSessionId || null;
    const estInput = Math.max(1, Math.round((promptText || '').length / 4));
    let usage = { input_tokens: estInput, output_tokens: 0, total_tokens: estInput, live: true };
    let gotRolloutUsage = false;
    let liveExtraOut = 0;
    let finished = false;
    let buffer = '';
    let lastError = '';
    let stderrText = '';
    let gotFirstOutput = false;

    // Read baseline cumulative tokens before this turn starts so we report THIS turn's tokens, not lifetime session totals
    let baselineTotal = null;
    if (subSessionId) {
      try {
        const baseRf = findCodexRollout(subSessionId);
        if (baseRf && fs.existsSync(baseRf)) {
          forEachJsonlLine(baseRf, (o) => {
            if (o.type === 'event_msg' && o.payload?.type === 'token_count' && o.payload?.info?.total_token_usage) {
              baselineTotal = o.payload.info.total_token_usage;
            }
          }, 64 * 1024);
        }
      } catch {}
    }

    onEvent({ type: 'usage', usage });

    const bumpLiveCodexTokens = (extraTokens) => {
      liveExtraOut += Math.max(0, extraTokens || 0);
      const baseIn = usage?.input_tokens || estInput;
      const baseOut = (usage?.output_tokens || 0) + liveExtraOut;
      onEvent({
        type: 'usage',
        usage: {
          input_tokens: baseIn,
          output_tokens: baseOut,
          total_tokens: Math.max(usage?.total_tokens || 0, baseIn + baseOut),
          live: true
        }
      });
    };

    const pollCodexRolloutTokens = () => {
      if (!sessionId || finished) return;
      try {
        const rf = findCodexRollout(sessionId);
        if (!rf || !fs.existsSync(rf)) return;
        let lastRec = null;
        let lastTot = null;
        forEachJsonlLine(rf, (o) => {
          if (o.type === 'token_usage_record') {
            lastRec = o.payload || o;
          } else if (o.type === 'event_msg' && o.payload?.type === 'token_count' && o.payload?.info) {
            if (o.payload.info.last_token_usage) lastRec = o.payload.info.last_token_usage;
            if (o.payload.info.total_token_usage) lastTot = o.payload.info.total_token_usage;
          }
        }, 64 * 1024);
        if (lastRec && (lastRec.input_tokens || lastRec.total_tokens)) {
          const stepIn = Number(lastRec.input_tokens || 0);
          const stepOut = Number(lastRec.output_tokens || 0);
          const turnOutDelta = (baselineTotal && lastTot && lastTot.output_tokens >= baselineTotal.output_tokens)
            ? Number(lastTot.output_tokens - baselineTotal.output_tokens)
            : stepOut;
          const nextIn = stepIn;
          const nextOut = Math.max(stepOut, turnOutDelta);
          gotRolloutUsage = true;
          liveExtraOut = 0;
          usage = {
            input_tokens: nextIn,
            output_tokens: nextOut,
            cached_input_tokens: Number(lastRec.cached_input_tokens || 0),
            total_tokens: nextIn + nextOut,
            live: true
          };
          onEvent({ type: 'usage', usage });
        }
      } catch {}
    };

    const rolloutPollTimer = setInterval(pollCodexRolloutTokens, 2500);

    const startupTimer = setTimeout(() => {
      if (!gotFirstOutput && !finished) {
        const err = new Error(truncate(stderrText.trim(), 500) || 'Codex CLI timed out while starting (45s with no response).');
        if (QUOTA_RE.test(stderrText)) err.isQuotaError = true;
        settle(() => reject(err));
        killTree(child);
      }
    }, 45000);

    const settle = (fn) => {
      if (finished) return;
      finished = true;
      clearTimeout(startupTimer);
      clearInterval(rolloutPollTimer);
      activeProcesses.delete(thread.id);
      fn();
    };

    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      gotFirstOutput = true;
      let evt;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (evt.type === 'thread.started' && evt.thread_id) {
        sessionId = evt.thread_id;
        onEvent({ type: 'init', engine: 'codex', sessionId });
        pollCodexRolloutTokens();
      } else if (evt.type === 'item.started' && evt.item) {
        if (evt.item.type === 'command_execution') {
          onEvent({ type: 'status', message: 'Running actions...' });
          bumpLiveCodexTokens(35);
        } else if (evt.item.type === 'reasoning') {
          onEvent({ type: 'status', message: 'Thinking...' });
          bumpLiveCodexTokens(25);
        }
      } else if (evt.type === 'item.completed' && evt.item) {
        const item = evt.item;
        pollCodexRolloutTokens();
        if (item.type === 'agent_message' && item.text) {
          const isCommentary = item.phase === 'commentary';
          bumpLiveCodexTokens(Math.max(10, Math.round(item.text.length / 4)));
          if (isCommentary) {
            const cleanText = item.text.trim();
            lastCommentary = cleanText;
            const firstLine = cleanText.split('\n')[0].replace(/^#+\s*/, '').trim();
            if (firstLine) onEvent({ type: 'status', message: truncate(firstLine, 80) });
            if (cleanText) onEvent({ type: 'narrative', text: cleanText });
          } else {
            fullText = item.text;
            onEvent({ type: 'replace_delta', text: item.text });
          }
        } else if (item.type === 'command_execution') {
          onEvent({ type: 'status', message: 'Working on solution...' });
          bumpLiveCodexTokens(45);
        } else if (item.type === 'file_change') {
          const changedFiles = item.changes ? Object.keys(item.changes).map((f) => path.basename(f)).join(', ') : '';
          const msg = changedFiles ? `Edited ${changedFiles}` : 'Applying file changes...';
          onEvent({ type: 'status', message: msg });
          onEvent({ type: 'narrative', text: msg });
          bumpLiveCodexTokens(50);
        } else if (item.type === 'error' && item.message && !item.message.includes('Model metadata for')) {
          lastError = item.message;
        }
      } else if (evt.type === 'turn.completed') {
        pollCodexRolloutTokens();
        if (evt.usage && !gotRolloutUsage) {
          const rawIn = Number(evt.usage.input_tokens || 0);
          const rawOut = Number(evt.usage.output_tokens || 0);
          const inTok = (baselineTotal && rawIn > baselineTotal.input_tokens) ? (rawIn - baselineTotal.input_tokens) : rawIn;
          const outTok = (baselineTotal && rawOut >= baselineTotal.output_tokens) ? (rawOut - baselineTotal.output_tokens) : rawOut;
          usage = {
            input_tokens: inTok,
            cached_input_tokens: Number(evt.usage.cached_input_tokens || 0),
            output_tokens: outTok,
            total_tokens: inTok + outTok
          };
          onEvent({ type: 'usage', usage });
        } else if (usage) {
          delete usage.live;
          onEvent({ type: 'usage', usage });
        }
        if (!fullText && lastCommentary) fullText = lastCommentary;
        settle(() => {
          resolve({ text: fullText.trim() || '(Task completed)', sessionId, usage });
        });
        killTree(child);
      } else if (evt.type === 'error') {
        lastError = evt.message || lastError;
      } else if (evt.type === 'turn.failed') {
        const msg = evt.error?.message || lastError || 'Codex turn failed';
        settle(() => {
          const err = new Error(msg);
          err.partialText = (fullText || lastCommentary || '').trim();
          err.hadStepProgress = Boolean(fullText || lastCommentary || gotFirstOutput);
          if (QUOTA_RE.test(msg)) err.isQuotaError = true;
          reject(err);
        });
        killTree(child);
      }
    };

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const l of lines) handleLine(l);
    });
    child.stderr.on('data', (chunk) => {
      stderrText = (stderrText + chunk.toString()).slice(-4000);
    });
    child.on('error', (err) => settle(() => reject(err)));
    child.on('close', (code) => {
      if (buffer.trim()) handleLine(buffer);
      if (!fullText && lastCommentary) fullText = lastCommentary;
      settle(() => {
        if (cancelledThreads.delete(thread.id)) return reject(cancelledError(fullText));
        const combined = `${stderrText || ''} ${lastError || ''} ${fullText || ''}`;
        if (QUOTA_RE.test(combined)) {
          const err = new Error(lastError || truncate(stderrText.trim() || fullText.trim(), 600) || 'Quota exhausted');
          err.isQuotaError = true;
          return reject(err);
        }
        if (fullText.trim() || code === 0) return resolve({ text: fullText.trim() || '(Task completed)', sessionId, usage });
        const errLine = stderrText.split('\n').find((l) => /^error[:\s]/i.test(l.trim()));
        const msg = lastError || (errLine ? errLine.trim() : '') || `Codex exited with code ${code}`;
        const err = new Error(msg);
        reject(err);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// 10. Native Folder Picker & Workspace Listing
// ---------------------------------------------------------------------------
function openNativeFolderDialog() {
  return runPowerShell(
    `Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.FolderBrowserDialog
$f.Description = "Select Project Working Directory"
$f.ShowNewFolderButton = $true
$top = New-Object System.Windows.Forms.Form
$top.TopMost = $true
if ($f.ShowDialog($top) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }`,
    { timeoutMs: 10 * 60 * 1000, sta: true }
  ).then((out) => out || null);
}

function listWorkspaceFiles(dirPath) {
  if (!existsDir(dirPath)) return { files: [], gitStatus: '' };
  const items = [];
  try {
    for (const e of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (e.name.startsWith('.git') || e.name === 'node_modules' || e.name === '__pycache__') continue;
      const full = path.join(dirPath, e.name);
      let size = 0;
      try {
        if (!e.isDirectory()) size = fs.statSync(full).size;
      } catch {}
      items.push({ name: e.name, path: full, isDirectory: e.isDirectory(), size });
    }
    items.sort((a, b) => b.isDirectory - a.isDirectory || a.name.localeCompare(b.name));
  } catch {}

  let gitStatus = '';
  try {
    gitStatus = execFileSync('git', ['status', '--short'], {
      cwd: dirPath,
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {}
  return { files: items.slice(0, 150), gitStatus };
}

// ---------------------------------------------------------------------------
// 10b. Cloudflare Tunnel Manager (Secure Mobile & Remote Access)
// ---------------------------------------------------------------------------
let tunnelProcess = null;
let tunnelUrl = null;
let tunnelHostname = null;
let tunnelStatus = 'inactive'; // 'inactive' | 'starting' | 'active' | 'error'
let tunnelError = null;

function findCloudflaredBin() {
  const p1 = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
  const p2 = 'C:\\Program Files\\cloudflared\\cloudflared.exe';
  if (fs.existsSync(p1)) return p1;
  if (fs.existsSync(p2)) return p2;
  return 'cloudflared';
}

function startCloudflareTunnel() {
  if (tunnelProcess && !tunnelProcess.killed && tunnelUrl) {
    return Promise.resolve({ running: true, url: tunnelUrl, status: tunnelStatus, pin: appState.settings.mobilePin });
  }
  tunnelStatus = 'starting';
  tunnelError = null;

  return new Promise((resolve) => {
    try {
      const bin = findCloudflaredBin();
      const child = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      tunnelProcess = child;

      let resolved = false;
      const onUrlFound = (url) => {
        if (resolved) return;
        resolved = true;
        tunnelUrl = url;
        try {
          const u = new URL(url);
          tunnelHostname = u.host.toLowerCase();
          ALLOWED_HOSTS.add(tunnelHostname);
          ALLOWED_ORIGINS.add(`https://${tunnelHostname}`);
          ALLOWED_ORIGINS.add(`http://${tunnelHostname}`);
        } catch {}
        tunnelStatus = 'active';
        console.log(`[AI Hub] 📱 Cloudflare Tunnel Live: ${tunnelUrl}`);
        registerWithGateway(tunnelUrl);
        resolve({ running: true, url: tunnelUrl, status: tunnelStatus, pin: appState.settings.mobilePin });
      };

      const handleOutput = (chunk) => {
        const text = chunk.toString();
        const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (m) onUrlFound(m[0]);
      };

      child.stdout.on('data', handleOutput);
      child.stderr.on('data', handleOutput);

      child.on('error', (err) => {
        tunnelStatus = 'error';
        tunnelError = err.message;
        if (!resolved) {
          resolved = true;
          resolve({ running: false, error: err.message, status: tunnelStatus, pin: appState.settings.mobilePin });
        }
      });

      child.on('close', (code) => {
        if (tunnelHostname) {
          ALLOWED_HOSTS.delete(tunnelHostname);
          ALLOWED_ORIGINS.delete(`https://${tunnelHostname}`);
          ALLOWED_ORIGINS.delete(`http://${tunnelHostname}`);
        }
        tunnelProcess = null;
        tunnelUrl = null;
        tunnelHostname = null;
        tunnelStatus = 'inactive';
        if (!resolved) {
          resolved = true;
          resolve({ running: false, error: `cloudflared exited with code ${code}`, status: tunnelStatus, pin: appState.settings.mobilePin });
        }
      });

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve({ running: false, error: 'Tunnel startup timed out (30s)', status: tunnelStatus, pin: appState.settings.mobilePin });
        }
      }, 30000);
    } catch (e) {
      tunnelStatus = 'error';
      tunnelError = e.message;
      resolve({ running: false, error: e.message, status: tunnelStatus, pin: appState.settings.mobilePin });
    }
  });
}

function stopCloudflareTunnel() {
  if (tunnelProcess) {
    killTree(tunnelProcess);
    tunnelProcess = null;
  }
  if (tunnelHostname) {
    ALLOWED_HOSTS.delete(tunnelHostname);
    ALLOWED_ORIGINS.delete(`https://${tunnelHostname}`);
    ALLOWED_ORIGINS.delete(`http://${tunnelHostname}`);
  }
  tunnelUrl = null;
  tunnelHostname = null;
  tunnelStatus = 'inactive';
  return { running: false, status: 'inactive', pin: appState.settings.mobilePin };
}

async function registerWithGateway(url) {
  // 1. Write active tunnel descriptor locally and sync to GitHub
  try {
    const activeFile = path.join(__dirname, 'public', 'active-tunnel.json');
    fs.writeFileSync(activeFile, JSON.stringify({ url, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
    const child = spawn('git', ['add', 'public/active-tunnel.json'], { cwd: __dirname, windowsHide: true });
    child.on('close', () => {
      const c2 = spawn('git', ['commit', '-m', 'auto: update active tunnel URL'], { cwd: __dirname, windowsHide: true });
      c2.on('close', () => {
        spawn('git', ['push', 'origin', 'main'], { cwd: __dirname, windowsHide: true });
      });
    });
  } catch {}

  // 2. Register with Cloudflare Gateway Worker if active
  const gatewayUrl = 'https://ai-studio-hub.mojtaba-safdari-mm.workers.dev';
  const gatewaySecret = '8fa19e8ed7ade397c28256f1d21b7a59ced45297a365c9d9';
  try {
    const res = await fetch(`${gatewayUrl}/_gateway/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${gatewaySecret}`
      },
      body: JSON.stringify({ url })
    });
    if (res.ok) {
      console.log(`[AI Hub] 🌟 Permanent Gateway registered: ${gatewayUrl}`);
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// 11. Chat Turn Orchestration (engine choice, in-engine fallback, failover, cancel)
// ---------------------------------------------------------------------------
function pickAgyModel(agyStatus, { excludeFamily, preferredEffort, threshold }) {
  const pools = new Map();
  for (const m of agyStatus.models) {
    if (m.family === excludeFamily) continue;
    const pct = m.remainingPct ?? 100;
    if (pct < threshold) continue;
    if (!pools.has(m.family)) pools.set(m.family, { pct, models: [] });
    pools.get(m.family).models.push(m);
  }
  const best = [...pools.values()].sort((a, b) => b.pct - a.pct)[0];
  if (!best) return null;
  return best.models.find((m) => m.effort === preferredEffort) || best.models.find((m) => m.effort === 'medium') || best.models[0];
}

function rememberSession(thread, engine, id, syncedMsgCount) {
  if (!id) return;
  if (engine === 'antigravity') {
    thread.agyConversationId = id;
    if (typeof syncedMsgCount === 'number') thread.agySyncedMsgCount = syncedMsgCount;
  } else {
    thread.codexSessionId = id;
    if (typeof syncedMsgCount === 'number') thread.codexSyncedMsgCount = syncedMsgCount;
  }
  if (id !== thread.nativeSource?.id) {
    thread.hubSessionIds = thread.hubSessionIds || [];
    if (!thread.hubSessionIds.includes(id)) thread.hubSessionIds.push(id);
  }
  thread.pendingCompact = false;
  thread.compactedFromTokens = 0;
}

function sanitizeAttachments(list) {
  return (Array.isArray(list) ? list : [])
    .filter((a) => a && a.path && fs.existsSync(a.path))
    .filter((a) => isInside(normalizeWinPath(a.path), ATTACH_DIR) || isAllowedWorkspacePath(a.path))
    .map((a) => ({ name: String(a.name || path.basename(a.path)), path: normalizeWinPath(a.path), size: a.size }));
}

function subscribeSseResponse(res, liveTurn) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  liveTurn.subscribers.add(res);
  const hb = setInterval(() => {
    if (!res.writableEnded) {
      try {
        res.write(': keepalive\n\n');
      } catch {}
    }
  }, 10000);
  res.on('close', () => {
    clearInterval(hb);
    liveTurn.subscribers.delete(res);
  });
}

async function handleChat(req, res, body) {
  const { threadId, prompt = '', engineMode = 'auto', agyModel, agyEffort, codexModel, codexEffort, executionMode = 'agent' } = body;
  const thread = appState.threads.find((t) => t.id === threadId);
  if (!thread) return sendJson(res, 404, { error: 'Thread not found' });
  if (activeProcesses.has(thread.id) || activeTurns.has(thread.id)) {
    return sendJson(res, 409, { error: 'A turn is already running in this chat.' });
  }

  const attachments = sanitizeAttachments(body.attachments);
  loadThreadHistory(thread);

  if (String(prompt || '').trim().toLowerCase() === '/compact') {
    const info = compactThreadSession(thread, 'slash-command');
    saveState(appState);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    const prevK = info?.prevTokens ? `${Math.round(info.prevTokens / 1000)}k` : 'active';
    const assistantMsg = {
      id: crypto.randomUUID(),
      role: 'assistant',
      engine: engineMode === 'antigravity' ? 'antigravity' : 'codex',
      model: 'Context Compactor',
      content: `🧹 **Context compacted (${prevK} → ~2k tokens).**\n\nYour full conversation history stays visible right here, and your next message will start a fresh, lightweight engine session seeded with your \`CHECKPOINT.md\` and last 4 turns — cutting per-step token usage by up to **90%**.`,
      narratives: [],
      thinkingSteps: [],
      actions: [],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      fromHub: true,
      timestamp: new Date().toISOString()
    };
    res.write(`data: ${JSON.stringify({ type: 'done', message: assistantMsg, thread })}\n\n`);
    return res.end();
  }

  const liveTurn = {
    threadId: thread.id,
    userPrompt: prompt,
    engine: engineMode,
    model: engineMode === 'codex' ? codexModel : agyModel,
    statusText: 'Connecting to engine…',
    accumulatedText: '',
    narratives: [],
    thinkingSteps: [],
    switchNotices: [],
    usage: { input_tokens: Math.max(1, Math.round((prompt || '').length / 4)), output_tokens: 0, total_tokens: Math.max(1, Math.round((prompt || '').length / 4)), live: true },
    startedAt: new Date().toISOString(),
    subscribers: new Set()
  };
  activeTurns.set(thread.id, liveTurn);
  subscribeSseResponse(res, liveTurn);

  const sendEvent = (obj) => {
    if (obj.type === 'status' && obj.message) liveTurn.statusText = obj.message;
    else if (obj.type === 'delta' && obj.delta) liveTurn.accumulatedText += obj.delta;
    else if (obj.type === 'replace_delta' && typeof obj.text === 'string') liveTurn.accumulatedText = obj.text;
    else if (obj.type === 'narrative' && obj.text && !liveTurn.narratives.includes(obj.text)) liveTurn.narratives.push(obj.text);
    else if (obj.type === 'thinking' && obj.delta && obj.delta.trim() && !liveTurn.thinkingSteps.includes(obj.delta.trim())) liveTurn.thinkingSteps.push(obj.delta.trim());
    else if (obj.type === 'switch_notice' && obj.message) liveTurn.switchNotices.push(obj.message);
    else if (obj.type === 'usage' && obj.usage) liveTurn.usage = obj.usage;
    else if (obj.type === 'init' && obj.engine) liveTurn.engine = obj.engine;

    const payload = `data: ${JSON.stringify(obj)}\n\n`;
    for (const sub of liveTurn.subscribers) {
      if (!sub.writableEnded) {
        try {
          sub.write(payload);
        } catch {}
      }
    }
  };

  const closeAllSubscribers = () => {
    activeTurns.delete(thread.id);
    for (const sub of liveTurn.subscribers) {
      if (!sub.writableEnded) {
        try {
          sub.end();
        } catch {}
      }
    }
    liveTurn.subscribers.clear();
  };

  sendEvent({ type: 'status', message: 'Connecting to engine…' });

  const threshold = Number(appState.settings.autoSwitchThresholdPct) || 12;
  const [agyStatus, codexStatus] = await Promise.all([getAgyStatus(), Promise.resolve(getCodexStatus())]);
  const agyModelPct = (id) => agyStatus.models.find((m) => m.modelId === id)?.remainingPct ?? 100;
  const agyFamily = (id) => agyStatus.models.find((m) => m.modelId === id)?.family;
  const codexPct = Math.min(codexStatus.fiveHourWindow.remainingPct, codexStatus.weeklyWindow.remainingPct);

  const lastAssistant = [...thread.messages].reverse().find((m) => m.role === 'assistant');
  const nativeEngine = thread.origin === 'vscode' || thread.origin === 'codex' ? 'codex' : 'antigravity';
  const defaultEngine = lastAssistant?.engine || nativeEngine;

  let engine = engineMode === 'auto' ? defaultEngine : engineMode;
  let agyModelToUse = agyModel;
  let agyEffortToUse = agyEffort;
  let codexEffortToUse = codexEffort;
  let handoffReason = null;

  const promptIntent = classifyPromptIntent(prompt, attachments);
  if (promptIntent.isLightweightQuestion) {
    const targetEff = promptIntent.suggestedEffort || 'low';
    if (codexEffortToUse === 'high' || codexEffortToUse === 'xhigh' || (codexEffortToUse === 'medium' && targetEff === 'low')) {
      codexEffortToUse = targetEff;
    }
    if (agyEffortToUse === 'high' || (agyEffortToUse === 'medium' && targetEff === 'low')) {
      agyEffortToUse = targetEff;
      const fam = agyFamily(agyModelToUse);
      const lighterModel = agyStatus.models.find((m) => m.family === fam && m.effort === targetEff && (m.remainingPct ?? 100) >= threshold);
      if (lighterModel) agyModelToUse = lighterModel.modelId;
    }
  }

  if (engineMode === 'auto') {
    if (engine === 'antigravity' && agyModelPct(agyModel) < threshold) {
      // Try another Antigravity model family first: cheaper than a cross-engine handoff.
      const alt = pickAgyModel(agyStatus, { excludeFamily: agyFamily(agyModel), preferredEffort: agyEffort, threshold });
      if (alt) {
        agyModelToUse = alt.modelId;
        agyEffortToUse = alt.effort;
        sendEvent({ type: 'switch_notice', message: `Switched model inside Antigravity: ${agyModel} (${agyModelPct(agyModel)}% left) → ${alt.label} (${alt.remainingPct}% left).` });
      } else if (codexPct >= threshold) {
        engine = 'codex';
        handoffReason = `Auto-switched from Antigravity (all models below ${threshold}%) to Codex (${codexPct}% left).`;
        sendEvent({ type: 'switch_notice', message: handoffReason });
      }
    } else if (engine === 'codex' && codexPct < threshold) {
      const target = agyModelPct(agyModel) >= threshold ? agyStatus.models.find((m) => m.modelId === agyModel) : pickAgyModel(agyStatus, { preferredEffort: agyEffort, threshold });
      if (target) {
        engine = 'antigravity';
        agyModelToUse = target.modelId;
        agyEffortToUse = target.effort;
        handoffReason = `Auto-switched from Codex (${codexPct}% left) to Antigravity ${target.label} (${target.remainingPct ?? 100}% left).`;
        sendEvent({ type: 'switch_notice', message: handoffReason });
      }
    }
  } else {
    // Even in manual mode, pre-flight check 0% exhausted models so we never spawn a dead CLI that hangs
    if (engine === 'antigravity' && agyModelPct(agyModel) <= 0) {
      const alt = pickAgyModel(agyStatus, { excludeFamily: agyFamily(agyModel), preferredEffort: agyEffort, threshold: 1 });
      if (alt) {
        agyModelToUse = alt.modelId;
        agyEffortToUse = alt.effort;
        sendEvent({ type: 'switch_notice', message: `${agyModel} has 0% quota remaining. Switched to ${alt.label} (${alt.remainingPct}% left).` });
      } else if (codexPct > 0) {
        engine = 'codex';
        handoffReason = `All Antigravity models are at 0% quota. Automatically failed over to Codex (${codexPct}% left).`;
        sendEvent({ type: 'switch_notice', message: handoffReason });
      }
    } else if (engine === 'codex' && codexPct <= 0) {
      const alt = pickAgyModel(agyStatus, { preferredEffort: agyEffort, threshold: 1 });
      if (alt) {
        engine = 'antigravity';
        agyModelToUse = alt.modelId;
        agyEffortToUse = alt.effort;
        handoffReason = `Codex is at 0% quota. Automatically failed over to Antigravity ${alt.label} (${alt.remainingPct}% left).`;
        sendEvent({ type: 'switch_notice', message: handoffReason });
      }
    } else if (lastAssistant && lastAssistant.engine !== engine) {
      handoffReason = `Switched from ${lastAssistant.engine} to ${engine}; conversation history bridged automatically.`;
      sendEvent({ type: 'switch_notice', message: handoffReason });
    }
  }

  liveTurn.engine = engine;
  liveTurn.model = engine === 'antigravity' ? agyModelToUse : codexModel;

  const autopilotCfg = detectAutopilotLoop(prompt, Boolean(body.autopilot));
  let currentStepIdx = 1;
  let currentPromptText = prompt.replace(/^\/(loop|goal)\s*/i, '').trim() || 'Continue to the next step and save checkpoint.';
  let currentAttachments = attachments;
  let history = [...thread.messages];
  let userMsg = { id: crypto.randomUUID(), role: 'user', content: currentPromptText, attachments: currentAttachments, fromHub: true, timestamp: new Date().toISOString() };
  if (thread.title === 'New Unified Session') {
    thread.title = currentPromptText.slice(0, 48) + (currentPromptText.length > 48 ? '…' : '');
    saveState(appState);
  }

  if (autopilotCfg.enabled) {
    sendEvent({
      type: 'switch_notice',
      message: `🔁 Autopilot Loop Active (Target: ${autopilotCfg.targetUsedPct}% quota used) — running one bounded step per turn and auto-compacting between steps so overnight runs never time out.`
    });
  }

  const execute = async (eng, model, effort, reason, promptOverride = null) => {
    liveTurn.engine = eng;
    liveTurn.model = model;
    const decision = resumeDecision({ ...thread, messages: history }, eng);
    if (!promptOverride) {
      if (promptIntent.isLightweightQuestion && !autopilotCfg.enabled) {
        sendEvent({
          type: 'switch_notice',
          message: `⚡ Smart Question Routing: Status/info question detected — scaled reasoning effort to ${String(effort || 'low').toUpperCase()} & skipped heavy test sweeps to save your quota.`
        });
      }
      if (decision.compact) {
        const prevK = decision.prevTokens ? `${Math.round(decision.prevTokens / 1000)}k` : 'heavy';
        sendEvent({
          type: 'switch_notice',
          message: `🧹 Context ${decision.reason === 'auto-compact' ? 'auto-' : ''}compacted (${prevK} → ~2k tokens). Starting a fresh checkpoint session with your recent turns and CHECKPOINT.md so every step costs ~90% fewer tokens.`
        });
      } else if (decision.reason === 'open-elsewhere') {
        sendEvent({ type: 'switch_notice', message: `This chat is open in Antigravity right now, so the hub continues in a fresh session with the full context. The original is left untouched.` });
      } else if (decision.reason === 'open-elsewhere-fork') {
        sendEvent({ type: 'switch_notice', message: `This chat is open in VS Code / Codex right now; cloning its live session via native fork so both windows can work without lock conflicts.` });
      }
    }
    const autopilotStep = autopilotCfg.enabled
      ? { step: currentStepIdx, maxSteps: autopilotCfg.maxSteps, targetUsedPct: autopilotCfg.targetUsedPct }
      : null;
    const { prompt: promptText, usedBriefing } = promptOverride
      ? { prompt: promptOverride, usedBriefing: false }
      : buildEnginePrompt({ thread, history, userPrompt: currentPromptText, attachments: currentAttachments, engine: eng, decision, handoffReason: reason, lightweightHint: promptIntent.isLightweightQuestion && !autopilotCfg.enabled, autopilotStep });
    const actions = [];
    const narratives = [...(liveTurn.narratives || [])];
    const thinkingSteps = [...(liveTurn.thinkingSteps || [])];
    let hadStepProgress = false;
    const onEvent = (evt) => {
      if (evt.type === 'init' && evt.sessionId) {
        rememberSession(thread, eng, evt.sessionId, history.length);
        saveState(appState);
      }
      if (evt.type === 'tool' && evt.name) {
        hadStepProgress = true;
        if (!actions.includes(evt.name)) actions.push(evt.name);
      }
      if (evt.type === 'narrative' && evt.text) {
        hadStepProgress = true;
        if (!narratives.includes(evt.text)) narratives.push(evt.text);
      }
      if (evt.type === 'thinking' && evt.delta && evt.delta !== 'Reasoning…') {
        hadStepProgress = true;
        const clean = evt.delta.trim();
        if (clean && !thinkingSteps.includes(clean)) thinkingSteps.push(clean);
      }
      sendEvent(evt);
    };

    try {
      if (eng === 'antigravity') {
        const extraDirs = [];
        if (usedBriefing) extraDirs.push(CONTEXT_DIR);
        if (currentAttachments.some((a) => isInside(a.path, ATTACH_DIR))) extraDirs.push(ATTACH_DIR);
        const r = await runAntigravityTurn({ thread, promptText, modelId: model, effort, mode: executionMode, cwd: thread.projectPath, resumeSessionId: decision.resume ? decision.sessionId : null, extraDirs, onEvent });
        rememberSession(thread, 'antigravity', r.conversationId, history.length);
        return { engine: eng, model: `${model} (${effort})`, text: r.text, usage: r.usage, actions: actions.slice(-25), narratives, thinkingSteps: thinkingSteps.slice(-15) };
      }
      const r = await runCodexTurn({
        thread,
        promptText,
        modelSlug: model,
        effort: effort,
        mode: executionMode,
        cwd: thread.projectPath,
        resumeSessionId: decision.resume ? decision.sessionId : null,
        forkSessionId: decision.fork ? decision.sessionId : null,
        attachments: currentAttachments,
        onEvent
      });
      rememberSession(thread, 'codex', r.sessionId, history.length);
      return { engine: eng, model: `${model} (${effort})`, text: r.text, usage: r.usage, actions: actions.slice(-25), narratives, thinkingSteps: thinkingSteps.slice(-15) };
    } catch (runErr) {
      runErr.hadStepProgress = hadStepProgress || Boolean(runErr.hadStepProgress);
      if (!runErr.partialText) {
        runErr.partialText = (liveTurn.accumulatedText || narratives[narratives.length - 1] || '').trim();
      }
      runErr.actions = actions.slice(-25);
      throw runErr;
    }
  };

  const commitTurnMessages = (result, reason, note) => {
    const cleanText = String(result.text || '').replace(/\[AUTOPILOT_DONE\]/gi, '').trim();
    const cleanNarratives = (result.narratives || []).filter((n) => n && n.trim() && n.trim() !== cleanText);
    const assistantMsg = {
      id: crypto.randomUUID(),
      role: 'assistant',
      engine: result.engine,
      model: result.model,
      content: note ? `${cleanText}\n\n_${note}_` : cleanText,
      narratives: cleanNarratives,
      thinkingSteps: result.thinkingSteps || [],
      actions: result.actions || [],
      usage: result.usage,
      handoffReason: reason,
      fromHub: true,
      timestamp: new Date().toISOString()
    };
    thread.messages.push(userMsg, assistantMsg);
    thread.updatedAt = assistantMsg.timestamp;
    updateThreadContextStats(thread);
    saveState(appState);
    writeContextFile(thread, thread.messages);
    syncCrossAppMemory();
    invalidateQuotaCaches();
    return assistantMsg;
  };

  const finishWith = (result, reason, note) => {
    const assistantMsg = commitTurnMessages(result, reason, note);
    sendEvent({ type: 'done', message: assistantMsg, thread });
  };

  const TRANSIENT_NET_RE = /network error|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|502 Bad Gateway|503 Service Unavailable|504 Gateway|UNAVAILABLE|stream.*closed|connection.*reset|at capacity|server_overloaded|overloaded|temporarily unavailable/i;
  const executeWithRetry = async (eng, model, effort, reason) => {
    let lastErr;
    let hadAnyProgress = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const hasSession = eng === 'antigravity' ? Boolean(thread.agyConversationId) : Boolean(thread.codexSessionId);
        const resumePrompt = attempt > 0 && hadAnyProgress && hasSession
          ? 'Continue from the exact step where you left off before the transient network interruption and complete the task.'
          : null;
        return await execute(eng, model, effort, reason, resumePrompt);
      } catch (err) {
        if (err.hadStepProgress) hadAnyProgress = true;
        lastErr = err;
        if (err.cancelled || err.isQuotaError || !TRANSIENT_NET_RE.test(err.message || '') || attempt === 2) {
          throw err;
        }
        const retryMsg = `↻ Transient server/network blip (${truncate(err.message, 60)}) — automatically resuming session (retry ${attempt + 1}/2)…`;
        sendEvent({ type: 'status', message: retryMsg });
        sendEvent({ type: 'narrative', text: `▸ ${retryMsg}` });
        await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
      }
    }
    throw lastErr;
  };

  try {
    while (true) {
      let result;
      try {
        result = await executeWithRetry(engine, engine === 'antigravity' ? agyModelToUse : codexModel, engine === 'antigravity' ? agyEffortToUse : codexEffortToUse, handoffReason);
      } catch (primaryErr) {
        if (primaryErr.cancelled) throw primaryErr;
        if (!primaryErr.isQuotaError) throw primaryErr;

        let fbEngine = engine === 'antigravity' ? 'codex' : 'antigravity';
        let fbModel = fbEngine === 'antigravity' ? agyModelToUse : codexModel;
        let fbEffort = fbEngine === 'antigravity' ? agyEffortToUse : codexEffortToUse;
        if (engine === 'antigravity') {
          const alt = pickAgyModel(agyStatus, { excludeFamily: agyFamily(agyModelToUse), preferredEffort: agyEffortToUse, threshold: 1 });
          if (alt) {
            fbEngine = 'antigravity';
            fbModel = alt.modelId;
            fbEffort = alt.effort;
          }
        } else if (agyModelPct(agyModelToUse) < 1) {
          const alt = pickAgyModel(agyStatus, { preferredEffort: agyEffortToUse, threshold: 1 });
          if (alt) {
            fbModel = alt.modelId;
            fbEffort = alt.effort;
          }
        }
        const failMsg = `${engine} hit a usage limit (${truncate(primaryErr.message, 140)}). Continuing on ${fbEngine}${fbEngine === 'antigravity' ? ` (${fbModel})` : ''} with the full context.`;
        sendEvent({ type: 'switch_notice', message: failMsg });
        handoffReason = failMsg;
        liveTurn.accumulatedText = '';
        sendEvent({ type: 'replace_delta', text: '' });
        result = await executeWithRetry(fbEngine, fbModel, fbEffort, failMsg);
      }

      if (!autopilotCfg.enabled) {
        finishWith(result, handoffReason);
        break;
      }

      // Check if the Autopilot Loop should stop after this bounded step
      const modelDeclaredDone = /\[AUTOPILOT_DONE\]/i.test(result.text || '');
      const userStopped = cancelledThreads.delete(thread.id);
      const [freshAgy, freshCodex] = await Promise.all([getAgyStatus(true), Promise.resolve(getCodexStatus(true))]);
      const remPct = result.engine === 'antigravity'
        ? (freshAgy.models.find((m) => m.modelId === agyModelToUse)?.remainingPct ?? 100)
        : (freshCodex.fiveHourWindow?.remainingPct ?? 100);
      const usedPct = Math.max(0, Math.min(100, Math.round(100 - remPct)));

      if (userStopped) {
        finishWith(result, handoffReason, `⏹ Autopilot Loop stopped by user after Step ${currentStepIdx}.`);
        break;
      }
      if (modelDeclaredDone) {
        finishWith(result, handoffReason, `✅ Autopilot Loop completed all steps after Step ${currentStepIdx} (${usedPct}% quota used).`);
        break;
      }
      if (remPct <= autopilotCfg.minRemainingPct) {
        finishWith(result, handoffReason, `🎯 Autopilot Loop paused cleanly after Step ${currentStepIdx}: reached ${usedPct}% quota used (target: ${autopilotCfg.targetUsedPct}%).`);
        break;
      }
      if (currentStepIdx >= autopilotCfg.maxSteps) {
        finishWith(result, handoffReason, `🔁 Autopilot Loop completed ${currentStepIdx} sequential steps (${usedPct}% quota used). Send "go" to run another batch.`);
        break;
      }

      // Commit this completed step to disk and immediately transition to the next bounded step!
      const stepNote = `✅ Autopilot Step ${currentStepIdx} sealed (${usedPct}% of 5h quota used • target ${autopilotCfg.targetUsedPct}%). Continuing automatically to Step ${currentStepIdx + 1}…`;
      const committedAsstMsg = commitTurnMessages(result, handoffReason, stepNote);

      // Auto-compact between Autopilot steps if context has passed 115k tokens so the next step runs fast and light
      if ((thread.contextTokens || 0) >= 115000) {
        compactThreadSession(thread, 'auto-compact');
        saveState(appState);
      }

      currentStepIdx += 1;
      currentPromptText = `[Autopilot Step ${currentStepIdx} • ${usedPct}% quota used] Proceed with the next single bounded step from your roadmap/checkpoint, verify it, update CHECKPOINT.md if used, and summarize progress.`;
      currentAttachments = [];
      history = [...thread.messages];
      handoffReason = null;
      userMsg = { id: crypto.randomUUID(), role: 'user', content: currentPromptText, attachments: [], fromHub: true, timestamp: new Date().toISOString() };

      liveTurn.userPrompt = currentPromptText;
      liveTurn.accumulatedText = '';
      liveTurn.narratives = [];
      liveTurn.thinkingSteps = [];
      liveTurn.switchNotices = [
        `🔁 Autopilot Step ${currentStepIdx}/${autopilotCfg.maxSteps} running (${usedPct}% of ${autopilotCfg.targetUsedPct}% quota target used)…`
      ];
      liveTurn.startedAt = new Date().toISOString();
      liveTurn.statusText = `Starting Autopilot Step ${currentStepIdx}…`;

      sendEvent({
        type: 'step_done',
        message: committedAsstMsg,
        thread,
        nextPrompt: currentPromptText,
        stepIndex: currentStepIdx,
        usedPct
      });

      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (err) {
    if (err.cancelled) {
      if (err.partialText && err.partialText.trim()) {
        finishWith({ engine, model: 'stopped', text: err.partialText.trim(), usage: liveTurn.usage || null, narratives: liveTurn.narratives || [], thinkingSteps: liveTurn.thinkingSteps || [], actions: err.actions || [] }, handoffReason, 'Stopped by user.');
      } else {
        saveState(appState);
        sendEvent({ type: 'cancelled', message: 'Stopped by user.', restorePrompt: prompt });
      }
    } else {
      const partial = (liveTurn.accumulatedText || err.partialText || '').trim();
      const hasProgress = Boolean(partial || (liveTurn.narratives && liveTurn.narratives.length > 0) || (liveTurn.thinkingSteps && liveTurn.thinkingSteps.length > 0));
      if (hasProgress) {
        finishWith(
          {
            engine,
            model: liveTurn.model || (engine === 'antigravity' ? agyModelToUse : codexModel),
            text: partial || (liveTurn.narratives && liveTurn.narratives[liveTurn.narratives.length - 1]) || '',
            narratives: liveTurn.narratives || [],
            thinkingSteps: liveTurn.thinkingSteps || [],
            actions: err.actions || [],
            usage: liveTurn.usage || null
          },
          handoffReason,
          `⚠️ Turn interrupted: ${err.message || 'Execution failed'}`
        );
      } else {
        saveState(appState);
        sendEvent({ type: 'error', message: err.message || 'Execution failed', restorePrompt: prompt });
      }
    }
  } finally {
    closeAllSubscribers();
  }
}

// ---------------------------------------------------------------------------
// 12. HTTP Server (Host/Origin/token checks on every API call)
// ---------------------------------------------------------------------------
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

const SETTINGS_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json'
};

const server = http.createServer(async (req, res) => {
  // Block DNS-rebinding: only answer requests addressed to this exact local host:port or allowed gateway.
  const incomingHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(incomingHost) && !ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) {
    res.writeHead(421, { 'Content-Type': 'text/plain' });
    return res.end('Misdirected request');
  }

  const parsedUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = parsedUrl.pathname;

  try {
    if (pathname.startsWith('/api/') && pathname !== '/api/verify-pin') {
      const origin = req.headers.origin;
      if (origin && !ALLOWED_ORIGINS.has(origin)) return sendJson(res, 403, { error: 'Forbidden origin' });
      const cookieToken = (req.headers.cookie || '').match(/ai_hub_token=([a-f0-9]+)/i)?.[1] || null;
      const reqToken = req.headers['x-hub-token'] || parsedUrl.searchParams.get('token') || cookieToken;
      if (reqToken !== HUB_TOKEN) return sendJson(res, 403, { error: 'Missing or invalid hub token' });
      if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.headers['content-length'] && req.headers['content-length'] !== '0' && !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        return sendJson(res, 415, { error: 'Content-Type must be application/json' });
      }
    }

    // --- POST /api/verify-pin (Phone Pairing) ---
    if (req.method === 'POST' && pathname === '/api/verify-pin') {
      const body = await parseJsonBody(req);
      const pin = String(body.pin || '').trim();
      if (pin && pin === String(appState.settings.mobilePin || '').trim()) {
        return sendJson(res, 200, { ok: true, token: HUB_TOKEN });
      }
      return sendJson(res, 401, { ok: false, error: 'Invalid 6-digit Mobile PIN' });
    }

    // --- GET /api/tunnel/status ---
    if (req.method === 'GET' && pathname === '/api/tunnel/status') {
      return sendJson(res, 200, {
        running: tunnelStatus === 'active',
        url: tunnelUrl,
        status: tunnelStatus,
        pin: appState.settings.mobilePin,
        error: tunnelError
      });
    }

    // --- POST /api/tunnel/start ---
    if (req.method === 'POST' && pathname === '/api/tunnel/start') {
      const r = await startCloudflareTunnel();
      return sendJson(res, 200, r);
    }

    // --- POST /api/tunnel/stop ---
    if (req.method === 'POST' && pathname === '/api/tunnel/stop') {
      const r = stopCloudflareTunnel();
      return sendJson(res, 200, r);
    }

    // --- GET /api/status (quota, models, projects, chat list, activeTurns) ---
    if (req.method === 'GET' && pathname === '/api/status') {
      const force = parsedUrl.searchParams.get('force') === '1';
      syncDiscovery(force);
      const [antigravity, codex] = await Promise.all([getAgyStatus(force), Promise.resolve(getCodexStatus(force))]);
      return sendJson(res, 200, {
        antigravity,
        codex,
        codexBinaries: CODEX_BINARIES,
        codexBinaryInUse: getCodexBin(),
        dataDir: DATA_DIR,
        activeTurns: getPublicActiveTurns(),
        tunnel: {
          running: tunnelStatus === 'active',
          url: tunnelUrl,
          status: tunnelStatus,
          pin: appState.settings.mobilePin,
          error: tunnelError
        },
        state: publicState()
      });
    }

    // --- GET /api/turn-stream?threadId=... (re-attach to an in-flight turn after browser refresh) ---
    if (req.method === 'GET' && pathname === '/api/turn-stream') {
      const threadId = parsedUrl.searchParams.get('threadId');
      const liveTurn = activeTurns.get(threadId);
      if (!liveTurn) {
        return sendJson(res, 404, { error: 'No active turn for this thread' });
      }
      subscribeSseResponse(res, liveTurn);
      const writeOne = (obj) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
      };
      writeOne({ type: 'init', engine: liveTurn.engine });
      for (const notice of liveTurn.switchNotices || []) {
        writeOne({ type: 'switch_notice', message: notice });
      }
      for (const th of liveTurn.thinkingSteps || []) {
        writeOne({ type: 'thinking', delta: th });
      }
      for (const nar of liveTurn.narratives || []) {
        writeOne({ type: 'narrative', text: nar });
      }
      if (liveTurn.statusText) {
        writeOne({ type: 'status', message: liveTurn.statusText });
      }
      if (liveTurn.usage) {
        writeOne({ type: 'usage', usage: liveTurn.usage });
      }
      if (liveTurn.accumulatedText) {
        writeOne({ type: 'replace_delta', text: liveTurn.accumulatedText });
      }
      return;
    }

    // --- GET /api/thread?id=... (full history, reloaded if the native app changed it) ---
    if (req.method === 'GET' && pathname === '/api/thread') {
      const thread = appState.threads.find((t) => t.id === parsedUrl.searchParams.get('id'));
      if (!thread) return sendJson(res, 404, { error: 'Thread not found' });
      const prevKey = thread.loadedKey || null;
      loadThreadHistory(thread, parsedUrl.searchParams.get('force') === '1');
      const changed = thread.loadedKey !== prevKey;
      const openElsewhere = isAgyConversationOpen(thread.agyConversationId) || isCodexSessionOpen(thread.codexSessionId);
      if (parsedUrl.searchParams.get('checkOnly') === '1' && !changed) {
        return sendJson(res, 200, { changed: false, openElsewhere, loadedKey: thread.loadedKey });
      }
      return sendJson(res, 200, { changed: true, thread, openElsewhere, loadedKey: thread.loadedKey });
    }

    // --- POST /api/settings ---
    if (req.method === 'POST' && pathname === '/api/settings') {
      const body = await parseJsonBody(req);
      for (const [k, v] of Object.entries(body)) {
        if (!SETTINGS_KEYS.has(k)) continue;
        if (k === 'codexBinary' && v && !CODEX_BINARIES.some((b) => b.path === v)) continue;
        appState.settings[k] = v;
      }
      saveState(appState);
      codexStatusCache.at = 0;
      return sendJson(res, 200, { settings: appState.settings, codexBinaryInUse: getCodexBin() });
    }

    // --- POST /api/projects ---
    if (req.method === 'POST' && pathname === '/api/projects') {
      const body = await parseJsonBody(req);
      const clean = normalizeWinPath(String(body.path || '').trim());
      if (!existsDir(clean)) return sendJson(res, 400, { error: 'Directory does not exist on disk.' });
      let project = appState.projects.find((p) => p.path.toLowerCase() === clean.toLowerCase());
      if (!project) {
        project = {
          id: projectIdForPath(clean),
          name: String(body.name || '').trim() || path.basename(clean) || clean,
          path: clean,
          exists: true,
          sources: ['Hub'],
          createdAt: new Date().toISOString()
        };
        appState.projects.unshift(project);
        saveState(appState);
      }
      return sendJson(res, 200, { project, projects: appState.projects });
    }

    // --- POST /api/browse-folder ---
    if (req.method === 'POST' && pathname === '/api/browse-folder') {
      return sendJson(res, 200, { path: await openNativeFolderDialog() });
    }

    // --- GET /api/files (only inside known projects) ---
    if (req.method === 'GET' && pathname === '/api/files') {
      const cwd = parsedUrl.searchParams.get('cwd');
      if (!isAllowedWorkspacePath(cwd)) return sendJson(res, 403, { error: 'Folder is not a registered project.' });
      return sendJson(res, 200, listWorkspaceFiles(normalizeWinPath(cwd)));
    }

    // --- POST /api/threads/compact (compact active session into a fresh checkpoint handoff) ---
    if (req.method === 'POST' && pathname === '/api/threads/compact') {
      const body = await parseJsonBody(req);
      const thread = appState.threads.find((t) => t.id === body.threadId);
      if (!thread) return sendJson(res, 404, { error: 'Thread not found' });
      const info = compactThreadSession(thread, 'manual');
      saveState(appState);
      return sendJson(res, 200, { ok: true, prevTokens: info?.prevTokens || 0, thread, threads: appState.threads.map(summarizeThread) });
    }

    // --- POST /api/threads (new chat) ---
    if (req.method === 'POST' && pathname === '/api/threads') {
      const body = await parseJsonBody(req);
      const proj = appState.projects.find((p) => p.id === body.projectId) || appState.projects[0];
      const thread = {
        id: crypto.randomUUID(),
        origin: 'hub',
        originatorLabel: 'AI Studio Hub',
        projectId: proj ? proj.id : 'default',
        projectName: proj ? proj.name : 'Workspace',
        projectPath: proj ? proj.path : HOME,
        title: 'New Unified Session',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        agyConversationId: null,
        codexSessionId: null,
        hubSessionIds: [],
        messagesLoaded: true,
        messages: []
      };
      appState.threads.unshift(thread);
      saveState(appState);
      return sendJson(res, 200, { thread, threads: appState.threads.map(summarizeThread) });
    }

    // --- DELETE /api/threads (hide permanently; native chats are never deleted) ---
    if (req.method === 'DELETE' && pathname === '/api/threads') {
      const id = parsedUrl.searchParams.get('id');
      const thread = appState.threads.find((t) => t.id === id);
      const hidden = new Set(appState.hiddenThreadIds || []);
      hidden.add(id);
      for (const sid of thread?.hubSessionIds || []) {
        hidden.add(`agy-${sid}`);
        hidden.add(`codex-${sid}`);
      }
      appState.hiddenThreadIds = [...hidden];
      appState.threads = appState.threads.filter((t) => t.id !== id);
      saveState(appState);
      return sendJson(res, 200, { threads: appState.threads.map(summarizeThread) });
    }

    // --- POST /api/upload (stored in the hub data folder, never inside your projects) ---
    if (req.method === 'POST' && pathname === '/api/upload') {
      const body = await parseJsonBody(req);
      const { name, dataBase64, projectId } = body;
      if (!name || !dataBase64) return sendJson(res, 400, { error: 'Missing file data' });
      const targetDir = path.join(ATTACH_DIR, safeFileName(projectId || 'general'));
      fs.mkdirSync(targetDir, { recursive: true });
      const filePath = path.join(targetDir, `${Date.now()}-${safeFileName(name)}`);
      const buf = Buffer.from(dataBase64, 'base64');
      fs.writeFileSync(filePath, buf);
      return sendJson(res, 200, { attachment: { name, path: filePath, size: buf.length } });
    }

    // --- POST /api/stop (cancel only; never triggers failover) ---
    if (req.method === 'POST' && pathname === '/api/stop') {
      const body = await parseJsonBody(req);
      const child = activeProcesses.get(body.threadId);
      if (child || activeTurns.has(body.threadId)) {
        cancelledThreads.add(body.threadId);
        if (child) killTree(child);
      }
      return sendJson(res, 200, { stopped: Boolean(child || activeTurns.has(body.threadId)) });
    }

    // --- GET /api/image?path=...&cwd=... (serve plotted photos and workspace images inline) ---
    if (req.method === 'GET' && pathname === '/api/image') {
      let rawPath = String(parsedUrl.searchParams.get('path') || '').trim();
      const cwdParam = String(parsedUrl.searchParams.get('cwd') || '').trim();
      if (!rawPath) return sendJson(res, 400, { error: 'Missing image path' });

      rawPath = rawPath.replace(/^file:\/\/\/?/i, '').replace(/^["']|["']$/g, '');
      try {
        rawPath = decodeURIComponent(rawPath);
      } catch {}
      rawPath = rawPath.replace(/\//g, path.sep);

      const candidatePaths = [];
      if (path.isAbsolute(rawPath)) {
        candidatePaths.push(path.normalize(rawPath));
      } else {
        if (cwdParam) candidatePaths.push(path.resolve(cwdParam, rawPath));
        for (const p of appState.projects || []) {
          if (p.path) candidatePaths.push(path.resolve(p.path, rawPath));
        }
        candidatePaths.push(path.resolve(ATTACH_DIR, rawPath));
        candidatePaths.push(path.resolve(DATA_DIR, rawPath));
      }

      const IMG_MIME = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp'
      };

      const foundFile = candidatePaths.find((cp) => {
        try {
          const ext = path.extname(cp).toLowerCase();
          return IMG_MIME[ext] && fs.existsSync(cp) && fs.statSync(cp).isFile();
        } catch {
          return false;
        }
      });

      if (!foundFile) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Image not found');
      }

      const ext = path.extname(foundFile).toLowerCase();
      res.writeHead(200, {
        'Content-Type': IMG_MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff'
      });
      return fs.createReadStream(foundFile).pipe(res);
    }

    // --- POST /api/chat (SSE streaming turn) ---
    if (req.method === 'POST' && pathname === '/api/chat') {
      return await handleChat(req, res, await parseJsonBody(req));
    }

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Unknown API route' });

    // --- Static files (index.html receives the per-launch token) ---
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!filePath.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': STATIC_MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff'
    };
    if (ext === '.html') {
      headers['Content-Security-Policy'] =
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https: wss:; frame-ancestors 'none'";

      const qToken = parsedUrl.searchParams.get('token');
      const cookieHeader = req.headers.cookie || '';
      const hasCookieToken = cookieHeader.includes(`ai_hub_token=${HUB_TOKEN}`);
      const remote = req.socket?.remoteAddress || '';
      const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';

      let effectiveToken = '';
      if (isLocal || qToken === HUB_TOKEN || hasCookieToken) {
        effectiveToken = HUB_TOKEN;
        headers['Set-Cookie'] = `ai_hub_token=${HUB_TOKEN}; Path=/; SameSite=Lax; Max-Age=31536000`;
      }

      res.writeHead(200, headers);
      const rawHtml = fs.readFileSync(filePath, 'utf8');
      return res.end(rawHtml.replaceAll('__HUB_TOKEN__', effectiveToken));
    }
    res.writeHead(200, headers);
    return fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }
});

process.on('uncaughtException', (err) => {
  console.error('[AI Hub] Uncaught Exception:', err?.stack || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[AI Hub] Unhandled Rejection:', reason);
});

process.on('SIGINT', () => {
  stopCloudflareTunnel();
  for (const child of activeProcesses.values()) killTree(child);
  process.exit(0);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[AI Hub] Antigravity binary: ${AGY_BIN}`);
  console.log(`[AI Hub] Codex binary:       ${getCodexBin()}`);
  console.log(`[AI Hub] Data folder:        ${DATA_DIR}`);
  console.log(`\n  AI Studio Hub is running → http://127.0.0.1:${PORT}\n`);
  syncLocalAppMirror();
  syncCrossAppMemory();

  // Start Cloudflare Tunnel for phone and remote access
  if (appState.settings.autoStartTunnel !== false) {
    startCloudflareTunnel().catch(() => {});
  }
  setInterval(() => {
    try {
      syncDiscovery(true);
      syncCrossAppMemory();
      syncLocalAppMirror();
    } catch {}
  }, 12000);
});
