// hub-watchdog.mjs — Free (no model calls) background guard for AI Studio Hub.
//
// Every few minutes it:
//   1. Quota guard: moves a bot off an account that is nearly empty (<= lowPercent) onto the best
//      fallback account, remembers where it came from, and moves it back once the original account
//      has recovered (>= restorePercent). Respects the model policy (Neon for heavy work, Flash for light,
//      never Argon, never auto-spend Codex/Claude/API credits, Codex reserved for GlenNeely).
//   2. Attention feed: collects things that need Moji (questions waiting on him, stuck or failed hand-offs,
//      failed runs, failed routines, quota moves, empty accounts) with stable keys so each item is
//      reported once. khadang's existing alert routine reads it through the hub_attention MCP tool.
//   3. Dashboard data for /dashboard (phone-friendly bot cards).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, OMB_DATA_DIR } from './hub-core.mjs';
import { loadPolicy } from './hub-router.mjs';

const STATE_FILE = path.join(DATA_DIR, 'watchdog-state.json');
const CONFIG_FILE = path.join(DATA_DIR, 'watchdog-config.json');

export const DEFAULT_WATCHDOG_CONFIG = {
  enabled: true,
  quotaGuard: true,
  intervalMinutes: 5,
  lowPercent: 8,          // move a bot when its account/model window is at or below this
  restorePercent: 40,     // move it back when the original account is at or above this
  minTargetPercent: 25,   // only move onto accounts with at least this much left
  minMinutesBeforeRestore: 30,
  resetSoonMinutes: 45,  // don't move a bot if the low window refills within this many minutes
  stuckHours: 2,          // a hand-off still "running" after this long is flagged
  excludeBots: [],        // bot names or ids the quota guard must never touch
  // Fallback chains per tier. Only subscription accounts; Codex/Claude/API are never auto-spent.
  fallbacks: {
    heavy: [
      { instanceId: 'antigravity-803cef99-77bf-4686-b428-149233bd1050', model: 'gemini-pro-orchestrator-neon' },
      { instanceId: 'antigravity', model: 'gemini-4-neon' },
      { instanceId: 'antigravity-78fdf303-92f9-41a2-bc00-5fc57f32c39c', model: 'gemini-3.8-flash' }
    ],
    standard: [
      { instanceId: 'antigravity-803cef99-77bf-4686-b428-149233bd1050', model: 'gemini-4-carbon' },
      { instanceId: 'antigravity', model: 'gemini-4-carbon' },
      { instanceId: 'antigravity-78fdf303-92f9-41a2-bc00-5fc57f32c39c', model: 'gemini-3.8-flash' }
    ],
    light: [
      { instanceId: 'antigravity-803cef99-77bf-4686-b428-149233bd1050', model: 'gemini-3.8-flash' },
      { instanceId: 'antigravity', model: 'gemini-3.8-flash' },
      { instanceId: 'antigravity-78fdf303-92f9-41a2-bc00-5fc57f32c39c', model: 'gemini-3.8-flash' }
    ]
  }
};

export function loadWatchdogConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_WATCHDOG_CONFIG, null, 2), 'utf8');
      return DEFAULT_WATCHDOG_CONFIG;
    }
    return { ...DEFAULT_WATCHDOG_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return DEFAULT_WATCHDOG_CONFIG;
  }
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { moves: {}, items: {}, log: [], ...s };
  } catch {
    return { moves: {}, items: {}, log: [] };
  }
}

function saveState(state) {
  state.log = (state.log || []).slice(-200);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

let ctx = { hubPort: 4747, ombPort: 8799, getToken: () => '' };
let timer = null;
let lastRun = { at: null, ms: null, error: null, moved: 0, restored: 0 };
let running = false;

const authHeaders = () => {
  const t = ctx.getToken();
  return { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) };
};

