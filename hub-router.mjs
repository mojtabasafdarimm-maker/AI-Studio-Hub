// hub-router.mjs — Subscription-aware AI task router for AI Studio Hub.
//
// Fits your exact setup: bots run on *accounts* (Codex, 3x Google/Antigravity) instead of per-token APIs.
// Flow when a prompt is sent to any bot:
//   1. Fast zero-cost bypasses: short continuations ("ok", "yes", "go") keep current model unless quota < 12%;
//      scheduled routines stay on Flash.
//   2. Context-rich AI judge (~1s, ~700 tokens, zero agent/MCP overhead): calls gemini-2.5-flash-lite directly
//      via Antigravity OAuth using: bot role + thread's FIRST message (goal) + last 12 text/digest messages + prompt.
//   3. Account + online-price optimizer: combines the AI's tier with live /api/hub/allowances headroom and
//      cached OpenRouter $/1M pricing, then automatically switches the bot/thread before its turn starts.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, OMB_DATA_DIR } from './hub-core.mjs';

const POLICY_FILE = path.join(DATA_DIR, 'router-policy.json');
const CATALOG_FILE = path.join(DATA_DIR, 'model-catalog.json');
const STATE_FILE = path.join(DATA_DIR, 'router-state.json');
const CATALOG_TTL_MS = 24 * 3600 * 1000;
const HUB = 'http://127.0.0.1:4747';
const OMB = 'http://127.0.0.1:8799';

const TIER = { light: 0, standard: 1, heavy: 2 };

export const DEFAULT_POLICY = {
  minHeadroomPercent: 12,
  modelTiers: [
    { match: 'opus|neon|orchestrator|argon|gpt-6\\.2-sol|gpt-5\\.5|sol$', tier: 'heavy' },
    { match: 'sonnet|carbon|gpt-oss|gpt-6-luna|luna|pro', tier: 'standard' },
    { match: 'flash|hydrogen|mini|lite|haiku', tier: 'light' }
  ],
  avoidModels: ['argon', 'gpt-oss'], // Do not assign Argon or low-capacity/128k gpt-oss unless explicitly requested
  avoidInstances: ['claudeApi'], // Never spend pay-per-token API credits automatically; use subscriptions only
  reserveAccounts: { codex: ['GlenNeely'] },
  fallbackPricePerM: { light: 0.4, standard: 4, heavy: 12 },
  heavyKeywords: [
    'refactor', 'implement', 'regression', 'debug', 'architecture', 'prove', 'derive',
    'migrate', 'design', 'optimi[sz]e', 'multi-step', 'write code', 'fix the bug',
    'full test', 'end-to-end', 'thesis', 'proof'
  ],
  lightKeywords: [
    'check', 'status', 'summari[sz]e', 'list', 'remind', 'triage', 'nothing new',
    'watch', 'lookup', 'look up', 'look into', 'look in', 'search', 'find', 'see if',
    'scan', 'cited', 'citation', 'papers?', 'forward', 'reply yes', 'usage', 'quota',
    'inbox', 'add', 'put', 'show', 'open', 'read'
  ]
};

export function loadPolicy() {
  try {
    if (!fs.existsSync(POLICY_FILE)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(POLICY_FILE, JSON.stringify(DEFAULT_POLICY, null, 2), 'utf8');
      return DEFAULT_POLICY;
    }
    return { ...DEFAULT_POLICY, ...JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8')) };
  } catch {
    return DEFAULT_POLICY;
  }
}

export function loadRouterState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      const init = { enabled: true, recentRoutes: [] };
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(init, null, 2), 'utf8');
      return init;
    }
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      enabled: parsed.enabled !== false,
      recentRoutes: Array.isArray(parsed.recentRoutes) ? parsed.recentRoutes : []
    };
  } catch {
    return { enabled: true, recentRoutes: [] };
  }
}

export function saveRouterState(next) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = {
      enabled: next.enabled !== false,
      recentRoutes: (next.recentRoutes || []).slice(0, 20)
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(out, null, 2), 'utf8');
    return out;
  } catch {
    return next;
  }
}

export function setRouterEnabled(enabled) {
  const cur = loadRouterState();
  cur.enabled = !!enabled;
  return saveRouterState(cur);
}

