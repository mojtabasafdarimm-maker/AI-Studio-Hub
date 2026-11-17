// Access tokens stay in the request header only, never in the JSON result.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveClaudeConfigDir } from "./drivers/claude.js";
import { codexHome } from "./drivers/codex-identity.js";
import { antigravityPlanUsage } from "./drivers/antigravity-usage-limits.js";
import { harnessHome, sealedFixture } from "./env-path.js";
const PROVIDER_TIMEOUT_MS = 8_000;
const PLAN_USAGE_CACHE_MS = 45_000;
const CREDENTIAL_READ_MAX_BYTES = 1_000_000;
const KEYCHAIN_TIMEOUT_MS = 5_000;
const KEYCHAIN_MAX_BUFFER = 1_000_000;
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_MODEL_FAMILIES = ["opus", "sonnet", "haiku"];
const MONTHLY_SPEND = "Monthly spend";
const EXTRA_USAGE = "Extra Usage";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const GROK_CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
const GROK_SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";
// OpenCode Go's own allowance: the rolling window, the weekly one and the month's, as the CLI reads them.
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const FIVE_HOUR_MIN_SECONDS = 3 * 3600;
const FIVE_HOUR_MAX_SECONDS = 8 * 3600;
const WEEK_MIN_SECONDS = 5 * 86400;
const WEEK_MAX_SECONDS = 9 * 86400;
const MONTH_MIN_SECONDS = 27 * 86400;
const MONTH_MAX_SECONDS = 32 * 86400;
const DRIVER_OF = { claudeAgent: "claude", codex: "codex", grokAgent: "grok", opencodeGo: "opencode", antigravityAgent: "antigravity" };
const PRODUCT_NAME = {
    claude: "Claude",
    codex: "Codex",
    grok: "Grok",
    opencode: "OpenCode",
    antigravity: "Antigravity",
};
export function planAccountsFromInstances(instances) {
    const accounts = [];
    for (const [id, entry] of Object.entries(instances)) {
        const driver = DRIVER_OF[entry.driver];
        if (!driver)
            continue;
        const config = asRecord(entry.config);
        const configDir = typeof config?.configDir === "string" ? config.configDir : undefined;
        accounts.push({
            id,
            name: entry.displayName?.trim() || PRODUCT_NAME[driver],
            driver,
            environment: { ...entry.environment },
            ...(configDir ? { configDir } : {}),
            // Reading ~/.codex/auth.json for a ChatGPT-plan provider would report (and hold it on) another account's limit.
            ...(config?.authMode === "chatgpt-plan" || (driver === "claude" && config?.usageMeter === false) ? { noUsage: true } : {}),
        });
    }
    return accounts;
}
export function parseClaudeUsage(body) {
    const root = claudeRoot(body);
    const extra = [];
    const models = [];
    if (root) {
        for (const [key, value] of Object.entries(root)) {
            if (key === "five_hour" || key === "seven_day" || key === "spend" || key === "extra_usage")
                continue;
            if (!/^[a-z][a-z0-9_]{0,40}$/i.test(key))
                continue;
            const window = readClaudeWindow(value);
            if (!window)
                continue;
            const model = claudeModelWindow(key);
            if (model)
                addModelWindow(models, model.name, extraLine(model.window, window));
            else
                extra.push(extraLine(claudeExtraLabel(key), window));
        }
    }
    sortModelWindows(models);
    const fiveHour = (root && readClaudeWindow(root.five_hour)) ?? closedWindow();
    const weekly = (root && readClaudeWindow(root.seven_day)) ?? closedWindow();
    const budget = root && readClaudeBudget(root, fiveHour.available || weekly.available);
    if (budget)
        extra.unshift(budget);
    return {
        plan: planLabel(root?.subscription_type ?? root?.plan ?? root?.plan_type),
        fiveHour,
        weekly,
        extra,
        models,
    };
}
export function parseCodexUsage(body) {
    const root = asRecord(body);
    const assigned = assignDurationWindows(durationWindows(root?.rate_limit));
    const models = [];
    const extra = [...assigned.extra];
    if (root)
        collectCodexNamedLimits(root, models, extra);
    sortModelWindows(models);
    return { ...assigned, extra, models, plan: planLabel(root?.plan_type ?? root?.plan) };
}
export function parseGrokUsage(credits, billing, settings) {
    let fiveHour = closedWindow();
    let weekly = closedWindow();
    const extra = [];
    const models = [];
    let sawMonthly = false;
    const place = (sample) => {
        if (!sample)
            return;
        const window = openWindow(sample.used, sample.resetsAt);
        if (sample.slot === "fiveHour") {
            if (!fiveHour.available)
                fiveHour = window;
        }
        else if (sample.slot === "weekly") {
            if (!weekly.available)
                weekly = window;
        }
        else if (sample.slot === "monthly") {
            if (!sawMonthly) {
                sawMonthly = true;
                extra.push(extraLine("Monthly", window));
            }
        }
        else {
            extra.push(extraLine(sample.seconds == null ? "Credits" : durationLabel(sample.seconds), window));
        }
    };
    const creditSample = readGrokSample(credits);
    place(creditSample);
    const productSample = creditSample ?? { used: 0, slot: "other", resetsAt: null, seconds: null };
    for (const model of readGrokProducts(credits, productSample))
        addModelWindow(models, model.name, model.window);
    if (billing !== undefined)
        place(readGrokSample(billing));
    sortModelWindows(models);
    return { plan: grokPlan(settings), fiveHour, weekly, extra, models };
}
/** OpenCode Go answers with a meter per window: the running one, the week's and the month's. */
export function parseOpenCodeUsage(body) {
    const usage = asRecord(asRecord(body)?.usage);
    const [rolling, weekly, monthly] = [usage?.rolling, usage?.weekly, usage?.monthly].map(openCodeMeter);
    return {
        plan: rolling || weekly || monthly ? "Go" : null,
        fiveHour: rolling ?? closedWindow(),
        weekly: weekly ?? closedWindow(),
        extra: monthly ? [extraLine("Monthly", monthly)] : [], models: [],
    };
}
/** One meter of Go's allowance: `percent` is what it has used, and `resetsAt` comes as an ISO stamp. */
function openCodeMeter(value) {
    const record = asRecord(value);
    const used = finiteNumber(record?.percent);
    if (used == null)
        return null;
    return openWindow(used, isoOrNull(record?.resetsAt));
}
export function fileCredentialReader(source) {
    const env = source.env ?? process.env;
    const now = source.now ?? Date.now;
    return {
        async read(account) {
            const merged = { ...env, ...account.environment };
            const at = now();
            if (account.driver === "claude")
                return readClaudeCredential(account, merged, source, at);
            if (account.driver === "codex")
                return readCodexCredential(merged, source.readText, at);
            if (account.driver === "opencode")
                return readOpenCodeCredential(merged, source.readText, at);
            return readGrokCredential(merged, source.readText, at);
        },
    };
}
export function defaultCredentialReader(env = process.env) {
    return fileCredentialReader({
        env,
        readText(path) {
            try {
                const stat = statSync(path);
                if (!stat.isFile() || stat.size > CREDENTIAL_READ_MAX_BYTES)
                    return null;
                return readFileSync(path, "utf8");
            }
            catch {
                return null;
            }
        },
        ...(process.platform === "darwin" && !sealedFixture() ? { readClaudeKeychain: readDarwinClaudeKeychain } : {}),
    });
}
export async function fetchPlanUsage(accounts, deps) {
    const now = deps.now?.() ?? Date.now();
    const providers = (await Promise.all(accounts.filter((account) => !account.noUsage).map((account) => fetchProvider(account, deps)))).filter((row) => row !== null);
    return { fetchedAt: new Date(now).toISOString(), providers };
}
let cachedReport = null;
export function clearPlanUsageCache() {
    cachedReport = null;
}
export async function loadPlanUsage(input) {
    const now = input.now ?? Date.now();
    const key = planUsageCacheKey(input.accounts);
    if (!input.refresh && cachedReport && now - cachedReport.at < PLAN_USAGE_CACHE_MS) { // a read of more accounts serves a caller that asks for some of them (the limit clock)
        if (cachedReport.key === key)
            return cachedReport.report;
        if (input.accounts.every((account) => cachedReport.accounts.has(planUsageCacheKey([account]))))
            return { ...cachedReport.report, providers: cachedReport.report.providers.filter((row) => input.accounts.some((account) => account.id === row.id)) };
    }
    const report = await fetchPlanUsage(input.accounts, {
        fetch: input.fetch ?? ((url, init) => globalThis.fetch(url, init)),
        credentials: input.credentials ?? defaultCredentialReader(input.env),
        now: () => now,
        timeoutMs: input.timeoutMs,
    });
    cachedReport = { at: now, key, accounts: new Set(input.accounts.map((account) => planUsageCacheKey([account]))), report };
    return report;
}
function closedWindow() {
    return { available: false, remainingPercent: null, usedPercent: null, resetsAt: null };
}
function openWindow(usedPercent, resetsAt) {
    const used = clampPercent(usedPercent);
    return {
        available: true,
        usedPercent: used,
        remainingPercent: clampPercent(100 - used),
        resetsAt,
    };
}
function extraLine(label, window) {
    return {
        label,
        remainingPercent: window.remainingPercent ?? 0,
        usedPercent: window.usedPercent ?? 0,
        resetsAt: window.resetsAt,
    };
}
function clampPercent(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.min(100, Math.max(0, value));
}
function asRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    return value;
}
function finiteNumber(value) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return null;
    return value;
}
function timeMs(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.abs(value) >= 1e12 ? value : value * 1000;
    }
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 80)
        return null;
    if (/^\d+(\.\d+)?$/.test(trimmed))
        return timeMs(Number(trimmed));
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
}
function isoOrNull(value) {
    const ms = timeMs(value);
    if (ms == null)
        return null;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function planLabel(value) {
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 80 || /[\r\n]/.test(trimmed))
        return null;
    if (/bearer\s|access_token|refresh_token|sk-ant-|eyJ[a-zA-Z0-9_-]{8,}/i.test(trimmed))
        return null;
    return trimmed;
}
function secretString(value) {
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 16_000 || /[\r\n]/.test(trimmed))
        return null;
    return trimmed;
}
function parseJson(text) {
    if (!text)
        return null;
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
function missingCredential() {
    return { token: null, accountId: null, expired: false };
}
function expiredCredential() {
    return { token: null, accountId: null, expired: true };
}
function signInAgain(driver) {
    return `Sign in again in ${PRODUCT_NAME[driver]}`;
}
function couldNotReach(driver) {
    return `Could not reach ${PRODUCT_NAME[driver]}`;
}
function unexpectedUsage(driver) {
    return `${PRODUCT_NAME[driver]} returned an unexpected usage response`;
}
function claudeRoot(body) {
    const root = asRecord(body);
    if (!root)
        return null;
    if ("five_hour" in root || "seven_day" in root)
        return root;
    const nested = asRecord(root.usage) ?? asRecord(root.windows);
    if (nested && ("five_hour" in nested || "seven_day" in nested))
        return nested;
    return root;
}
function readClaudeWindow(value) {
    const record = asRecord(value);
    if (!record)
        return null;
    const utilization = finiteNumber(record.utilization);
    if (utilization == null)
        return null;
    return openWindow(utilization, isoOrNull(record.resets_at ?? record.resetsAt));
}
const naturalNumber = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
/** A currency code as the provider sent it, when Intl can name it: Intl.NumberFormat throws on anything else. */
function currencyCode(value) {
    if (typeof value !== "string" || !/^[A-Za-z]{3}$/.test(value.trim()))
        return null;
    return value.trim().toUpperCase();
}
function budgetLine(label, spend) {
    if (spend.limitMinor <= 0)
        return null;
    return { ...extraLine(label, openWindow((spend.usedMinor / spend.limitMinor) * 100, null)), spend };
}
function readSpendBudget(value) {
    const spend = asRecord(value);
    if (spend?.enabled !== true)
        return null;
    const used = asRecord(spend.used), limit = asRecord(spend.limit);
    const currency = currencyCode(used?.currency);
    const exponent = naturalNumber(used?.exponent), usedMinor = naturalNumber(used?.amount_minor), limitMinor = naturalNumber(limit?.amount_minor);
    if (!currency || currency !== currencyCode(limit?.currency) || exponent === null || exponent !== limit?.exponent || usedMinor === null || limitMinor === null)
        return null;
    return budgetLine(MONTHLY_SPEND, { usedMinor, limitMinor, currency, exponent });
}
/** Claude Code 2.1.312 documents `used_credits` and `monthly_limit` as minor units of `currency` ("cents for USD") and has
 * no field saying how many digits those are, so the currency says. `is_enabled` false: this budget cannot cover a send. */
function readExtraUsage(value, label) {
    const extra = asRecord(value);
    if (extra?.is_enabled !== true)
        return null;
    const currency = currencyCode(extra.currency);
    const usedMinor = naturalNumber(extra.used_credits), limitMinor = naturalNumber(extra.monthly_limit);
    if (currency && usedMinor !== null && limitMinor !== null) {
        const exponent = naturalNumber(extra.decimal_places) ?? currencyDigits(currency);
        const line = exponent === null ? null : budgetLine(label, { usedMinor, limitMinor, currency, exponent });
        if (line)
            return line;
    }
    const used = finiteNumber(extra.utilization);
    return used === null ? null : extraLine(label, openWindow(used, null));
}
function currencyDigits(currency) {
    try {
        return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? null;
    }
    catch {
        return null;
    }
}
/** Whether Claude's paid extra usage is on and not used up, on a plan with rolling windows: sends then go on past a
 * full window and are paid from it. */
export function claudeHasExtraUsageRoom(row) {
    if (row.driver !== "claude" || !(row.fiveHour.available || row.weekly.available))
        return false;
    const budget = row.extra[0];
    return !!budget && (budget.label === EXTRA_USAGE || budget.label === MONTHLY_SPEND) && budget.usedPercent < 100;
}
/** A plan with no rolling windows lives on its monthly budget (Claude Enterprise); on others that budget is the extra usage
 * bought on top of them. */
function readClaudeBudget(root, hasWindows) {
    return readSpendBudget(root.spend) ?? readExtraUsage(root.extra_usage, hasWindows ? EXTRA_USAGE : MONTHLY_SPEND);
}
function claudeExtraLabel(key) {
    const suffix = key.startsWith("seven_day_")
        ? key.slice("seven_day_".length)
        : key.replace(/^five_hour_/, "");
    return titleWords(suffix);
}
function titleWords(suffix) {
    const words = suffix.split("_").filter((part) => part.length > 0);
    if (words.length === 0)
        return "Window";
    return words.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(" ");
}
function claudeModelWindow(key) {
    const weekly = key.startsWith("seven_day_");
    const fiveHour = key.startsWith("five_hour_");
    if (!weekly && !fiveHour)
        return null;
    const suffix = key.slice(weekly ? "seven_day_".length : "five_hour_".length);
    const lower = suffix.toLowerCase();
    const family = CLAUDE_MODEL_FAMILIES.find((name) => lower === name || lower.startsWith(`${name}_`));
    if (!family)
        return null;
    return { name: titleWords(suffix), window: weekly ? "Weekly" : "5-hour" };
}
function addModelWindow(models, name, line) {
    const found = models.find((model) => model.name.toLowerCase() === name.toLowerCase());
    if (found)
        found.windows.push(line);
    else
        models.push({ name, windows: [line] });
}
function sortModelWindows(models) {
    const rank = (label) => (label === "5-hour" ? 0 : label === "Weekly" ? 1 : 2);
    for (const model of models)
        model.windows.sort((a, b) => rank(a.label) - rank(b.label));
}
function readDurationWindow(value) {
    const record = asRecord(value);
    if (!record)
        return null;
    const used = finiteNumber(record.used_percent);
    let seconds = finiteNumber(record.limit_window_seconds);
    if (seconds == null) {
        const minutes = finiteNumber(record.window_minutes);
        if (minutes != null)
            seconds = minutes * 60;
    }
    if (used == null || seconds == null || seconds <= 0)
        return null;
    return { used, seconds, resetsAt: isoOrNull(record.reset_at ?? record.resetAt) };
}
function durationWindows(node) {
    const record = asRecord(node);
    if (!record)
        return [];
    const source = asRecord(record.rate_limit) ?? record;
    const windows = [];
    for (const key of ["primary_window", "secondary_window"]) {
        const window = readDurationWindow(source[key]);
        if (window)
            windows.push(window);
    }
    if (windows.length === 0) {
        const self = readDurationWindow(source);
        if (self)
            windows.push(self);
    }
    return windows;
}
function codexLimitName(record) {
    return planLabel(record.limit_name) ?? planLabel(record.metered_feature) ?? planLabel(record.name);
}
function pushAssignedLines(assigned, into) {
    if (assigned.fiveHour.available)
        into.push(extraLine("5-hour", assigned.fiveHour));
    if (assigned.weekly.available)
        into.push(extraLine("Weekly", assigned.weekly));
    into.push(...assigned.extra);
}
function collectCodexNamedLimits(root, models, extra) {
    const buckets = [];
    if (root.code_review_rate_limit)
        buckets.push({ name: "Code review", node: root.code_review_rate_limit });
    const additional = root.additional_rate_limits;
    if (Array.isArray(additional)) {
        for (const item of additional) {
            const record = asRecord(item);
            buckets.push({ name: record ? codexLimitName(record) : null, node: item });
        }
    }
    else {
        const named = asRecord(additional);
        if (named) {
            for (const [key, value] of Object.entries(named))
                buckets.push({ name: planLabel(key), node: value });
        }
    }
    for (const bucket of buckets) {
        const assigned = assignDurationWindows(durationWindows(bucket.node));
        if (!bucket.name) {
            pushAssignedLines(assigned, extra);
            continue;
        }
        const lines = [];
        pushAssignedLines(assigned, lines);
        for (const line of lines)
            addModelWindow(models, bucket.name, line);
    }
}
function readGrokProducts(body, sample) {
    const root = asRecord(body);
    if (!root)
        return [];
    const config = asRecord(root.config) ?? root;
    if (!Array.isArray(config.productUsage))
        return [];
    const label = sample.slot === "fiveHour" ? "5-hour" : sample.slot === "weekly" ? "Weekly" : sample.slot === "monthly" ? "Monthly" : "Used";
    const rows = [];
    for (const item of config.productUsage) {
        const record = asRecord(item);
        if (!record)
            continue;
        const raw = typeof record.product === "string" ? record.product : typeof record.name === "string" ? record.name : "";
        const name = planLabel(raw.replace(/([a-z])([A-Z])/g, "$1 $2"));
        const used = finiteNumber(record.usagePercent ?? record.usedPercent ?? record.utilization);
        if (!name || used == null)
            continue;
        rows.push({ name, window: extraLine(label, openWindow(used, sample.resetsAt)) });
    }
    return rows;
}
function durationLabel(seconds) {
    if (seconds >= 86400)
        return `${Math.max(1, Math.round(seconds / 86400))}-day`;
    if (seconds >= 3600)
        return `${Math.max(1, Math.round(seconds / 3600))}-hour`;
    return `${Math.max(1, Math.round(seconds / 60))}-minute`;
}
function assignDurationWindows(windows) {
    let fiveHour = closedWindow();
    let weekly = closedWindow();
    const extra = [];
    for (const window of windows) {
        const open = openWindow(window.used, window.resetsAt);
        const fiveHourSlot = window.seconds >= FIVE_HOUR_MIN_SECONDS && window.seconds <= FIVE_HOUR_MAX_SECONDS;
        const weeklySlot = window.seconds >= WEEK_MIN_SECONDS && window.seconds <= WEEK_MAX_SECONDS;
        if (fiveHourSlot && !fiveHour.available)
            fiveHour = open;
        else if (weeklySlot && !weekly.available)
            weekly = open;
        else
            extra.push(extraLine(durationLabel(window.seconds), open));
    }
    return { plan: null, fiveHour, weekly, extra, models: [] };
}
function classifyGrok(typeValue, seconds) {
    const type = typeof typeValue === "string" ? typeValue.toUpperCase() : "";
    if (type.includes("WEEK"))
        return "weekly";
    if (type.includes("MONTH"))
        return "monthly";
    if (/(^|[^A-Z0-9])(5|FIVE)[^A-Z0-9]*HOUR/.test(type))
        return "fiveHour";
    if (seconds == null)
        return "other";
    if (seconds >= FIVE_HOUR_MIN_SECONDS && seconds <= FIVE_HOUR_MAX_SECONDS)
        return "fiveHour";
    if (seconds >= WEEK_MIN_SECONDS && seconds <= WEEK_MAX_SECONDS)
        return "weekly";
    if (seconds >= MONTH_MIN_SECONDS && seconds <= MONTH_MAX_SECONDS)
        return "monthly";
    return "other";
}
function readGrokSample(body) {
    const root = asRecord(body);
    if (!root)
        return null;
    const config = asRecord(root.config) ?? root;
    let used = finiteNumber(config.creditUsagePercent);
    if (used == null) {
        const cap = finiteNumber(asRecord(config.onDemandCap)?.val ?? config.onDemandCap);
        const spent = finiteNumber(asRecord(config.onDemandUsed)?.val ?? config.onDemandUsed);
        if (cap != null && spent != null && cap > 0)
            used = (spent / cap) * 100;
    }
    if (used == null)
        return null;
    const period = asRecord(config.currentPeriod);
    const type = period?.type ?? period?.period ?? config.period ?? config.interval;
    const start = period?.start ?? period?.periodStart;
    const end = period?.end ?? period?.periodEnd ?? config.billingPeriodEnd ?? root.billingPeriodEnd;
    const startMs = timeMs(start);
    const endMs = timeMs(end);
    const seconds = startMs != null && endMs != null && endMs > startMs ? (endMs - startMs) / 1000 : null;
    return { used, slot: classifyGrok(type, seconds), resetsAt: isoOrNull(end), seconds };
}
function grokPlan(settings) {
    const root = asRecord(settings);
    if (!root)
        return null;
    const nested = asRecord(root.settings);
    return planLabel(nested?.subscription_tier_display ?? root.subscription_tier_display);
}
function planUsageCacheKey(accounts) {
    return accounts.map((account) => {
        const environment = Object.entries(account.environment)
            .filter((entry) => typeof entry[1] === "string")
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([name, value]) => `${name}=${value}`)
            .join("\n");
        return [account.id, account.driver, account.name, account.configDir ?? "", environment, account.noUsage ? "no-usage" : "usage"].join("\u0000");
    }).join("\n");
}
function claudeCredentialFromText(text, now) {
    const oauth = asRecord(asRecord(parseJson(text))?.claudeAiOauth);
    const token = secretString(oauth?.accessToken);
    if (!token)
        return missingCredential();
    const expiry = timeMs(oauth?.expiresAt);
    if (expiry != null && expiry <= now)
        return expiredCredential();
    return { token, accountId: null, expired: false };
}
/** macOS 26 `security -w` may print the JSON secret as hex. */
function decodeKeychainSecret(raw) {
    if (!raw)
        return null;
    const trimmed = raw.trim();
    if (!trimmed)
        return null;
    if (!trimmed.startsWith("{") && trimmed.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(trimmed)) {
        return Buffer.from(trimmed, "hex").toString("utf8");
    }
    return trimmed;
}
function claudeKeychainServices(account, env, resolvedDir) {
    if (!account.configDir?.trim() && !env.CLAUDE_CONFIG_DIR?.trim())
        return [CLAUDE_KEYCHAIN_SERVICE];
    let defaultDir = null;
    try {
        const withoutConfig = { ...env };
        delete withoutConfig.CLAUDE_CONFIG_DIR;
        defaultDir = resolveClaudeConfigDir(undefined, withoutConfig);
    }
    catch {
        defaultDir = null;
    }
    if (defaultDir != null && resolvedDir === defaultDir)
        return [CLAUDE_KEYCHAIN_SERVICE];
    const suffix = createHash("sha256").update(resolvedDir).digest("hex").slice(0, 8);
    return [`${CLAUDE_KEYCHAIN_SERVICE}-${suffix}`];
}
function readDarwinClaudeKeychain(service) {
    if (process.platform !== "darwin")
        return Promise.resolve(null);
    return new Promise((resolve) => {
        try {
            execFile("security", ["find-generic-password", "-s", service, "-w"], {
                timeout: KEYCHAIN_TIMEOUT_MS,
                maxBuffer: KEYCHAIN_MAX_BUFFER,
                windowsHide: true,
                shell: false,
                encoding: "utf8",
            }, (error, stdout) => {
                resolve(error || !stdout ? null : stdout);
            });
        }
        catch {
            resolve(null);
        }
    });
}
async function readClaudeCredential(account, env, source, now) {
    let resolvedDir;
    try {
        resolvedDir = resolveClaudeConfigDir(account.configDir, env);
    }
    catch {
        return missingCredential();
    }
    const file = claudeCredentialFromText(source.readText(join(resolvedDir, ".credentials.json")), now);
    if (file.token || !source.readClaudeKeychain)
        return file;
    let sawExpired = file.expired;
    for (const service of claudeKeychainServices(account, env, resolvedDir)) {
        let raw = null;
        try {
            raw = (await source.readClaudeKeychain(service)) ?? null;
        }
        catch {
            raw = null;
        }
        const parsed = claudeCredentialFromText(decodeKeychainSecret(raw), now);
        if (parsed.token)
            return parsed;
        if (parsed.expired)
            sawExpired = true;
    }
    return sawExpired ? expiredCredential() : missingCredential();
}
function readCodexCredential(env, readText, now) {
    const home = codexHome(env);
    if (!home)
        return missingCredential();
    const root = asRecord(parseJson(readText(join(home, "auth.json"))));
    if (!root)
        return missingCredential();
    const tokens = asRecord(root.tokens);
    const token = secretString(tokens?.access_token) ?? secretString(root.access_token);
    if (!token)
        return missingCredential();
    const expiry = timeMs(tokens?.expires_at ?? tokens?.expiresAt ?? root.expires_at ?? root.expiresAt);
    if (expiry != null && expiry <= now)
        return expiredCredential();
    const accountId = secretString(tokens?.account_id) ?? secretString(root.account_id);
    return { token, accountId, expired: false };
}
function grokCandidate(record) {
    const token = secretString(record.access_token) ?? secretString(record.key);
    if (!token)
        return null;
    return { token, expiresAt: timeMs(record.expires_at ?? record.expiresAt) };
}
function readGrokCredential(env, readText, now) {
    const rootDir = env.GROK_HOME?.trim() || harnessHome("grok", env);
    const root = asRecord(parseJson(readText(join(rootDir, "auth.json"))));
    if (!root)
        return missingCredential();
    const direct = grokCandidate(root);
    if (direct) {
        if (direct.expiresAt != null && direct.expiresAt <= now)
            return expiredCredential();
        return { token: direct.token, accountId: null, expired: false };
    }
    let sawExpired = false;
    let best = null;
    for (const value of Object.values(root)) {
        const record = asRecord(value);
        if (!record)
            continue;
        const candidate = grokCandidate(record);
        if (!candidate)
            continue;
        if (candidate.expiresAt != null && candidate.expiresAt <= now) {
            sawExpired = true;
            continue;
        }
        const bestStamp = best?.expiresAt ?? Number.NEGATIVE_INFINITY;
        const stamp = candidate.expiresAt ?? Number.NEGATIVE_INFINITY;
        if (!best || stamp >= bestStamp)
            best = candidate;
    }
    if (best)
        return { token: best.token, accountId: null, expired: false };
    return sawExpired ? expiredCredential() : missingCredential();
}
/** The key saved in Settings, or the login `opencode auth login` keeps. `auth.json` is where OpenCode v1 wrote one; v2 keeps credentials in its own database, so this path covers installs migrated from v1 (the saved key covers v2). */
function readOpenCodeCredential(env, readText, now) {
    const key = secretString(env.OPENCODE_API_KEY);
    if (key)
        return { token: key, accountId: null, expired: false };
    const raw = env.OPENCODE_AUTH_CONTENT?.trim() || openCodeAuthText(env, readText);
    const stored = asRecord(parseJson(raw));
    // A Go login lives under "opencode-go", a Zen one under "opencode"; the CLI lists Go first too.
    const entry = [stored?.["opencode-go"], stored?.opencode].map((value) => asRecord(value))
        .find((record) => secretString(record?.access) ?? secretString(record?.key));
    const token = secretString(entry?.access) ?? secretString(entry?.key);
    if (!token)
        return missingCredential();
    const expiry = timeMs(entry?.expires ?? entry?.expires_at ?? entry?.expiresAt);
    if (expiry != null && expiry <= now)
        return expiredCredential();
    return { token, accountId: null, expired: false };
}
/** The CLI is xdg-flavoured on every platform, so the xdg data folder comes first. */
function openCodeAuthText(env, readText) {
    const home = env.HOME || env.USERPROFILE || homedir();
    const roots = [
        env.XDG_DATA_HOME || join(home, ".local", "share"),
        process.platform === "darwin" ? join(home, "Library", "Application Support") : "",
        process.platform === "win32" ? env.LOCALAPPDATA || join(home, "AppData", "Local") : "",
    ].filter(Boolean);
    for (const root of roots) {
        const text = readText(join(root, "opencode", "auth.json"));
        if (text)
            return text;
    }
    return null;
}
function errorRow(account, error) {
    return {
        id: account.id,
        name: account.name,
        driver: account.driver,
        plan: null,
        ok: false,
        error,
        fiveHour: closedWindow(),
        weekly: closedWindow(),
        extra: [],
        models: [],
    };
}
function okRow(account, windows) {
    return {
        id: account.id,
        name: account.name,
        driver: account.driver,
        plan: windows.plan,
        ok: true,
        error: null,
        fiveHour: windows.fiveHour,
        weekly: windows.weekly,
        extra: windows.extra,
        models: windows.models,
    };
}
async function fetchProvider(account, deps) {
    let credential;
    if (account.driver === "antigravity") {
        const windows = await antigravityPlanUsage(account.id, deps);
        return windows && okRow(account, windows);
    } // null: no sign-in, or Google gave nothing
    try {
        credential = await deps.credentials.read(account);
    }
    catch {
        return account.driver === "opencode" ? null : errorRow(account, signInAgain(account.driver));
    }
    if (credential.expired || !credential.token)
        return account.driver === "opencode" && !credential.expired ? null : errorRow(account, signInAgain(account.driver));
    try {
        if (account.driver === "claude")
            return await fetchClaude(account, credential.token, deps);
        if (account.driver === "codex")
            return await fetchCodex(account, credential.token, credential.accountId, deps);
        if (account.driver === "opencode")
            return await fetchOpenCode(account, credential.token, deps);
        return await fetchGrok(account, credential.token, deps);
    }
    catch {
        return errorRow(account, couldNotReach(account.driver));
    }
}
async function fetchJson(fetchImpl, url, headers, timeoutMs) {
    try {
        const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
        let text = "";
        try {
            text = await response.text();
        }
        catch {
            text = "";
        }
        let body = null;
        if (text.trim()) {
            try {
                body = JSON.parse(text);
            }
            catch {
                body = null;
            }
        }
        return { status: response.status, ok: response.ok, body };
    }
    catch {
        return { status: 0, ok: false, body: null };
    }
}
function authRejected(status) {
    return status === 401 || status === 403;
}
async function fetchClaude(account, token, deps) {
    const result = await fetchJson(deps.fetch, CLAUDE_USAGE_URL, {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
    }, deps.timeoutMs ?? PROVIDER_TIMEOUT_MS);
    if (authRejected(result.status))
        return errorRow(account, signInAgain("claude"));
    if (!result.ok || result.body === null || typeof result.body !== "object") {
        return errorRow(account, result.status === 0 || result.status >= 500 ? couldNotReach("claude") : unexpectedUsage("claude"));
    }
    return okRow(account, parseClaudeUsage(result.body));
}
async function fetchCodex(account, token, accountId, deps) {
    const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
    };
    if (accountId)
        headers["ChatGPT-Account-Id"] = accountId;
    const result = await fetchJson(deps.fetch, CODEX_USAGE_URL, headers, deps.timeoutMs ?? PROVIDER_TIMEOUT_MS);
    if (authRejected(result.status))
        return errorRow(account, signInAgain("codex"));
    if (!result.ok || result.body === null || typeof result.body !== "object") {
        return errorRow(account, result.status === 0 || result.status >= 500 ? couldNotReach("codex") : unexpectedUsage("codex"));
    }
    return okRow(account, parseCodexUsage(result.body));
}
async function fetchGrok(account, token, deps) {
    const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "X-XAI-Token-Auth": "xai-grok-cli",
    };
    const timeout = deps.timeoutMs ?? PROVIDER_TIMEOUT_MS;
    const [credits, billing, settings] = await Promise.all([
        fetchJson(deps.fetch, GROK_CREDITS_URL, headers, timeout),
        fetchJson(deps.fetch, GROK_BILLING_URL, headers, timeout),
        fetchJson(deps.fetch, GROK_SETTINGS_URL, headers, timeout),
    ]);
    if (authRejected(credits.status) || (authRejected(billing.status) && !credits.ok)) {
        return errorRow(account, signInAgain("grok"));
    }
    const creditsBody = credits.ok ? credits.body : null;
    const billingBody = billing.ok && !authRejected(billing.status) ? billing.body : null;
    if (creditsBody === null && billingBody === null) {
        return errorRow(account, credits.status === 0 || credits.status >= 500 || billing.status === 0 || billing.status >= 500
            ? couldNotReach("grok")
            : unexpectedUsage("grok"));
    }
    const windows = parseGrokUsage(creditsBody, billingBody ?? undefined, settings.ok ? settings.body : undefined);
    return okRow(account, windows);
}
/** Go's allowance, read with the account's own key or login. A key without a Go subscription answers 403. */
async function fetchOpenCode(account, token, deps) {
    const result = await fetchJson(deps.fetch, OPENCODE_GO_USAGE_URL, { Authorization: `Bearer ${token}`, Accept: "application/json" }, deps.timeoutMs ?? PROVIDER_TIMEOUT_MS);
    // 403 is Go's own answer for a key without a Go subscription: the account works and has no allowance to report.
    if (result.status === 403)
        return okRow(account, { plan: null, fiveHour: closedWindow(), weekly: closedWindow(), extra: [], models: [] });
    if (authRejected(result.status))
        return errorRow(account, "OpenCode refused the saved credentials");
    if (!result.ok || result.body === null || typeof result.body !== "object")
        return errorRow(account, result.status === 0 || result.status >= 500 ? couldNotReach("opencode") : unexpectedUsage("opencode"));
    const windows = parseOpenCodeUsage(result.body);
    // A 200 with no meter at all is not an allowance: it is an answer this row cannot read.
    return windows.plan ? okRow(account, windows) : errorRow(account, unexpectedUsage("opencode"));
}
