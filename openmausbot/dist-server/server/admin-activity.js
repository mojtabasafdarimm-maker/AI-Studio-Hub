// Who changed what on this server: one NDJSON file per UTC month under <data>/admin-activity, 0600, pruned by the decision
// log's retention window. Values are redacted (credential-named keys and every headers/env value become "[hidden]") and
// nothing is sent anywhere. Fire-and-forget: a full disk must not undo a setting that already took effect.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { actorLabel, boundRetentionDays, pruneMonthFiles } from "./decision-log.js";
import { redactSecrets } from "./redact.js";
import { csvCell, monthKey } from "./usage-ledger.js";
export const ADMIN_ACTIVITY_CATEGORIES = ["config", "people", "session", "webhook", "bot-api", "mcp", "engine", "bot", "budget", "visibility"];
const DIR = "admin-activity";
const MONTH_FILE = /^(\d{4})-(\d{2})\.ndjson$/;
const PRUNE_EVERY_MS = 60 * 60_000;
const writeQueues = new Map();
const lastPrune = new Map();
export function adminActivityFileFor(dataDir, at) {
    return join(dataDir, DIR, `${monthKey(at)}.ndjson`);
}
async function writeRow(dataDir, row) {
    const at = new Date(row.at);
    await mkdir(join(dataDir, DIR), { recursive: true, mode: 0o700 });
    await appendFile(adminActivityFileFor(dataDir, at), JSON.stringify(row) + "\n", { mode: 0o600 });
    if (at.getTime() - (lastPrune.get(dataDir) ?? 0) >= PRUNE_EVERY_MS) {
        lastPrune.set(dataDir, at.getTime());
        await pruneMonthFiles(join(dataDir, DIR), boundRetentionDays(), at);
    }
}
/** Append one row. Its values are redacted here, at the moment of writing. */
export function appendAdminAction(dataDir, row) {
    const record = {
        ...row,
        at: row.at ?? new Date().toISOString(),
        ...(row.before ? { before: auditValues(row.before) } : {}),
        ...(row.after ? { after: auditValues(row.after) } : {}),
    };
    const previous = writeQueues.get(dataDir) ?? Promise.resolve();
    const queued = previous.then(() => writeRow(dataDir, record)).catch(() => {
    });
    writeQueues.set(dataDir, queued);
    void queued.finally(() => {
        if (writeQueues.get(dataDir) === queued)
            writeQueues.delete(dataDir);
    });
}
/** Never throws; writing prunes too, and the server runs this on a timer for quiet days. */
export function pruneAdminActivity(dataDir, days = boundRetentionDays(), now = new Date()) {
    return pruneMonthFiles(join(dataDir, DIR), days, now);
}
export async function flushAdminActivity(dataDir) {
    await writeQueues.get(dataDir);
}
/** Name parts that mark a credential (case-insensitive substring), plus `key` alone or as a suffix (apiKey, xai_key). */
const SECRET_PARTS = ["token", "secret", "password", "passwd", "passphrase", "credential", "authorization", "cookie", "bearer", "apikey", "api_key"];
/** Maps whose every value may be a credential: keep the names, hide values. */
const OPAQUE_MAP = /^(?:headers|env|environment)$/i;
const MAX_VALUE_CHARS = 2_000;
const HIDDEN = "[hidden]";
function isSecretName(name) {
    const lower = name.toLowerCase();
    // Counts, not credentials: maxTokens, contextTokens.
    if (lower.endsWith("tokens"))
        return false;
    if (SECRET_PARTS.some((part) => lower.includes(part)))
        return true;
    return /(?:^|[_.-])keys?$/.test(lower) || /[a-z]Keys?$/.test(name);
}
/** A command-line flag or URL parameter that names a credential:
 * `--api-key`, `--token=…`, `?key=`, `&access_token=`, `?sig=`. */