function recordRoute(entry) {
  const cur = loadRouterState();
  cur.recentRoutes.unshift({ at: new Date().toISOString(), ...entry });
  cur.recentRoutes = cur.recentRoutes.slice(0, 20);
  saveRouterState(cur);
}

const slug = (s) => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '');

export async function loadCatalog(force = false) {
  try {
    if (!force && fs.existsSync(CATALOG_FILE)) {
      const cached = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
      if (Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached;
    }
  } catch {}
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const models = {};
    for (const m of json.data || []) {
      if (m.id.includes(':')) continue;
      const p = Number(m.pricing?.prompt) * 1e6;
      const c = Number(m.pricing?.completion) * 1e6;
      if (!Number.isFinite(p) || !Number.isFinite(c)) continue;
      models[slug(m.id.split('/').pop())] = {
        id: m.id,
        promptPerM: p,
        completionPerM: c,
        blendedPerM: (3 * p + c) / 4,
        ctx: m.context_length
      };
    }
    const out = { fetchedAt: Date.now(), source: 'openrouter', models };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CATALOG_FILE, JSON.stringify(out), 'utf8');
    return out;
  } catch {
    try { return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')); } catch { return { fetchedAt: 0, models: {} }; }
  }
}

function priceFor(model, tier, catalog, policy) {
  const hit = catalog.models?.[slug(model.id)] || catalog.models?.[slug(model.label)];
  if (hit) return { perM: hit.blendedPerM, source: `openrouter:${hit.id}` };
  return { perM: policy.fallbackPricePerM[tier] ?? 4, source: 'tier-default' };
}

