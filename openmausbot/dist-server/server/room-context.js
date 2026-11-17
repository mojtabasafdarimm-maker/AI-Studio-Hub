import { contextWindowFor } from "./context-budget.js";
import { sessionIdlePolicy } from "./drivers/session-idle.js";
import { serverLine } from "./server-lines.js";
export const DEFAULT_ROOM_COMPACT_AT = 0.9;
export function roomCompactTokens(window, settings) {
    if (settings?.autoCompact === false)
        return null;
    const at = settings?.roomCompactAt;
    const value = typeof at === "number" && Number.isFinite(at) && at > 0 ? at : DEFAULT_ROOM_COMPACT_AT;
    return value < 1 ? Math.floor(window * value) : Math.floor(value);
}
export function roomResetNote(name, reset, language) {
    return serverLine(language, reset.reason === "requested" ? "server.rooms.compactedRequested" : "server.rooms.compactedThreshold", { bot: name, percent: reset.percent });
}
export class RoomContextTracker {
    threads = new Map();
    dispatchedOn = new Map();
    clock;
    idleMs;
    constructor(clock = {}) {
        this.clock = clock;
        this.idleMs = clock.idleMs ?? Math.max(sessionIdlePolicy("CLAUDE").idleMs, sessionIdlePolicy("ACP").idleMs);
    }
    record(threadId, botId, reading, model, catalog) {
        const tokens = reading?.tokens;
        if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0)
            return;
        const members = this.threads.get(threadId) ?? new Map();
        const previous = this.live(threadId, botId);
        const instanceId = this.dispatchedOn.get(threadId)?.get(botId);
        const measured = {
            tokens: Math.trunc(tokens),
            window: contextWindowFor(model, catalog, reading?.window),
            ...(previous?.compactRequested ? { compactRequested: true } : {}),
            ...(instanceId ? { instanceId } : {}),
            at: this.now(),
        };
        members.set(botId, measured);
        this.threads.set(threadId, members);
        this.watch(threadId, botId, measured);
    }
    request(threadId, botId) {
        const current = this.live(threadId, botId);
        if (!current)
            return false;
        current.compactRequested = true;
        return true;
    }
    forThread(threadId) {
        const members = this.threads.get(threadId);
        if (!members)
            return undefined;
        for (const botId of members.keys())
            this.live(threadId, botId);
        if (!members.size)
            return undefined;
        return Object.fromEntries([...members].map(([botId, { tokens, window, compactRequested }]) => [botId, { tokens, window, ...(compactRequested ? { compactRequested } : {}) }]));
    }
    dispatch(threadId, botId, instanceId, settings) {
        const reset = this.takeReset(threadId, botId, settings);
        return { reset, displaced: this.dispatched(threadId, botId, instanceId) };
    }
    /** Each engine keeps one warm process per thread, so this turn closes the other members' processes on its engine. */
    dispatched(threadId, botId, instanceId) {
        const engines = this.dispatchedOn.get(threadId) ?? new Map();
        engines.set(botId, instanceId);
        this.dispatchedOn.set(threadId, engines);
        const members = this.threads.get(threadId);
        if (!members)
            return false;
        let dropped = false;
        for (const [other, reading] of members) {
            // A reading from before its engine was known is assumed to share it.
            if (other === botId || (reading.instanceId && reading.instanceId !== instanceId))
                continue;
            members.delete(other);
            dropped = true;
        }
        if (!members.size)
            this.threads.delete(threadId);
        return dropped;
    }
    takeReset(threadId, botId, settings) {
        const current = this.live(threadId, botId);
        const members = this.threads.get(threadId);
        if (!members || !current)
            return null;
        const percent = Math.round((current.tokens / current.window) * 100);
        const limit = roomCompactTokens(current.window, settings);
        const reason = current.compactRequested ? "requested" : limit !== null && current.tokens >= limit ? "threshold" : null;
        if (!reason)
            return null;
        members.delete(botId);
        if (!members.size)
            this.threads.delete(threadId);
        return { reason, percent };
    }
    forget(threadId) {
        this.threads.delete(threadId);
        this.dispatchedOn.delete(threadId);
    }
    now() {
        return this.clock.now?.() ?? Date.now();
    }
    warmUntil(threadId, reading) {
        return Math.max(reading.at + this.idleMs, this.clock.heldUntil?.(threadId) ?? 0);
    }
    watch(threadId, botId, reading) {
        const expired = this.clock.expired;
        if (!expired)
            return;
        const check = () => {
            if (this.threads.get(threadId)?.get(botId) !== reading)
                return;
            if (this.live(threadId, botId))
                return arm(this.warmUntil(threadId, reading) - this.now());
            expired(threadId);
        };
        const arm = (ms) => {
            const timer = setTimeout(check, Math.min(2_147_483_647, Math.max(0, ms)));
            timer.unref?.();
        };
        arm(this.warmUntil(threadId, reading) - this.now());
    }
    live(threadId, botId) {
        const members = this.threads.get(threadId);
        const current = members?.get(botId);
        if (!members || !current)
            return undefined;
        if (this.now() < this.warmUntil(threadId, current))
            return current;
        members.delete(botId);
        if (!members.size)
            this.threads.delete(threadId);
        return undefined;
    }
}
