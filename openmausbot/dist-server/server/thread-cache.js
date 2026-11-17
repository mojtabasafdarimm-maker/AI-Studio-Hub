/** A conversation nobody read or wrote for this long gives its parsed transcript back; the next read reloads it from messages.db. */
export const THREAD_IDLE_MS = 10 * 60_000;
const SWEEP_EVERY_MS = 60_000;
/** Parsed transcripts kept in memory at most, as approxBytes counts them; OMB_THREAD_CACHE_MB overrides. Past it the
 * least recently used go first, but never a busy conversation's, the one just read, or one read in the last few seconds. */
export const THREAD_CACHE_MAX_BYTES = (Number(process.env.OMB_THREAD_CACHE_MB) > 0 ? Number(process.env.OMB_THREAD_CACHE_MB) : 256) * 1024 * 1024;
const MIN_RESIDENCY_MS = 5_000;
/** About what a value holds: its strings' lengths and a few bytes per field. Walks fields, never copies text. */
export function approxBytes(value, depth = 0) {
    if (typeof value === "string")
        return value.length;
    if (value === null || typeof value !== "object" || depth > 8)
        return 8;
    let bytes = 16;
    if (Array.isArray(value))
        for (const item of value)
            bytes += approxBytes(item, depth + 1);
    else
        for (const key in value)
            bytes += key.length + approxBytes(value[key], depth + 1);
    return bytes;
}
export class ThreadCache {
    entries = new Map();
    sweptAt = Date.now();
    bytes = 0;
    busyThreadIds;
    maxBytes;
    constructor(busyThreadIds, maxBytes = THREAD_CACHE_MAX_BYTES) {
        this.busyThreadIds = busyThreadIds;
        this.maxBytes = maxBytes;
    }
    get(threadId) {
        const now = Date.now();
        this.sweep(now);
        const entry = this.entries.get(threadId);
        if (!entry)
            return undefined;
        // Last in the map is the most recently used.
        entry.usedAt = now;
        this.entries.delete(threadId);
        this.entries.set(threadId, entry);
        return entry.state;
    }
    /** Rows stored without a parentId chain onto the row before them. */
    load(threadId, rows) {
        const { messages } = rows;
        let prev = null;
        let bytes = 0;
        for (const m of messages) {
            if (m.parentId === undefined)
                m.parentId = prev;
            prev = m.id;
            bytes += approxBytes(m);
        }
        const state = { messages, activeLeafId: rows.activeLeafId || (messages.at(-1)?.id ?? null) };
        this.delete(threadId);
        this.entries.set(threadId, { state, usedAt: Date.now(), bytes });
        this.bytes += bytes;
        this.shrink(threadId);
        return state;
    }
    /** A cached transcript gained `added` (and lost `removed`, a message it replaced). */
    grew(threadId, added, removed) {
        const entry = this.entries.get(threadId);
        if (!entry)
            return;
        const change = approxBytes(added) - (removed ? approxBytes(removed) : 0);
        entry.bytes += change;
        this.bytes += change;
        if (change > 0)
            this.shrink(threadId);
    }
    delete(threadId) {
        const entry = this.entries.get(threadId);
        if (!entry)
            return;
        this.bytes -= entry.bytes;
        this.entries.delete(threadId);
    }
    get size() {
        return this.entries.size;
    }
    get approxBytes() {
        return this.bytes;
    }
    shrink(keep) {
        if (this.bytes <= this.maxBytes)
            return;
        const now = Date.now();
        const busy = this.busyThreadIds();
        for (const [threadId, entry] of this.entries) {
            if (this.bytes <= this.maxBytes)
                break;
            if (threadId === keep || busy.has(threadId) || now - entry.usedAt < MIN_RESIDENCY_MS)
                continue;
            this.delete(threadId);
        }
    }
    sweep(now) {
        if (now - this.sweptAt < SWEEP_EVERY_MS)
            return;
        this.sweptAt = now;
        let busy;
        for (const [threadId, entry] of this.entries) {
            if (now - entry.usedAt < THREAD_IDLE_MS)
                continue;
            busy ??= this.busyThreadIds();
            if (!busy.has(threadId))
                this.delete(threadId);
        }
    }
}
