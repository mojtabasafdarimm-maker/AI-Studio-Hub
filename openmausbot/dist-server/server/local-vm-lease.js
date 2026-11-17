/** Synchronous, so lifecycle routes and turn dispatch claim their side of the race before either awaits. */
export class LocalVmLease {
    record = null;
    ttlMs;
    constructor(ttlMs) {
        if (!Number.isFinite(ttlMs) || ttlMs <= 0)
            throw new Error("Local VM lease TTL must be positive");
        this.ttlMs = ttlMs;
    }
    current(isBotBusy, now = Date.now()) {
        if (this.record && (this.record.expiresAt <= now || !isBotBusy(this.record.botId)))
            this.record = null;
        return this.record ? { ...this.record } : null;
    }
    claim(threadId, botId, isBotBusy, now = Date.now()) {
        const current = this.current(isBotBusy, now);
        if (current && current.threadId !== threadId)
            return false;
        this.record = { threadId, botId, expiresAt: now + this.ttlMs };
        return true;
    }
    touch(threadId, now = Date.now()) {
        if (this.record && this.record.expiresAt <= now) {
            this.record = null;
            return;
        }
        if (this.record?.threadId === threadId)
            this.record.expiresAt = now + this.ttlMs;
    }
    release(threadId) {
        if (this.record?.threadId === threadId)
            this.record = null;
    }
}
export class LocalVmLeasePool {
    leases = new Map();
    ttlMs;
    constructor(ttlMs) {
        if (!Number.isFinite(ttlMs) || ttlMs <= 0)
            throw new Error("Local VM lease TTL must be positive");
        this.ttlMs = ttlMs;
    }
    forTarget(targetKey) {
        let lease = this.leases.get(targetKey);
        if (!lease) {
            lease = new LocalVmLease(this.ttlMs);
            this.leases.set(targetKey, lease);
        }
        return lease;
    }
    forget(targetKey) {
        this.leases.delete(targetKey);
    }
}