async function getJson(url, ms = 30000) {
  const res = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// ---------- quota helpers ----------
function windowsMin(ws) {
  const v = ws.map((w) => w?.remainingPercent).filter((n) => typeof n === 'number' && Number.isFinite(n));
  return v.length ? Math.min(...v) : null;
}

export function headroomFor(account, model = '') {
  if (!account) return null;
  if (account.driver === 'antigravity' && /claude|gpt/i.test(model)) {
    const shared = (account.models || []).find((m) => /claude|gpt/i.test(m.name || ''));
    if (shared) return windowsMin(shared.windows || []);
  }
  return windowsMin([account.fiveHour, account.weekly]);
}

function tierOf(model, policy) {
  for (const t of policy.modelTiers || []) {
    try { if (new RegExp(t.match, 'i').test(model)) return t.tier; } catch {}
  }
  return 'standard';
}

const sameSel = (a, b) => a && b && a.instanceId === b.instanceId && a.model === b.model;

async function patchBotModel(bot, modelSelection) {
  const res = await fetch(`http://127.0.0.1:${ctx.ombPort}/api/bots/${encodeURIComponent(bot.id)}`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify({ threadId: bot.threadId, modelSelection }),
    signal: AbortSignal.timeout(45000)
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `HTTP ${res.status}`);
  }
}

async function quotaGuard(state, cfg, bots, allowances, policy) {
  const accounts = new Map((allowances.accounts || []).map((a) => [a.instanceId, a]));
  const excluded = new Set((cfg.excludeBots || []).map((s) => String(s).toLowerCase()));
  const reserve = policy.reserveAccounts || {};
  const now = Date.now();
  let moved = 0;
  let restored = 0;

  for (const bot of bots) {
    if (!bot?.modelSelection?.instanceId || !bot.threadId) continue;
    if (excluded.has(String(bot.name || '').toLowerCase()) || excluded.has(bot.id)) continue;
    const sel = bot.modelSelection;
    const rec = state.moves[bot.id];

    // Someone changed the bot by hand since we moved it: respect that and forget the move.
    if (rec && !sameSel(sel, rec.to)) {
      delete state.moves[bot.id];
      state.log.push({ at: now, bot: bot.name, event: 'manual-change-detected', note: 'restore cancelled' });
      continue;
    }

    // Restore when the original account has recovered.
    if (rec) {
      const origHead = headroomFor(accounts.get(rec.from.instanceId), rec.from.model);
      if (origHead !== null && origHead >= cfg.restorePercent && now - rec.at >= cfg.minMinutesBeforeRestore * 60000) {
        try {
          await patchBotModel(bot, rec.from);
          delete state.moves[bot.id];
          restored++;
          const label = accounts.get(rec.from.instanceId)?.displayName || rec.from.instanceId;
          state.log.push({ at: now, bot: bot.name, event: 'restored', to: rec.from, headroom: origHead });
          upsertItem(state, `restore:${bot.id}:${rec.at}`, {
            kind: 'quota-restored', severity: 'info', botId: bot.id, threadId: bot.threadId,
            title: `${bot.name} is back on ${label}`,
            detail: `${label} recovered to ${Math.round(origHead)}%, so ${bot.name} returned to ${rec.from.model}.`
          });
        } catch (e) {
          state.log.push({ at: now, bot: bot.name, event: 'restore-failed', error: e.message });
        }
      }
      continue;
    }

    const acct = accounts.get(sel.instanceId);
    if (!acct) continue; // API-key / unknown instances are not metered here
    const head = headroomFor(acct, sel.model);
    if (head === null || head > cfg.lowPercent) continue;
    // Only the 5-hour window is low and it refills very soon: wait instead of churning.
    const weeklyOk = (acct.weekly?.remainingPercent ?? 100) > cfg.lowPercent;
    const fiveResetMin = typeof acct.fiveHour?.hoursUntilReset === 'number' ? acct.fiveHour.hoursUntilReset * 60 : null;
    if (weeklyOk && fiveResetMin !== null && fiveResetMin <= cfg.resetSoonMinutes && !(acct.driver === 'antigravity' && /claude|gpt/i.test(sel.model))) continue;

    // GlenNeely keeps Codex unless Codex is truly empty.
    const reservedHere = (reserve[sel.instanceId] || []).some((n) => String(n).toLowerCase() === String(bot.name || '').toLowerCase());
    if (reservedHere && head > 2) continue;

    const tier = tierOf(sel.model, policy);
    const chain = (cfg.fallbacks?.[tier] || cfg.fallbacks?.standard || []).filter((c) => c.instanceId !== sel.instanceId);
    const avoid = (policy.avoidModels || []).map((m) => String(m).toLowerCase());
    const target = chain
      .filter((c) => !avoid.some((a) => c.model.toLowerCase().includes(a)))
      .map((c) => ({ ...c, head: headroomFor(accounts.get(c.instanceId), c.model) }))
      .find((c) => c.head !== null && c.head >= cfg.minTargetPercent && accounts.get(c.instanceId)?.authenticated !== false);

    const key = `low:${bot.id}:${sel.instanceId}`;
    if (!target) {
      upsertItem(state, key, {
        kind: 'quota-stuck', severity: 'urgent', botId: bot.id, threadId: bot.threadId,
        title: `${bot.name} is nearly out of quota and no other account has room`,
        detail: `${acct.displayName} has ${Math.round(head)}% left. Every fallback account is also low; ${bot.name} will fail until a reset.`
      });
      continue;
    }

    const to = { instanceId: target.instanceId, model: target.model };
    try {
      await patchBotModel(bot, to);
      state.moves[bot.id] = { at: now, from: { ...sel }, to, reason: `${acct.displayName} at ${Math.round(head)}%` };
      moved++;
      const tLabel = accounts.get(target.instanceId)?.displayName || target.instanceId;
      state.log.push({ at: now, bot: bot.name, event: 'moved', from: sel, to, headroom: head });
      upsertItem(state, `move:${bot.id}:${now}`, {
        kind: 'quota-moved', severity: 'normal', botId: bot.id, threadId: bot.threadId,
        title: `Moved ${bot.name} to ${tLabel}`,
        detail: `${acct.displayName} was down to ${Math.round(head)}%. ${bot.name} now uses ${target.model} on ${tLabel} (${Math.round(target.head)}% left) and moves back automatically when ${acct.displayName} recovers.`
      });
    } catch (e) {
      state.log.push({ at: now, bot: bot.name, event: 'move-failed', error: e.message });
      upsertItem(state, key, {
        kind: 'quota-stuck', severity: 'urgent', botId: bot.id, threadId: bot.threadId,
        title: `Could not move ${bot.name} off a nearly empty account`,
        detail: `${acct.displayName} has ${Math.round(head)}% left; switching failed: ${e.message}`
      });
    }
  }
  return { moved, restored };
}

