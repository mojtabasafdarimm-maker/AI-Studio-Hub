/** Whole-turn claims on app-managed resources (a desktop, a browser session, a phone), so a screenshot and its click see the same desktop. Not a shell sandbox. */
export class TurnResources {
    owners = new Map();
    /** Only turns actually waiting: a lazy claim that failed once and moved on must not block the front. */
    waiters = new Map();
    waitStats = new Map();
    claimListeners = new Set();
    /** Told each time a claim makes a turn a resource's new holder; returns the way to stop listening. */
    onClaim(listener) {
        this.claimListeners.add(listener);
        return () => { this.claimListeners.delete(listener); };
    }
    startWaiting(resource, owner) {
        const queue = this.waiters.get(resource);
        if (!queue) {
            this.waiters.set(resource, [owner]);
            return 1;
        }
        const index = queue.findIndex(waiting => sameOwner(waiting, owner));
        if (index >= 0)
            return index + 1;
        queue.push(owner);
        return queue.length;
    }
    stopWaiting(resource, owner) {
        const queue = this.waiters.get(resource);
        if (!queue)
            return;
        const next = queue.filter(waiting => !sameOwner(waiting, owner));
        if (next.length)
            this.waiters.set(resource, next);
        else
            this.waiters.delete(resource);
    }
    waitPosition(resource, owner) {
        const queue = this.waiters.get(resource);
        if (!queue)
            return undefined;
        const index = queue.findIndex(waiting => sameOwner(waiting, owner));
        return index < 0 ? undefined : index + 1;
    }
    noteWait(resource, waitedMs) {
        if (!Number.isFinite(waitedMs) || waitedMs < 0)
            return;
        const sample = Math.min(waitedMs, 24 * 60 * 60_000);
        const stats = this.waitStats.get(resource);
        this.waitStats.set(resource, stats
            ? { ewmaMs: stats.ewmaMs + 0.25 * (sample - stats.ewmaMs), samples: stats.samples + 1 }
            : { ewmaMs: sample, samples: 1 });
    }
    waitEstimateMs(resource) {
        return this.waitStats.get(resource)?.ewmaMs;
    }
    blocker(resource, owner) {
        const current = this.owners.get(resource);
        return current && !sameOwner(current, owner) ? current : undefined;
    }
    claim(resource, owner) {
        if (this.blocker(resource, owner))
            return false;
        const existing = this.owners.get(resource);
        if (existing && sameOwner(existing, owner))
            return true;
        // A current holder's revalidation never loses its own claim to this queue.
        const queue = this.waiters.get(resource);
        if (queue?.length && !sameOwner(queue[0], owner))
            return false;
        if (queue?.length) {
            queue.shift();
            if (!queue.length)
                this.waiters.delete(resource);
        }
        this.owners.set(resource, owner);
        for (const listener of this.claimListeners)
            listener(resource, owner);
        return true;
    }
    holder(resource) {
        return this.owners.get(resource);
    }
    owns(resource, owner) {
        const current = this.owners.get(resource);
        return Boolean(current && sameOwner(current, owner));
    }
    release(owner) {
        for (const [key, queue] of this.waiters) {
            const next = queue.filter(waiting => !sameOwner(waiting, owner));
            if (next.length)
                this.waiters.set(key, next);
            else
                this.waiters.delete(key);
        }
        for (const [key, current] of this.owners) {
            if (sameOwner(current, owner))
                this.owners.delete(key);
        }
    }
    releaseOne(resource, owner) {
        if (this.owns(resource, owner))
            this.owners.delete(resource);
        this.stopWaiting(resource, owner);
    }
    free(resource) {
        return !this.owners.has(resource);
    }
}
function sameOwner(a, b) {
    return a.threadId === b.threadId && a.generation === b.generation;
}