export function classifyTask(text, policy = loadPolicy()) {
  const t = String(text || '');
  const lower = t.toLowerCase();
  const reasons = [];
  let score = 1;
  if (t.length > 2500) { score += 1; reasons.push('long prompt'); }
  else if (t.length < 280) { score -= 0.6; reasons.push('short prompt'); }
  if (/```|function |class |def |import |\.py\b|\.mjs\b|\.js\b|\.ts\b/.test(t)) {
    score += 0.6;
    reasons.push('contains code');
  }
  const heavyHits = policy.heavyKeywords.filter((k) => new RegExp(`\\b${k}`, 'i').test(lower));
  const lightHits = policy.lightKeywords.filter((k) => new RegExp(`\\b${k}`, 'i').test(lower));
  if (heavyHits.length) {
    score += Math.min(1.5, 0.7 * heavyHits.length);
    reasons.push(`heavy: ${heavyHits.join(', ')}`);
  }
  if (lightHits.length) {
    score -= Math.min(1.5, 0.6 * lightHits.length);
    reasons.push(`light: ${lightHits.join(', ')}`);
  }
  const tier = score >= 1.9 ? 'heavy' : score <= 0.4 ? 'light' : 'standard';
  return { tier, score: Number(score.toFixed(2)), reasons };
}

function modelTier(model, policy) {
  const hay = `${model.id} ${model.label}`.toLowerCase();
  for (const rule of policy.modelTiers) {
    if (new RegExp(rule.match, 'i').test(hay)) return rule.tier;
  }
  return 'standard';
}

function headroomFor(account, model) {
  const poolVals = [];
  const labelKey = String(model.label || model.id).toLowerCase().replace(/\s*\(.*\)/, '');
  for (const pool of account.models || []) {
    const included = (pool.modelsIncluded || []).join(' ').toLowerCase();
    if (included.includes(labelKey)) {
      for (const w of pool.windows || []) {
        if (w && Number.isFinite(w.remainingPercent)) poolVals.push(w);
      }
    }
  }
  if (poolVals.length) {
    const weekly = poolVals.find((w) => /week/i.test(w.label || '')) || account.weekly || null;
    return { percent: Math.min(...poolVals.map((w) => w.remainingPercent)), weekly };
  }
  const vals = [account.fiveHour, account.weekly].filter((w) => w && Number.isFinite(w.remainingPercent));
  if (!vals.length) return { percent: account.routingScore ?? 50, weekly: null };
  return {
    percent: Math.min(...vals.map((w) => w.remainingPercent)),
    weekly: account.weekly || null
  };
}

// -----------------------------------------------------------------------------
// Thread Context Reader (First Goal + Last 12 Substantive Turns from messages.db)
// -----------------------------------------------------------------------------
function getBotSnapshot(botId) {
  try {
    const bots = JSON.parse(fs.readFileSync(path.join(OMB_DATA_DIR, 'bots.json'), 'utf8'));
    return bots.find((b) => b.id === botId || String(b.name || '').toLowerCase() === String(botId || '').toLowerCase()) || null;
  } catch {
    return null;
  }
}

export function getThreadContext(threadId, botId) {
  const bot = getBotSnapshot(botId);
  const taskSnap = bot && threadId ? (bot.tasks || []).find((t) => t.threadId === threadId) : null;
  const effectiveModelSel = taskSnap?.modelSelection || bot?.modelSelection || null;
  const contextTokens = Number(taskSnap?.usage?.context?.tokens || 0);
  const botInfo = bot
    ? { id: bot.id, name: bot.name, title: bot.title || '', description: bot.description || '', threadId: threadId || bot.threadId, modelSelection: effectiveModelSel }
    : { id: botId, name: String(botId || 'bot'), title: '', description: '', threadId, modelSelection: null };

  const tid = threadId || bot?.threadId;
  if (!tid) return { botInfo, firstGoal: '', recentTurns: [], lastTurnFailed: false, contextTokens };

  try {
    const dbPath = path.join(OMB_DATA_DIR, 'messages.db');
    if (!fs.existsSync(dbPath)) return { botInfo, firstGoal: '', recentTurns: [], lastTurnFailed: false, contextTokens };
    const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
    const first = db.prepare(`
      SELECT text FROM messages
      WHERE thread_id = ? AND role = 'user' AND text IS NOT NULL AND trim(text) != ''
      ORDER BY at ASC LIMIT 1
    `).get(tid);
    const recent = db.prepare(`
      SELECT role, kind, text, json FROM messages
      WHERE thread_id = ? AND kind IN ('text', 'digest') AND text IS NOT NULL AND trim(text) != ''
      ORDER BY at DESC LIMIT 12
    `).all(tid);
    db.close();

    let lastTurnFailed = false;
    const lastBot = recent.find((r) => r.role === 'bot');
    if (lastBot) {
      try {
        const meta = JSON.parse(lastBot.json || '{}');
        if (meta.turnSucceeded === false) lastTurnFailed = true;
      } catch {}
      if (!lastTurnFailed && /\bno capacity available\b|\bquota reached\b|\brate.?limit\b|\bcontext.?length\b|\btoo many tokens\b/i.test(lastBot.text || '')) {
        lastTurnFailed = true;
      }
    }

    const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
    return {
      botInfo,
      firstGoal: first ? clip(first.text, 320) : '',
      recentTurns: recent.reverse().map((r) => `[${r.role}/${r.kind}] ${clip(r.text, 240)}`),
      lastTurnFailed,
      contextTokens
    };
  } catch {
    return { botInfo, firstGoal: '', recentTurns: [], lastTurnFailed: false, contextTokens };
  }
}

// -----------------------------------------------------------------------------
// Fast Direct Flash AI Judge (gemini-2.5-flash-lite via Antigravity OAuth, ~0.7s)
// -----------------------------------------------------------------------------
const oauthCache = new Map();

function listAntigravityTokens() {
  const dir = path.join(OMB_DATA_DIR, 'providers', 'antigravity');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const sub of fs.readdirSync(dir)) {
    const p = path.join(dir, sub, 'antigravity-acp', 'acp_token.json');
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}

async function getAccessTokenForFile(tokenFile) {
  const cached = oauthCache.get(tokenFile);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached;
  const creds = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token
    }),
    signal: AbortSignal.timeout(3000)
  });
  if (!res.ok) throw new Error(`OAuth HTTP ${res.status}`);
  const tok = await res.json();
  if (!tok.access_token) throw new Error('No access_token');
  const entry = {
    accessToken: tok.access_token,
    projectId: creds.project_id,
    expiresAt: Date.now() + (Number(tok.expires_in) || 3500) * 1000
  };
  oauthCache.set(tokenFile, entry);
  return entry;
}

export async function aiJudgeTask({ botInfo, firstGoal, recentTurns, prompt }) {
  const tokens = listAntigravityTokens();
  if (!tokens.length) return null;

  const sysPrompt = [
    'You are a fast model-tier router for an AI agent hub. Choose the lowest tier that will succeed cleanly:',
    '- "light": searching/scanning local files, papers, citations, or spreadsheets; finding names/references; adding items to a list/table; quick inbox/calendar checks; simple lookups; status updates; short replies; reminders; summarizing text.',
    '- "standard": normal writing/drafting emails or reports, multi-step web/form automation, moderate data analysis, standard scripts or small code edits.',
    '- "heavy": complex coding/debugging/refactoring, multi-file engineering, test regressions, mathematical proofs, deep thesis/research synthesis.',
    'Use the thread history (especially the original goal and recent turns) so short follow-ups like "do the next part" inherit the true task difficulty.',
    'Reply ONLY with JSON: {"tier":"light|standard|heavy","reason":"<=10 words"}.'
  ].join('\n');

  const userContent = [
    `Bot: ${botInfo.name}${botInfo.title ? ` (${botInfo.title})` : ''}`,
    botInfo.description ? `Role: ${botInfo.description.slice(0, 180)}` : '',
    firstGoal ? `Thread original goal: ${firstGoal}` : '',
    recentTurns.length ? `Recent thread turns:\n${recentTurns.join('\n')}` : 'Recent thread turns: (new thread)',
    `New user prompt: ${String(prompt || '').slice(0, 1200)}`
  ].filter(Boolean).join('\n\n');

  for (const tf of tokens) {
    try {
      const auth = await getAccessTokenForFile(tf);
      const res = await fetch('https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          'User-Agent': `antigravity/hub/2.24.0 (aidev_client; os_type=${process.platform}; arch=${process.arch}; cl=963137146)`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          project: auth.projectId,
          model: 'gemini-2.5-flash-lite',
          request: {
            contents: [{ role: 'user', parts: [{ text: `${sysPrompt}\n\n---\n${userContent}` }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 120, responseMimeType: 'application/json' }
          }
        }),
        signal: AbortSignal.timeout(4000)
      });
      if (!res.ok) continue;
      const data = await res.json();
      const parts = data?.response?.candidates?.[0]?.content?.parts || [];
      const rawText = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('').trim();
      const parsed = JSON.parse(rawText);
      if (parsed && ['light', 'standard', 'heavy'].includes(parsed.tier)) {
        return {
          tier: parsed.tier,
          reason: String(parsed.reason || 'AI context judge').slice(0, 80),
          judge: 'ai:gemini-2.5-flash-lite'
        };
      }
    } catch {}
  }
  return null;
}

// -----------------------------------------------------------------------------
// Core Routing Engine
// -----------------------------------------------------------------------------
export async function routeTask({ text, botName, tier: forcedTier, allowances, catalog, policy, contextTokens = 0 } = {}) {
  policy = policy || loadPolicy();
  catalog = catalog || (await loadCatalog());
  if (!allowances) {
    const res = await fetch(`${HUB}/api/hub/allowances`, { signal: AbortSignal.timeout(15000) });
    allowances = await res.json();
  }
  const cls = forcedTier ? { tier: forcedTier, score: null, reasons: ['forced tier'] } : classifyTask(text, policy);
  const need = TIER[cls.tier];
  const candidates = [];

  for (const acct of allowances.accounts || []) {
    if (acct.authenticated === false) continue;
    if ((policy.avoidInstances || []).includes(acct.instanceId) || acct.access === 'api') continue;
    const key = `${acct.displayName} ${acct.instanceId} ${acct.email || ''}`.toLowerCase();
    let reserved = false;
    for (const [who, bots] of Object.entries(policy.reserveAccounts || {})) {
      if (key.includes(who.toLowerCase()) && botName && !bots.map((b) => b.toLowerCase()).includes(String(botName).toLowerCase())) {
        reserved = true;
      }
    }
    if (reserved) continue;

    for (const m of acct.availableModels || []) {
      if (policy.avoidModels.some((a) => `${m.id} ${m.label}`.toLowerCase().includes(a))) continue;
      if (contextTokens > 85000) {
        const catHit = catalog.models?.[slug(m.id)] || catalog.models?.[slug(m.label)];
        if (catHit?.ctx && catHit.ctx < 200000) continue;
      }
      const mt = modelTier(m, policy);
      // Light tasks -> any tier; Standard -> standard/heavy; Heavy -> standard (e.g. Sonnet) or heavy (only pure light/mini models excluded)
      if (need === TIER.standard && TIER[mt] < TIER.standard) continue;
      if (need === TIER.heavy && TIER[mt] < TIER.standard) continue;
      const hr = headroomFor(acct, m);
      if (hr.percent < policy.minHeadroomPercent) continue;
      const price = priceFor(m, mt, catalog, policy);

      // Score driven by Moji's 3 parameters: (1) Allowance %, (2) Reset time, (3) Online $/1M Price
      let score = hr.percent;

      // 2. Reset time: boost expiring 5h/weekly quotas ("use it or lose it"), pace long-resetting low pools
      const fiveH = acct.fiveHour;
      if (fiveH && fiveH.hoursUntilReset != null && fiveH.hoursUntilReset <= 3 && fiveH.remainingPercent >= 25) {
        score += 12;
      }
      if (hr.weekly && hr.weekly.hoursUntilReset != null) {
        if (hr.weekly.hoursUntilReset <= 36 && hr.weekly.remainingPercent >= 25) {
          score += 18;
        } else if (hr.weekly.hoursUntilReset > 96 && hr.weekly.remainingPercent < 55) {
          score -= 10;
        }
      }

      // 3. Price: stronger cost sensitivity on light/standard tasks, gentler on heavy tasks so affordable Sonnet beats pricey Opus
      const priceWeight = need === TIER.light ? 24 : need === TIER.standard ? 16 : 10;
      score -= Math.log10(price.perM + 1) * priceWeight;
      // Small quality tie-breaker on heavy tasks only if allowance & price are close
      if (need === TIER.heavy && mt === 'heavy') score += 4;

      candidates.push({
        account: acct.displayName,
        instanceId: acct.instanceId,
        email: acct.email,
        model: m.id,
        modelLabel: m.label,
        modelTier: mt,
        headroomPercent: Number(hr.percent.toFixed(1)),
        pricePerMTokens: Number(price.perM.toFixed(3)),
        priceSource: price.source,
        score: Number(score.toFixed(1))
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return {
    ok: candidates.length > 0,
    classification: cls,
    recommendation: candidates[0] || null,
    alternatives: candidates.slice(1, 4),
    catalog: {
      source: catalog.source || 'none',
      ageHours: catalog.fetchedAt ? Number(((Date.now() - catalog.fetchedAt) / 3600000).toFixed(1)) : null,
      models: Object.keys(catalog.models || {}).length
    },
    note: candidates.length ? undefined : 'No account has enough headroom for this tier; wait for a reset or lower the tier.'
  };
}

export async function applyRoute(botNameOrId, rec, threadId) {
  const bot = getBotSnapshot(botNameOrId);
  if (bot) {
    const tid = threadId || bot.threadId;
    const res = await fetch(`${OMB}/api/bots/${encodeURIComponent(bot.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(tid ? { threadId: tid } : {}),
        modelSelection: { instanceId: rec.instanceId, model: rec.model }
      }),
      signal: AbortSignal.timeout(6000)
    });
    if (res.ok) return { ok: true, botId: bot.id, threadId: tid, modelSelection: { instanceId: rec.instanceId, model: rec.model } };
  }
  const res = await fetch(`${HUB}/api/hub/switch-bot-account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botName: botNameOrId, account: rec.instanceId, model: rec.model }),
    signal: AbortSignal.timeout(8000)
  });
  return res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
}

// -----------------------------------------------------------------------------
// Automatic Pre-Turn Router (called by server.js on POST /api/bots/:id/messages)
// -----------------------------------------------------------------------------
const QUICK_ACK_RE = /^(ok|okay|yes|yep|yeah|no|nope|go|continue|resume|retry|done|send|send it|send that|send that email|looks good|sounds good|proceed|please proceed|thanks|thank you)[.!?\s]*$/i;

export async function autoRouteMessage({ botId, threadId, text, allowances } = {}) {
  const t0 = Date.now();
  const state = loadRouterState();
  if (!state.enabled) return { skipped: true, reason: 'auto-route off' };

  const prompt = String(text || '').trim();
  if (!prompt) return { skipped: true, reason: 'empty prompt' };

  const ctx = getThreadContext(threadId, botId);
  const botName = ctx.botInfo.name;

  // 1. Scheduled routines: keep on light without burning AI judge
  const isRoutine = /^\[Scheduled routine\b/i.test(prompt) || /Trigger id:/i.test(prompt);
  // 2. Short confirmations: keep current model (0 extra tokens) unless current account is low
  const isQuickAck = prompt.length <= 40 && QUICK_ACK_RE.test(prompt);

  const policy = loadPolicy();
  const curModelLow = String(ctx.botInfo.modelSelection?.model || '').toLowerCase();
  const currentModelAvoided = Boolean(curModelLow && (policy.avoidModels || []).some((a) => curModelLow.includes(String(a).toLowerCase())));

  if (isQuickAck && !ctx.lastTurnFailed && !currentModelAvoided) {
    // Only check if current account is healthy (using cached allowances if available)
    if (allowances && ctx.botInfo.modelSelection?.instanceId) {
      const curAcct = (allowances.accounts || []).find((a) => a.instanceId === ctx.botInfo.modelSelection.instanceId);
      const curMin = curAcct ? Math.min(...[curAcct.fiveHour?.remainingPercent, curAcct.weekly?.remainingPercent].filter(Number.isFinite)) : 100;
      if (curMin >= policy.minHeadroomPercent) {
        return { skipped: true, reason: 'quick confirmation (kept current model)' };
      }
    } else {
      return { skipped: true, reason: 'quick confirmation (kept current model)' };
    }
  }

  let decided = null;
  if (isRoutine) {
    decided = { tier: 'light', reason: 'scheduled routine', judge: 'bypass:routine' };
  } else if (/#heavy\b/i.test(prompt)) {
    decided = { tier: 'heavy', reason: 'explicit #heavy tag', judge: 'override' };
  } else if (/#light\b/i.test(prompt)) {
    decided = { tier: 'light', reason: 'explicit #light tag', judge: 'override' };
  } else if (/#standard\b/i.test(prompt)) {
    decided = { tier: 'standard', reason: 'explicit #standard tag', judge: 'override' };
  } else {
    decided = await aiJudgeTask({
      botInfo: ctx.botInfo,
      firstGoal: ctx.firstGoal,
      recentTurns: ctx.recentTurns,
      prompt
    });
  }

  const routed = await routeTask({
    text: prompt,
    botName,
    tier: decided?.tier,
    allowances,
    policy,
    contextTokens: ctx.contextTokens
  });

  if (!routed.ok || !routed.recommendation) {
    return { skipped: true, reason: routed.note || 'no eligible route' };
  }

  const rec = routed.recommendation;
  const curSel = ctx.botInfo.modelSelection;
  const alreadyOnTarget = curSel && curSel.instanceId === rec.instanceId && curSel.model === rec.model;

  let applied = { ok: true, unchanged: true };
  if (!alreadyOnTarget) {
    applied = await applyRoute(ctx.botInfo.id, rec, ctx.botInfo.threadId);
  }

  const summary = {
    botId: ctx.botInfo.id,
    botName,
    tier: decided?.tier || routed.classification.tier,
    reason: decided?.reason || routed.classification.reasons.join(', ') || 'classified',
    judge: decided?.judge || 'heuristic',
    account: rec.account,
    instanceId: rec.instanceId,
    model: rec.model,
    modelLabel: rec.modelLabel,
    headroomPercent: rec.headroomPercent,
    pricePerMTokens: rec.pricePerMTokens,
    switched: !alreadyOnTarget && !!applied?.ok,
    ms: Date.now() - t0
  };
  recordRoute(summary);
  return { ok: true, ...summary };
}