function isSecretParameter(name) {
    // `-k` is the usual short form of --key (curl-style CLIs and many MCP servers).
    if (name === "-k" || name === "-K")
        return true;
    const bare = name.replace(/^-+/, "");
    return isSecretName(bare) || /^(?:auth|sig|signature|pass|pwd|code)$/i.test(bare);
}
/** A run of 16+ mixed letters and digits (Zapier's `/s/<key>/sse`, a Slack hook's last part); a slug or a UUID is not. */
function keyLikeSegment(segment) {
    return (segment.match(/[A-Za-z0-9]{16,}/g) ?? []).some((run) => /\d/.test(run) && /[A-Za-z]/.test(run));
}
/** Credentials before the host (`user:pass@`, `TOKEN@`), key-like path segments, and credential-named query or fragment values. */
function maskUrlSecrets(text) {
    return text.replace(/\b([a-z][\w+.-]*:\/\/)([^\s/?#]*)([^\s?#]*)([^\s]*)/gi, (_all, scheme, authority, path, rest) => {
        const at = authority.lastIndexOf("@");
        const host = at >= 0 ? `${HIDDEN}@${authority.slice(at + 1)}` : authority;
        const maskedPath = path.split("/").map((segment) => (keyLikeSegment(segment) ? HIDDEN : segment)).join("/");
        const maskedRest = rest.replace(/([?&;#])([^=&#\s]+)=([^&#\s]+)/g, (all, separator, name) => (isSecretParameter(name) ? `${separator}${name}=${HIDDEN}` : all));
        return `${scheme}${host}${maskedPath}${maskedRest}`;
    });
}
/** An argument list: the value after a credential flag, or after its `=`. */
function maskArgs(items) {
    return items.map((item, index) => {
        const previous = items[index - 1];
        if (typeof item !== "string")
            return item;
        if (typeof previous === "string" && /^--?[\w-]+$/.test(previous) && isSecretParameter(previous))
            return HIDDEN;
        const inline = /^(--?[\w-]+)=(.+)$/.exec(item);
        return inline && isSecretParameter(inline[1]) ? `${inline[1]}=${HIDDEN}` : item;
    });
}
function scrub(value, depth, hideAll) {
    if (value === undefined || value === null || value === "")
        return value;
    if (hideAll && typeof value !== "object")
        return HIDDEN;
    if (typeof value === "string")
        return redactSecrets(maskUrlSecrets(value));
    if (typeof value !== "object")
        return value;
    if (depth > 6)
        return "[…]";
    if (Array.isArray(value))
        return maskArgs(value.slice(0, 100)).map((item) => scrub(item, depth + 1, hideAll));
    const out = {};
    for (const [key, child] of Object.entries(value)) {
        if (isSecretName(key) && child !== undefined && child !== null && child !== "")
            out[key] = HIDDEN;
        else
            out[key] = scrub(child, depth + 1, hideAll || OPAQUE_MAP.test(key));
    }
    return out;
}
/** A path's last segment decides too (`anthropic.key` is a key); a value too large for an audit row is summarised. */
export function auditValues(values) {
    const out = {};
    for (const [path, value] of Object.entries(values)) {
        const segments = path.split(".");
        const last = segments.at(-1) ?? path;
        const opaque = segments.slice(0, -1).some((segment) => OPAQUE_MAP.test(segment));
        const scrubbed = (isSecretName(last) || opaque) && value !== undefined && value !== null && value !== ""
            ? HIDDEN
            : scrub(value, 0, OPAQUE_MAP.test(last));
        const text = JSON.stringify(scrubbed);
        out[path] = text !== undefined && text.length > MAX_VALUE_CHARS ? "[large value]" : scrubbed ?? null;
    }
    return out;
}
const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
function stable(value) {
    if (Array.isArray(value))
        return `[${value.map(stable).join(",")}]`;
    if (isPlainObject(value))
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value) ?? "undefined";
}
export function changedPaths(before, after, depth = 3, prefix = "") {
    if (stable(before) === stable(after))
        return [];
    if (before === undefined && isPlainObject(after))
        before = {};
    if (after === undefined && isPlainObject(before))
        after = {};
    if (depth > 0 && isPlainObject(before) && isPlainObject(after)) {
        const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
        return keys.flatMap((key) => changedPaths(before[key], after[key], depth - 1, prefix ? `${prefix}.${key}` : key));
    }
    return [prefix || "(all)"];
}
export function valueAt(source, path) {
    let value = source;
    for (const segment of path.split(".")) {
        if (!isPlainObject(value))
            return undefined;
        value = value[segment];
    }
    return value;
}
const pick = (source, paths) => Object.fromEntries(paths.map((path) => [path, valueAt(source, path) ?? null]));
const CONFIG_CATEGORY = {
    signIn: "people",
    budgets: "budget",
    usageCaps: "budget",
    billing: "budget",
    mcpServers: "mcp",
    instances: "engine",
    anthropic: "engine",
    openaiCompat: "engine",
    xai: "engine",
    opencodeGo: "engine",
    defaultModelSelection: "engine",
};
export function configChangeRows(before, after) {
    const paths = changedPaths(isPlainObject(before) ? before : {}, isPlainObject(after) ? after : {});
    const byCategory = new Map();
    for (const path of paths) {
        const category = CONFIG_CATEGORY[path.split(".")[0]] ?? "config";
        byCategory.set(category, [...(byCategory.get(category) ?? []), path]);
    }
    return [...byCategory].map(([category, changed]) => ({
        category,
        action: `${category}.update`,
        target: { kind: "settings" },
        changed,
        before: pick(before, changed),
        after: pick(after, changed),
    }));
}
/** What a bot may do, where, and who may see it; display fields (colour, unread, pins) are not audited. */
export const BOT_AUDIT_FIELDS = [
    "approvalMode", "autoApprove", "alwaysAllow", "computer", "cloudBackend", "autoStartVps", "vpsAlias",
    "cwd", "composio", "browser", "browserProfile", "mcpServers", "chiefOfStaff", "managedSections", "section",
    "parkDirectMessages", "hidden", "modelSelection", "helperModel", "visibility",
];
/** A Team Cloud's bots are everyone's: who renamed one, recoloured it or changed its instructions is recorded too. */
export const TEAM_BOT_AUDIT_FIELDS = [...BOT_AUDIT_FIELDS, "name", "title", "description", "soul", "color"];
export function botAuditSnapshot(bot, fields = BOT_AUDIT_FIELDS) {
    if (!bot)
        return null;
    // "everyone" and no field are one audience.
    const present = (field) => bot[field] !== undefined && !(field === "visibility" && bot[field] === "everyone");
    return Object.fromEntries(fields.filter(present).map((field) => [field, field === "soul" ? textDigest(bot[field]) : structuredClone(bot[field])]));
}
/** Instructions may hold anything a person typed: the log keeps only that they changed. */
function textDigest(value) {
    const text = String(value);
    return { length: text.length, sha256: createHash("sha256").update(text).digest("hex").slice(0, 12) };
}
export function botChangeRows(target, before, after, only, fields = BOT_AUDIT_FIELDS) {
    if (!before || !after)
        return [];
    const changed = fields.filter((field) => (!only || only.includes(field)) && stable(before[field]) !== stable(after[field]));
    const rows = [];
    const bot = { kind: "bot", id: target.id, ...(target.name ? { name: target.name } : {}) };
    if (changed.includes("visibility")) {
        const audience = (value) => value ?? "everyone";
        rows.push({
            category: "visibility", action: "visibility.update", target: bot, changed: ["visibility"],
            before: { visibility: audience(before.visibility) }, after: { visibility: audience(after.visibility) },
        });
    }
    const rest = changed.filter((field) => field !== "visibility");
    if (rest.length)
        rows.push({ category: "bot", action: "bot.update", target: bot, changed: rest, before: pick(before, rest), after: pick(after, rest) });
    return rows;
}
/** An email sign-in list that lets more than one person in: any member, a
 * second admin, or a whole @domain. */
export function sharedSignIn(lists) {
    return lists.members.length > 0 || lists.admins.length > 1 || [...lists.admins, ...lists.members].some((entry) => entry.trim().startsWith("@"));
}
export function signInListsOf(config) {
    const signIn = isPlainObject(config) && isPlainObject(config.signIn) ? config.signIn : {};
    const list = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : []);
    return { admins: list(signIn.admins), members: list(signIn.members) };
}
const isRow = (value) => isPlainObject(value) &&
    typeof value.at === "string" &&
    typeof value.category === "string" &&
    typeof value.action === "string" &&
    isPlainObject(value.actor);
function readRows(path) {
    let text;
    try {
        text = readFileSync(path, "utf8");
    }
    catch {
        return [];
    }
    const rows = [];
    for (const line of text.split("\n")) {
        if (!line)
            continue;
        try {
            const value = JSON.parse(line);
            if (isRow(value))
                rows.push(value);
        }
        catch {
        }
    }
    return rows;
}
export function readAdminActivityRange(dataDir, range) {
    let months = [];
    try {
        months = readdirSync(join(dataDir, DIR)).filter((name) => MONTH_FILE.test(name)).sort();
    }
    catch {
        return [];
    }
    const first = monthKey(range.from);
    const last = monthKey(range.to);
    const from = range.from.getTime();
    const to = range.to.getTime();
    const rows = [];
    for (const name of months) {
        const month = basename(name, ".ndjson");
        if (month < first || month > last)
            continue;
        for (const row of readRows(join(dataDir, DIR, name))) {
            const at = Date.parse(row.at);
            if (at >= from && at <= to)
                rows.push(row);
        }
    }
    return rows;
}
export function adminActorLabel(actor) {
    if (actor?.kind === "cli")
        return "Command line";
    return actorLabel(actor);
}
export function parseActivityWhat(value) {
    if (!value)
        return "all";
    if (value === "all" || value === "approvals" || value === "decisions")
        return value;
    return ADMIN_ACTIVITY_CATEGORIES.includes(value) ? value : null;
}
export function activityEntries(decisions, actions, filter) {
    const who = filter.who?.trim().toLowerCase() ?? "";
    const entries = [];
    const wantDecision = (row) => filter.what === "decisions" || ((filter.what === "all" || filter.what === "approvals") && row.source === "user");
    for (const row of decisions) {
        if (!wantDecision(row))
            continue;
        const clean = redactSecrets(row);
        entries.push({
            type: "approval",
            at: clean.at,
            who: clean.actor ? actorLabel(clean.actor) : "",
            what: clean.decision,
            source: clean.source,
            ...(clean.botName || clean.botId ? { bot: clean.botName || clean.botId } : {}),
            ...(clean.tool ? { tool: clean.tool } : {}),
            ...(clean.summary ? { summary: clean.summary, summaryCode: clean.summaryCode, summaryParams: clean.summaryParams } : {}),
            threadId: clean.threadId,
            ...(clean.requestId ? { requestId: clean.requestId } : {}),
        });
    }
    if (filter.what !== "approvals" && filter.what !== "decisions") {
        for (const row of actions) {
            if (filter.what !== "all" && row.category !== filter.what)
                continue;
            entries.push({
                type: "admin",
                at: row.at,
                who: adminActorLabel(row.actor),
                what: row.category,
                action: row.action,
                ...(row.target ? { target: row.target } : {}),
                ...(row.changed ? { changed: row.changed } : {}),
                ...(row.before ? { before: row.before } : {}),
                ...(row.after ? { after: row.after } : {}),
            });
        }
    }
    const matched = who ? entries.filter((entry) => entry.who.toLowerCase().includes(who)) : entries;
    return matched.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
/** Cells are formula-neutralised; values were redacted when the rows were written. */
export function activityCsv(entries) {
    const header = ["time", "type", "who", "what", "action", "target", "changed", "before", "after", "bot", "tool", "summary", "thread"];
    const lines = [header.join(",")];
    for (const entry of entries) {
        const cells = entry.type === "approval"
            ? [entry.at, "approval", entry.who, entry.what, entry.source, "", "", "", "", entry.bot ?? "", entry.tool ?? "", entry.summary ?? "", entry.threadId]
            : [
                entry.at, "admin", entry.who, entry.what, entry.action,
                entry.target ? entry.target.name ?? entry.target.id ?? entry.target.kind : "",
                (entry.changed ?? []).join(" "),
                entry.before ? JSON.stringify(entry.before) : "",
                entry.after ? JSON.stringify(entry.after) : "",
                "", "", "", "",
            ];
        lines.push(cells.map(csvCell).join(","));
    }
    return lines.join("\n") + "\n";
}
