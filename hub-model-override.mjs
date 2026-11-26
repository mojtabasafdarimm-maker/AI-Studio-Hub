// =============================================================================
// Per-prompt model override
// -----------------------------------------------------------------------------
// When Moji names a model in a message ("use Opus", "run this on Gemini Flash",
// "with GPT-6.2-Sol", "model: Sonnet"), that ONE prompt runs on the named model.
// Only the conversation (thread) is switched — the bot's saved default is never
// touched — and the thread is switched back to its previous model as soon as
// the turn finishes (or, at the latest, before the next message is sent).
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, OMB_DATA_DIR } from './hub-core.mjs';

const OMB = 'http://127.0.0.1:8799';
const STATE_FILE = path.join(DATA_DIR, 'model-overrides.json');
const POLL_MS = 5000;
const MAX_WAIT_MS = 6 * 3600 * 1000;
const MIN_HEADROOM = 2;

// ---------------------------------------------------------------- persistence
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch { return {}; }
}
function saveState(s) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8'); } catch {}
}

// ---------------------------------------------------------------- alias table
const norm = (s) => String(s || '').toLowerCase()
  .replace(/[()·]/g, ' ')
  .replace(/(\d)-(\d)/g, '$1.$2')
  .replace(/[-_]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku', 'flash', 'neon', 'carbon', 'argon', 'hydrogen', 'sol', 'astra', 'terra', 'luna', 'orchestrator', 'gpt oss'];
const VENDOR_DEFAULTS = { claude: 'claude-opus-5-5', gemini: 'gemini-4-neon', gpt: 'gpt-6.2-sol', codex: 'gpt-6.2-sol', chatgpt: 'gpt-6.2-sol' };

function isVariant(label) { return /\(1m\)|· fast|\+priority/i.test(label); }
function verOf(label) {
  const m = norm(label).match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 0;
}

/** Builds [{alias, modelId, label, specific}] from every authenticated account's model list. */
function buildAliases(accounts) {
  const seen = new Map();
  const add = (alias, modelId, label, specific) => {
    alias = norm(alias);
    if (!alias || alias.length < 3) return;
    const prev = seen.get(alias);
    const ver = verOf(label);
    // Specific beats family-only; among equals the newest version wins; 1M/Fast variants lose ties.
    const better = !prev ||
      (specific && !prev.specific) ||
      (specific === prev.specific && (ver > prev.ver || (ver === prev.ver && isVariant(prev.label) && !isVariant(label))));
    if (better) seen.set(alias, { alias, modelId, label, specific, ver });
  };
  for (const acct of accounts) {
    for (const m of acct.availableModels || []) {
      const label = m.label || m.id;
      const n = norm(label);
      add(n, m.id, label, true);
      add(m.id, m.id, label, true);
      const noVendor = n.replace(/^(claude|gemini|gpt)\s+/, '');
      if (noVendor !== n && !/^\d/.test(noVendor)) add(noVendor, m.id, label, true);
      if (isVariant(label)) continue;
      if (/^orchestrator/.test(n)) {
        if (/neon/.test(n)) add('orchestrator', m.id, label, false);
        continue;
      }
      for (const fam of FAMILIES) {
        if (new RegExp(`\\b${fam}\\b`).test(n)) {
          add(fam, m.id, label, false);
          const vendor = (n.match(/^(claude|gemini|gpt)/) || [])[1];
          if (vendor) add(`${vendor} ${fam}`, m.id, label, true);
          const ver = (n.match(/\d+(\.\d+)?/) || [])[0];
          if (ver) add(`${fam} ${ver}`, m.id, label, true);
        }
      }
    }
  }
  for (const [vendor, id] of Object.entries(VENDOR_DEFAULTS)) add(vendor, id, vendor, false);
  return [...seen.values()].sort((a, b) => b.alias.length - a.alias.length);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[\\s\\-_.()]*');
const STRONG = String.raw`(?:use|using|via|switch(?:ing)? to|run (?:this |it |that )?(?:on|with|using)|do (?:this |it |that )?(?:on|with)|model\s*[:=]|on model|with model)`;
const WEAK = String.raw`(?:with|on|in)`;
const UNAMBIGUOUS = new Set(['opus', 'sonnet', 'haiku', 'fable', 'orchestrator']);

/** Returns {modelId, label, alias, accountHint} when the text names a model to run on, else null. */
export function detectModelRequest(text, accounts) {
  const raw = String(text || '');
  if (!raw.trim() || raw.length > 6000) return null;
  // Ignore quoted / code content.
  const t = ' ' + raw.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').toLowerCase() + ' ';
  const aliases = buildAliases(accounts);
  for (const a of aliases) {
    const body = esc(a.alias);
    const strongRe = new RegExp(`(?:^|[^a-z])${STRONG}\\s+(?:the\\s+)?${body}(?![a-z0-9])`, 'i');
    const weakRe = new RegExp(`(?:^|[^a-z])${WEAK}\\s+(?:the\\s+)?${body}(?:\\s+model)?(?![a-z0-9])`, 'i');
    const tagRe = new RegExp(`(?:^|\\s)[\\[#]${body}\\]?(?![a-z0-9])`, 'i');
    // "with/on <x>" only counts for full names and unmistakable Claude families;
    // everyday words (sol, luna, flash, neon, claude, gemini…) need "use/run on/switch to".
    const weakOk = a.specific || UNAMBIGUOUS.has(a.alias);
    if (strongRe.test(t) || tagRe.test(t) || (weakOk && weakRe.test(t))) {
      return { modelId: a.modelId, label: a.label, alias: a.alias };
    }
  }
  return null;
}

function headroom(acct) {
  const vals = [acct.fiveHour?.remainingPercent, acct.weekly?.remainingPercent].filter(Number.isFinite);
  return vals.length ? Math.min(...vals) : 50;
}

/** Picks the account to run `modelId` on: named account > has headroom > bot's current account > best score. */
export function pickAccount(modelId, accounts, { currentInstanceId, text } = {}) {
  const lower = String(text || '').toLowerCase();
  const hinted = (a) => {
    const names = [a.displayName, a.email && a.email.split('@')[0], a.email].filter(Boolean).map((s) => s.toLowerCase());
    return names.some((n) => n.length >= 4 && new RegExp(`(^|[^a-z0-9.])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(lower));
  };
  const cands = accounts.filter((a) => a.authenticated && (a.availableModels || []).some((m) => m.id === modelId));
  if (!cands.length) return null;
  cands.sort((x, y) =>
    (hinted(y) - hinted(x)) ||
    ((headroom(y) > MIN_HEADROOM) - (headroom(x) > MIN_HEADROOM)) ||
    ((y.instanceId === currentInstanceId) - (x.instanceId === currentInstanceId)) ||
    ((y.routingScore ?? 0) - (x.routingScore ?? 0)));
  return cands[0];
}

// ---------------------------------------------------------------- OMB helpers
async function getBot(botId) {
  const res = await fetch(`${OMB}/api/bots`, { signal: AbortSignal.timeout(6000) });
  const j = await res.json();
  return (j.bots || []).find((b) => b.id === botId) || null;
}
function taskOf(bot, threadId) {
  return (bot?.tasks || []).find((t) => t.threadId === threadId) || null;
}
async function patchThreadModel(botId, threadId, modelSelection) {
  const res = await fetch(`${OMB}/api/bots/${encodeURIComponent(botId)}/tasks/${encodeURIComponent(threadId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelSelection, updateBotDefault: false }),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`thread model switch HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return true;
}
const same = (a, b) => !!a && !!b && a.instanceId === b.instanceId && a.model === b.model;

// ---------------------------------------------------------------- restore
const watchers = new Map();

async function restoreIfPending(key, why) {
  const state = loadState();
  const o = state[key];
  if (!o) return;
  try {
    const bot = await getBot(o.botId);
    const task = taskOf(bot, o.threadId);
    if (task && same(task.modelSelection, o.override)) {
      // Back to the bot's default when the thread followed it before; else its own previous pick.
      const target = o.followedBotModel ? bot.modelSelection : o.previous;
      await patchThreadModel(o.botId, o.threadId, target);
      console.log(`[Model Override] ${o.botName}: restored ${o.override.model} -> ${target.model} (${why})`);
    }
  } catch (e) {
    console.warn('[Model Override] restore failed:', e.message);
    return; // keep pending; retried before next message / on next start
  }
  const s2 = loadState();
  delete s2[key];
  saveState(s2);
  const w = watchers.get(key);
  if (w) { clearInterval(w); watchers.delete(key); }
}

function watchUntilIdle(key) {
  if (watchers.has(key)) return;
  let sawBusy = false;
  const iv = setInterval(async () => {
    const o = loadState()[key];
    if (!o) { clearInterval(iv); watchers.delete(key); return; }
    try {
      const bot = await getBot(o.botId);
      const task = taskOf(bot, o.threadId);
      if (!task) return restoreIfPending(key, 'thread gone');
      const age = Date.now() - o.at;
      if (task.busy && age < MAX_WAIT_MS) { sawBusy = true; return; }
      if (sawBusy || age > 90_000 || age >= MAX_WAIT_MS) await restoreIfPending(key, 'turn finished');
    } catch {}
  }, POLL_MS);
  iv.unref?.();
  watchers.set(key, iv);
}

/** Re-arm watchers for overrides left pending by a previous Hub process. */
export function resumePendingOverrides() {
  for (const key of Object.keys(loadState())) watchUntilIdle(key);
}

// ---------------------------------------------------------------- entry point
/**
 * Called by server.js for every POST /api/bots/:id/messages (before the auto-router).
 * Returns { applied, text?, note?, ... }. When applied, the caller should skip
 * auto-routing and forward `text` (original + short visible note).
 */
export async function applyPromptModelOverride({ botId, threadId, text, getAllowances }) {
  // Always settle any earlier one-prompt override on this bot first.
  for (const [key, o] of Object.entries(loadState())) {
    if (o.botId === botId) await restoreIfPending(key, 'next message');
  }

  // Detect against the saved account list first (instant), so ordinary messages are never slowed down.
  let accounts = [];
  try { accounts = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'allowances-cache.json'), 'utf8')).accounts || []; } catch {}
  const live = async () => {
    try {
      const al = await Promise.race([getAllowances(), new Promise((r) => setTimeout(() => r(null), 4000))]);
      return al?.accounts?.length ? al.accounts : null;
    } catch { return null; }
  };
  if (!accounts.length) accounts = (await live()) || [];
  if (!accounts.length) return { applied: false, reason: 'no account list' };

  const req = detectModelRequest(text, accounts);
  if (!req) return { applied: false };
  // A model was named: refresh quota numbers so the account choice uses current headroom.
  accounts = (await live()) || accounts;

  const bot = await getBot(botId);
  if (!bot) return { applied: false, reason: 'bot not found' };
  const tid = threadId || bot.threadId;
  const task = taskOf(bot, tid);
  if (!task) return { applied: false, reason: 'thread not found' };

  const current = task.modelSelection || bot.modelSelection;
  const acct = pickAccount(req.modelId, accounts, { currentInstanceId: current?.instanceId, text });
  if (!acct) return { applied: false, reason: `no signed-in account offers ${req.label}` };

  const override = { instanceId: acct.instanceId, model: req.modelId };
  const label = (acct.availableModels.find((m) => m.id === req.modelId) || {}).label || req.modelId;
  const note = `\n\n_(Hub: running this prompt on ${label} · ${acct.displayName} — this message only; the bot switches back afterwards.)_`;

  if (same(current, override)) {
    return { applied: true, unchanged: true, text: text + note, label, account: acct.displayName };
  }

  await patchThreadModel(botId, tid, override);
  const key = `${botId}:${tid}`;
  const state = loadState();
  state[key] = {
    botId, botName: bot.name, threadId: tid, at: Date.now(),
    previous: current, followedBotModel: task.followsBotModel !== false, override
  };
  saveState(state);
  watchUntilIdle(key);
  console.log(`[Model Override] ${bot.name}: ${current?.model} -> ${req.modelId} on ${acct.displayName} (alias "${req.alias}")`);
  return { applied: true, text: text + note, label, account: acct.displayName, previous: current };
}