// ---------- attention feed ----------
function upsertItem(state, key, item) {
  const now = Date.now();
  const prev = state.items[key];
  state.items[key] = { ...prev, ...item, key, firstSeen: prev?.firstSeen || now, lastSeen: now, seenThisRun: true };
}

function openDb(file) {
  try { return new DatabaseSync(file, { readOnly: true }); } catch { return null; }
}

function collectFromRuntime(state, cfg, botNames) {
  const db = openDb(path.join(OMB_DATA_DIR, 'runtime.db'));
  if (!db) return;
  try {
    const now = Date.now();
    const stuck = db.prepare("select id, assignee_bot_id b, assignee_thread_id t, created_at c, json from assignments where status='running' and created_at < ?").all(now - cfg.stuckHours * 3600e3);
    for (const r of stuck) {
      let quote = '';
      try { quote = JSON.parse(r.json)?.origin?.quote || ''; } catch {}
      const hrs = Math.round((now - r.c) / 3600e3);
      upsertItem(state, `stuck:${r.id}`, {
        kind: 'stuck', severity: 'normal', botId: r.b, threadId: r.t,
        title: `${botNames.get(r.b) || 'A bot'} has been working for ${hrs}h without finishing`,
        detail: quote ? `Task: "${String(quote).slice(0, 140)}"` : 'A hand-off is still marked running.'
      });
    }
    const failed = db.prepare("select id, assignee_bot_id b, assignee_thread_id t, finished_at f, json from assignments where status='failed' and coalesce(finished_at, created_at) > ?").all(now - 24 * 3600e3);
    for (const r of failed) {
      let quote = '';
      try { quote = JSON.parse(r.json)?.origin?.quote || ''; } catch {}
      upsertItem(state, `failed:${r.id}`, {
        kind: 'failed', severity: 'normal', botId: r.b, threadId: r.t,
        title: `${botNames.get(r.b) || 'A bot'} failed a task`,
        detail: quote ? `Task: "${String(quote).slice(0, 140)}"` : 'A hand-off ended as failed.'
      });
    }
  } catch {} finally { try { db.close(); } catch {} }
}

