// hub-router.mjs — Subscription-aware task router for AI Studio Hub.
//
// Fits your exact setup: bots run on *accounts* (Codex, 3x Google/Antigravity) instead of per-token APIs.
// The router:
//   1. Classifies a task into a capability tier (light / standard / heavy)
//   2. Reads live allowance headroom for every connected account (from /api/hub/allowances)
//   3. Fetches each model's public $/1M token price from OpenRouter's live catalog (no API key needed)
//      as a relative cost weight (with fallback tier weights)
//   4. Picks the most cost-effective capable model on the account with the most usable headroom
//   5. Optionally takes over and switches the bot to that account/model via /api/hub/switch-bot-account
//
// Editable policy: %LOCALAPPDATA%\AIStudioHub\router-policy.json (auto-created on first run).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './hub-core.mjs';

const POLICY_FILE = path.join(DATA_DIR, 'router-policy.json');
const CATALOG_FILE = path.join(DATA_DIR, 'model-catalog.json');
const CATALOG_TTL_MS = 24 * 3600 * 1000;
const HUB = 'http://127.0.0.1:4747';

const TIER = { light: 0, standard: 1, heavy: 2 };

export const DEFAULT_POLICY = {
  minHeadroomPercent: 12,
  modelTiers: [
    { match: 'opus|neon|orchestrator|argon|gpt-6\\.2-sol|gpt-5\\.5|sol$', tier: 'heavy' },
    { match: 'sonnet|carbon|gpt-oss|gpt-6-luna|luna|pro', tier: 'standard' },
    { match: 'flash|hydrogen|mini|lite|haiku', tier: 'light' }
  ],
  avoidModels: ['argon'], // Do not assign Argon unless explicitly requested
  reserveAccounts: { codex: ['GlenNeely'] },
  fallbackPricePerM: { light: 0.4, standard: 4, heavy: 12 },
  heavyKeywords: [
    'refactor', 'implement', 'regression', 'debug', 'architecture', 'prove', 'derive',
    'migrate', 'design', 'optimi[sz]e', 'multi-step', 'write code', 'fix the bug',
    'full test', 'end-to-end', 'thesis', 'proof'
  ],
  lightKeywords: [
    'check', 'status', 'summari[sz]e', 'list', 'remind', 'triage', 'nothing new',
    'watch', 'lookup', 'look up', 'forward', 'reply yes', 'usage', 'quota', 'inbox'
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

const slug = (s) => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '');

export async function loadCatalog(force = false) {
  try {
    if (!force && fs.existsSync(CATALOG_FILE)) {
      const cached = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
      if (Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached;
    }
  } catch {}
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(12000) });
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
  else if (t.length < 280) { score -= 0.5; reasons.push('short prompt'); }
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

export async function routeTask({ text, botName, tier: forcedTier, allowances, catalog, policy } = {}) {
  policy = policy || loadPolicy();
  catalog = catalog || (await loadCatalog());
  if (!allowances) {
    const res = await fetch(`${HUB}/api/hub/allowances`, { signal: AbortSignal.timeout(20000) });
    allowances = await res.json();
  }
  const cls = forcedTier ? { tier: forcedTier, score: null, reasons: ['forced tier'] } : classifyTask(text, policy);
  const need = TIER[cls.tier];
  const candidates = [];

  for (const acct of allowances.accounts || []) {
    if (acct.authenticated === false) continue;
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
      const mt = modelTier(m, policy);
      if (TIER[mt] < need) continue;
      const hr = headroomFor(acct, m);
      if (hr.percent < policy.minHeadroomPercent) continue;
      const price = priceFor(m, mt, catalog, policy);

      let score = hr.percent; // Prefer accounts with higher remaining quota
      score -= (TIER[mt] - need) * 25; // Avoid burning a heavy model on a light task
      score -= Math.log10(price.perM + 1) * 14; // Relative cost weight from OpenRouter pricing
      if (hr.weekly && hr.weekly.hoursUntilReset != null && hr.weekly.hoursUntilReset < 24 && hr.weekly.remainingPercent > 30) {
        score += 15; // Use-it-or-lose-it bonus if weekly quota resets within 24h
      }

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

export async function applyRoute(botName, rec) {
  const res = await fetch(`${HUB}/api/hub/switch-bot-account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botName, account: rec.instanceId, model: rec.model }),
    signal: AbortSignal.timeout(12000)
  });
  return res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
}
