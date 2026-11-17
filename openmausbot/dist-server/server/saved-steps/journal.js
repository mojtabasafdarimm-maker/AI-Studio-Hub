export function hostScope(capability) {
    if (capability.kind !== "computer" || capability.localVmTarget || capability.boxId !== undefined || capability.teamComputerId)
        return null;
    return { botId: capability.botId, threadId: capability.threadId, generation: capability.generation };
}
const TOOL_NAME = /^[a-z_][a-z0-9_]{0,63}$/;
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parseJournalEntry(body) {
    if (!isPlainObject(body))
        return null;
    const { tool, arguments: args, result } = body;
    if (typeof tool !== "string" || !TOOL_NAME.test(tool))
        return null;
    if (!isPlainObject(args) || !isPlainObject(result) || typeof result.isError !== "boolean")
        return null;
    return { tool, arguments: args, result: result };
}
function bump(counts, key) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
}
const LOST_GENERATIONS = 64;
export const ENTRY_BYTES = 256 * 1024;
export const TOTAL_BYTES = 32 * 1024 * 1024;
const emptyThread = () => ({ calls: [], checks: new Map(), recorded: new Map(), tainted: new Set(), overflow: new Set(), bytes: 0 });
export class ComputerJournal {
    threads = new Map();
    evicted = new Map();
    callsPerThread;
    maxThreads;
    maxEvicted;
    entryBytes;
    totalBytes;
    bytes = 0;
    constructor(limits = {}) {
        this.callsPerThread = limits.callsPerThread ?? 400;
        this.maxThreads = limits.threads ?? 64;
        this.maxEvicted = limits.evictedThreads ?? 1024;
        this.entryBytes = limits.entryBytes ?? ENTRY_BYTES;
        this.totalBytes = limits.totalBytes ?? TOTAL_BYTES;
    }
    heldBytes() {
        return this.bytes;
    }
    drop(journal) {
        this.bytes -= journal.bytes;
    }
    thread(threadId) {
        let found = this.threads.get(threadId);
        if (found) {
            this.threads.delete(threadId);
            this.threads.set(threadId, found);
            return found;
        }
        found = emptyThread();
        this.threads.set(threadId, found);
        while (this.threads.size > this.maxThreads) {
            const [oldest, journal] = this.threads.entries().next().value;
            this.threads.delete(oldest);
            this.drop(journal);
            this.evict(oldest, journal);
        }
        return found;
    }
    evict(threadId, journal) {
        const tombstone = this.evicted.get(threadId) ?? { generations: new Set(), all: false };
        if (!tombstone.all)
            for (const generation of [...journal.checks.keys(), ...journal.recorded.keys(), ...journal.tainted])
                tombstone.generations.add(generation);
        if (tombstone.generations.size > LOST_GENERATIONS) {
            tombstone.all = true;
            tombstone.generations.clear();
        }
        this.evicted.delete(threadId);
        this.evicted.set(threadId, tombstone);
        while (this.evicted.size > this.maxEvicted)
            this.evicted.delete(this.evicted.keys().next().value);
    }
    gateChecked(scope) {
        bump(this.thread(scope.threadId).checks, scope.generation);
    }
    record(scope, entry) {
        const thread = this.thread(scope.threadId);
        bump(thread.recorded, scope.generation);
        const size = Buffer.byteLength(JSON.stringify(entry));
        if (thread.calls.length >= this.callsPerThread || size > this.entryBytes || this.bytes + size > this.totalBytes) {
            thread.overflow.add(scope.generation);
            return;
        }
        thread.calls.push({ ...entry, generation: scope.generation });
        thread.bytes += size;
        this.bytes += size;
    }
    taint(scope) {
        this.thread(scope.threadId).tainted.add(scope.generation);
    }
    take(threadId, generations) {
        const thread = this.threads.get(threadId) ?? emptyThread();
        const tombstone = this.evicted.get(threadId);
        const lost = tombstone?.all ? new Set(generations) : tombstone?.generations ?? new Set();
        this.drop(thread);
        this.threads.delete(threadId);
        this.evicted.delete(threadId);
        const seen = new Set();
        for (const map of [thread.checks, thread.recorded])
            for (const generation of map.keys())
                if (generations.has(generation))
                    seen.add(generation);
        for (const generation of [...thread.tainted, ...lost])
            if (generations.has(generation))
                seen.add(generation);
        if (seen.size === 0)
            return null;
        let complete = true;
        let tainted = false;
        for (const generation of seen) {
            if ((thread.checks.get(generation) ?? 0) !== (thread.recorded.get(generation) ?? 0) || thread.overflow.has(generation) || lost.has(generation))
                complete = false;
            if (thread.tainted.has(generation) || lost.has(generation))
                tainted = true;
        }
        return { calls: thread.calls.filter((call) => generations.has(call.generation)), complete, tainted };
    }
}
