// A conversation whose engine hit its usage limit, or was signed out, continues on the configured backup, and goes back to
// its own engine once that limit has reset or it is signed in again.
import { readFileSync } from "node:fs";
import { otherSignInOfSameSubscription } from "../shared/limit-backup.js";
import { sameModelSelection } from "../shared/thread-model.js";
import { writeFileAtomic } from "./atomic.js";
import { hostTimeZone } from "./turn-clock.js";
/** An engine instance with one of these keys bills each use instead of drawing on a subscription's limit. */
const PAY_PER_USE_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "XAI_API_KEY"];
/** Whether `to` may take over a turn `from`'s usage limit refused. Never the same engine, and never another sign-in to
 * the same subscription engine: rotating accounts to get past a provider's usage limit breaks its terms and can get the
 * accounts closed. Another engine, or a pay-per-use key on the same one, is fine. */
export function limitBackupAllowed(from, to, toConfig) {
    if (to.instanceId === from.instanceId)
        return false;
    if (!otherSignInOfSameSubscription(from, to))
        return true;
    return billsEachUse(toConfig);
}
/** An engine instance that bills each use (a pay-per-use key, as its access or in its environment) instead of drawing on
 * a plan's limit. */
export function billsEachUse(config) {
    return config?.access === "api" || PAY_PER_USE_KEYS.some((key) => Boolean(config?.environment?.[key]?.trim()));
}
export function resetClock(at, timeZone = hostTimeZone()) {
    try {
        const sameDay = new Date(at).toDateString() === new Date().toDateString();
        return new Date(at).toLocaleString("en-US", { ...(sameDay ? {} : { weekday: "short" }), hour: "numeric", minute: "2-digit", timeZone });
    }
    catch {
        return new Date(at).toISOString().slice(11, 16) + " UTC";
    }
}
/** "Claude hit its limit (resets 3:40 PM), so Codex took over." */
export function failoverLine(from, to, resetsAt) {
    return `${from} hit its limit${resetsAt ? ` (resets ${resetClock(resetsAt)})` : ""}, so ${to} took over.`;
}
export function backLine(engine, why) {
    return why === "signed-out" ? `${engine} is signed in again, so this conversation is back on ${engine}.`
        : `${engine}'s limit has reset, so this conversation is back on ${engine}.`;
}
/** "Claude is signed out, so Codex took over." */
export function signedOutLine(from, to) {
    return `${from} is signed out, so ${to} took over.`;
}
/** With no reset time known, a conversation tries its own engine again no sooner than this. */
const UNKNOWN_RESET_WAIT_MS = 60 * 60_000;
function load(file) {
    try {
        const rows = JSON.parse(readFileSync(file, "utf8"));
        return Array.isArray(rows) ? rows.filter((row) => typeof row?.botId === "string" && typeof row?.threadId === "string" &&
            typeof row?.from?.instanceId === "string" && typeof row?.to?.instanceId === "string" && (row.resetsAt === null || Number.isFinite(row.resetsAt)) &&
            Number.isFinite(row.at) && (row.why === undefined || row.why === "signed-out")) : [];
    }
    catch {
        return [];
    }
}
export class LimitFailovers {
    deps;
    rows;
    constructor(deps) {
        this.deps = deps;
        this.rows = load(deps.file);
    }
    /** A thread moved to `to` because `from`'s usage limit refused it, or `from` was signed out. */
    record(failover) {
        const earlier = this.rows.find((row) => row.threadId === failover.threadId);
        // A second failover keeps the engine the conversation started on, so it still goes back there.
        const from = earlier && sameModelSelection(earlier.to, failover.from) ? earlier.from : failover.from;
        // A reset already past when the limit refused names no time: the engine's own hold decides when it goes back.
        const resetsAt = failover.resetsAt !== null && failover.resetsAt > failover.at ? failover.resetsAt : null;
        this.rows = [...this.rows.filter((row) => row.threadId !== failover.threadId), { ...failover, from, resetsAt }].slice(-500);
        this.save();
    }
    /** Before a turn: a thread on a backup goes back to its own engine once that engine's limit has reset, or it is
     * signed in again, with one line saying so. A thread someone moved to another model since is left alone. */
    restore(botId, threadId) {
        const row = this.rows.find((candidate) => candidate.threadId === threadId && candidate.botId === botId);
        if (!row)
            return false;
        const now = this.deps.now?.() ?? Date.now();
        const current = this.deps.threadModel(botId, threadId);
        if (!current || !sameModelSelection(current, row.to))
            return this.forget(threadId);
        const waitUntil = row.why === "signed-out" ? row.at : row.resetsAt ?? row.at + UNKNOWN_RESET_WAIT_MS;
        if (waitUntil > now || this.deps.blockedUntil(row.from.instanceId, row.from.model) !== null)
            return false;
        if (row.why === "signed-out" && this.deps.signedOut?.(row.from.instanceId))
            return false;
        if (!this.deps.switchBack(row))
            return false;
        this.forget(threadId);
        this.deps.note(threadId, backLine(this.deps.engineName(row.from.instanceId), row.why), row.why === "signed-out" ? { key: "chat.notice.failoverSignedInAgain", params: { engine: this.deps.engineName(row.from.instanceId) } } : undefined);
        return true;
    }
    forget(threadId) {
        const kept = this.rows.filter((row) => row.threadId !== threadId);
        if (kept.length !== this.rows.length) {
            this.rows = kept;
            this.save();
        }
        return false;
    }
    list() {
        return this.rows.map((row) => ({ ...row }));
    }
    save() {
        try {
            writeFileAtomic(this.deps.file, JSON.stringify(this.rows, null, 2), { mode: 0o600 });
        }
        catch (error) {
            console.error(`limit failovers: could not save: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