function collectIncidents(state) {
  const db = openDb(path.join(OMB_DATA_DIR, 'messages.db'));
  if (!db) return;
  try {
    const rows = db.prepare("select id, thread_id, at, text from messages where at > ? and text like '[From OpenMausBot · incident report%' order by at desc limit 20").all(Date.now() - 24 * 3600e3);
    for (const r of rows) {
      const body = String(r.text || '').split('\n').slice(1).join(' ').replace(/\s+/g, ' ').trim();
      const m = body.match(/^(.+?)'s run in its thread #(.+?) failed: "(.{0,220})/);
      upsertItem(state, `incident:${r.id}`, {
        kind: 'run-failed', severity: /usage limit|quota/i.test(body) ? 'normal' : 'urgent', threadId: r.thread_id,
        title: m ? `${m[1]}'s run failed (#${m[2].slice(0, 60)})` : 'A bot run failed',
        detail: m ? m[3].replace(/"$/, '') : body.slice(0, 220)
      });
    }
  } catch {} finally { try { db.close(); } catch {} }
}

function collectRoutineFailures(state) {
  try {
    const file = path.join(OMB_DATA_DIR, 'routines.ledger.jsonl');
    const stat = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const len = Math.min(stat.size, 400000);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, stat.size - len);
    fs.closeSync(fd);
    let routines = [];
    try {
      const r = JSON.parse(fs.readFileSync(path.join(OMB_DATA_DIR, 'routines.json'), 'utf8'));
      routines = Array.isArray(r) ? r : r.routines || [];
    } catch {}
    const names = new Map(routines.map((r) => [r.id, r]));
    const since = Date.now() - 24 * 3600e3;
    for (const line of buf.toString('utf8').split('\n')) {
      let o;
      try { o = JSON.parse(line)?.o; } catch { continue; }
      if (!o || !['failed', 'missed'].includes(o.state)) continue;
      const at = o.endedAt || o.dueAt || 0;
      if (at < since) continue;
      const rt = names.get(o.routineId);
      upsertItem(state, `routine:${o.routineId}:${o.dueAt}:${o.state}`, {
        kind: 'routine-' + o.state, severity: 'normal', botId: rt?.botId,
        title: `Routine "${rt?.name || o.routineId}" ${o.state === 'failed' ? 'failed' : 'was missed'}`,
        detail: `Scheduled for ${new Date(o.dueAt).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET.`
      });
    }
  } catch {}
}

async function collectNeedsYou(state, botNames) {
  try {
    const data = await getJson(`http://127.0.0.1:${ctx.ombPort}/api/needs-you`, 15000);
    for (const it of data.items || []) {
      const ageMin = (Date.now() - (it.at || Date.now())) / 60000;
      if (ageMin < 30) continue; // the app already pushes fresh questions to the phone
      upsertItem(state, `needs:${it.id}`, {
        kind: 'needs-you', severity: 'normal', botId: it.botId, threadId: it.threadId,
        title: `${botNames.get(it.botId) || 'A bot'} is waiting for your answer`,
        detail: String(it.text || '').slice(0, 220)
      });
    }
  } catch {}
}

function collectLowAccounts(state, allowances) {
  for (const a of allowances.accounts || []) {
    const head = headroomFor(a);
    const bots = a.assignedBots || [];
    if (head === null || head > 8 || !bots.length) continue;
    const resetAt = a.weekly?.remainingPercent <= 8 ? a.weekly?.resetsAtEastern : a.fiveHour?.resetsAtEastern;
    upsertItem(state, `acct-low:${a.instanceId}:${a.weekly?.resetsAt || a.fiveHour?.resetsAt || 'x'}`, {
      kind: 'account-low', severity: 'info',
      title: `${a.displayName} is at ${Math.round(head)}%`,
      detail: `Bots on it: ${bots.map((b) => b.name).join(', ')}.${resetAt ? ` Resets ${resetAt}.` : ''}`
    });
  }
}

// ---------- main loop ----------
export async function runWatchdogOnce() {
  if (running) return lastRun;
  running = true;
  const started = Date.now();
  const cfg = loadWatchdogConfig();
  const state = loadState();
  for (const it of Object.values(state.items)) it.seenThisRun = false;
  let moved = 0;
  let restored = 0;
  try {
    const [botsData, allowances] = await Promise.all([
      getJson(`http://127.0.0.1:${ctx.ombPort}/api/bots`),
      getJson(`http://127.0.0.1:${ctx.hubPort}/api/hub/allowances`, 60000)
    ]);
    const bots = botsData.bots || [];
    const botNames = new Map(bots.map((b) => [b.id, b.name]));
    const policy = loadPolicy();
    if (cfg.quotaGuard) ({ moved, restored } = await quotaGuard(state, cfg, bots, allowances, policy));
    collectFromRuntime(state, cfg, botNames);
    collectIncidents(state);
    collectRoutineFailures(state);
    await collectNeedsYou(state, botNames);
    collectLowAccounts(state, allowances);

    // Items that are no longer true resolve themselves (moves/restores stay 24h as history).
    const now = Date.now();
    for (const [k, it] of Object.entries(state.items)) {
      const sticky = /^(move|restore|incident|routine|failed):/.test(k);
      if (sticky ? now - it.firstSeen > 24 * 3600e3 : !it.seenThisRun) delete state.items[k];
    }
    state.lastAllowanceSummary = (allowances.accounts || []).map((a) => ({
      displayName: a.displayName, instanceId: a.instanceId, headroom: headroomFor(a),
      fiveHour: a.fiveHour?.remainingPercent ?? null, weekly: a.weekly?.remainingPercent ?? null,
      weeklyResets: a.weekly?.resetsAtEastern || null, bots: (a.assignedBots || []).map((b) => b.name)
    }));
    saveState(state);
    lastRun = { at: new Date().toISOString(), ms: Date.now() - started, error: null, moved, restored };
  } catch (e) {
    lastRun = { at: new Date().toISOString(), ms: Date.now() - started, error: e.message, moved, restored };
    try { saveState(state); } catch {}
  } finally {
    running = false;
  }
  return lastRun;
}

export function startWatchdog(options = {}) {
  ctx = { ...ctx, ...options };
  const cfg = loadWatchdogConfig();
  if (!cfg.enabled || timer) return;
  setTimeout(() => runWatchdogOnce().catch(() => {}), 90 * 1000);
  timer = setInterval(() => runWatchdogOnce().catch(() => {}), Math.max(2, cfg.intervalMinutes) * 60000);
  console.log(`[Watchdog] started (every ${cfg.intervalMinutes} min, quota guard ${cfg.quotaGuard ? 'on' : 'off'})`);
}

export function getWatchdogStatus() {
  const state = loadState();
  return { ok: true, config: loadWatchdogConfig(), lastRun, moves: state.moves, log: (state.log || []).slice(-30) };
}

const SEV = { urgent: 0, normal: 1, info: 2 };

/**
 * @param {{unnotified?: boolean, markNotified?: boolean, includeAcked?: boolean}} opts
 */
export function getAttention(opts = {}) {
  const state = loadState();
  let items = Object.values(state.items).filter((i) => opts.includeAcked || !i.ackedAt);
  if (opts.unnotified) items = items.filter((i) => !i.notifiedAt && i.severity !== 'info');
  items.sort((a, b) => (SEV[a.severity] ?? 3) - (SEV[b.severity] ?? 3) || b.lastSeen - a.lastSeen);
  if (opts.markNotified && items.length) {
    const now = Date.now();
    for (const i of items) state.items[i.key].notifiedAt = now;
    saveState(state);
  }
  return {
    ok: true,
    lastRun,
    counts: items.reduce((m, i) => ((m[i.severity] = (m[i.severity] || 0) + 1), m), {}),
    items: items.map(({ seenThisRun, ...rest }) => rest),
    accounts: state.lastAllowanceSummary || [],
    activeMoves: Object.entries(state.moves).map(([botId, m]) => ({ botId, ...m }))
  };
}

export function acknowledgeAttention(keys = []) {
  const state = loadState();
  const now = Date.now();
  let n = 0;
  for (const k of keys === 'all' ? Object.keys(state.items) : keys) {
    if (state.items[k]) { state.items[k].ackedAt = now; n++; }
  }
  saveState(state);
  return { ok: true, acknowledged: n };
}

// ---------- dashboard ----------
export async function getDashboard() {
  const [botsData, allowances] = await Promise.all([
    getJson(`http://127.0.0.1:${ctx.ombPort}/api/bots`),
    getJson(`http://127.0.0.1:${ctx.hubPort}/api/hub/allowances`, 60000).catch(() => ({ accounts: [] }))
  ]);
  const bots = botsData.bots || [];
  const accounts = new Map((allowances.accounts || []).map((a) => [a.instanceId, a]));
  const rt = openDb(path.join(OMB_DATA_DIR, 'runtime.db'));
  const msgs = openDb(path.join(OMB_DATA_DIR, 'messages.db'));
  const latestAssign = rt?.prepare("select status, assignee_thread_id t, created_at c, finished_at f, json from assignments where assignee_bot_id=? order by created_at desc limit 1");
  const runningCount = rt?.prepare("select count(*) n from assignments where assignee_bot_id=? and status='running'");
  const lastText = msgs?.prepare("select at, text from messages where thread_id=? and role='bot' and kind='text' order by at desc limit 1");
  const attention = getAttention();
  const out = bots.map((b) => {
    const sel = b.modelSelection || {};
    const acct = accounts.get(sel.instanceId);
    let latest = null;
    let reply = null;
    try { latest = latestAssign?.get(b.id) || null; } catch {}
    const threadId = latest?.t || b.threadId;
    try { reply = lastText?.get(threadId) || (threadId !== b.threadId ? lastText?.get(b.threadId) : null) || null; } catch {}
    let task = '';
    try { task = JSON.parse(latest?.json || '{}')?.origin?.quote || ''; } catch {}
    const isRunning = (() => { try { return (runningCount?.get(b.id)?.n || 0) > 0; } catch { return false; } })();
    return {
      id: b.id,
      name: b.name,
      description: b.description || '',
      threadId,
      mainThreadId: b.threadId,
      model: sel.model || null,
      account: acct?.displayName || sel.instanceId || null,
      headroom: headroomFor(acct, sel.model || ''),
      status: isRunning ? 'running' : latest?.status === 'failed' ? 'failed' : latest?.status === 'needs_input' ? 'needs-you' : 'idle',
      lastTask: String(task).slice(0, 160),
      lastActivityAt: Math.max(latest?.f || latest?.c || 0, reply?.at || 0) || null,
      lastReply: reply ? String(reply.text || '').replace(/\s+/g, ' ').slice(0, 280) : '',
      attention: attention.items.filter((i) => i.botId === b.id).length,
      movedByWatchdog: Boolean(loadState().moves[b.id])
    };
  });
  try { rt?.close(); } catch {}
  try { msgs?.close(); } catch {}
  return { ok: true, at: new Date().toISOString(), bots: out, attention, accounts: attention.accounts };
}

/** Retry: post a short follow-up into the bot's thread, exactly like typing it in the app. */
export async function retryBotThread(botId, threadId, text = 'Please pick up where you left off and retry the last step that failed or stalled.') {
  const res = await fetch(`http://127.0.0.1:${ctx.ombPort}/api/bots/${encodeURIComponent(botId)}/messages`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ text, threadId, sendId: `hub-retry-${Date.now()}` }),
    signal: AbortSignal.timeout(30000)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return { ok: true };
}
