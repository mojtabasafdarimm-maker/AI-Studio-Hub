export const TURN_ENDED_REFUSAL = "This bot turn has already ended (it finished or was stopped), so this call was refused. " +
    "Anything the call started before the turn ended may still have run.";
/** Admission failures that can resume once a slot frees; never matched on error wording. */
export function isTurnAdmissionBlocked(error) {
    return typeof error === "object" && error !== null && "code" in error &&
        (error.code === "thread_busy" || error.code === "thread_limit");
}
/** An adapter may publish its process only after sendTurn resolves, so a Stop during that await can be a no-op: re-check and interrupt again. */
export async function guardTurnDispatch(started, cancelled, stopAfterSetup) {
    const value = await started;
    if (!cancelled())
        return { value, cancelled: false };
    await stopAfterSetup();
    return { value, cancelled: true };
}
/** Turns cancelled during async startup: their late events must not settle a newer turn on the same thread. */
export class RetiredTurnRegistry {
    #turnIds = new Set();
    #limit;
    constructor(limit = 4_096) {
        this.#limit = limit;
    }
    retire(turnId) {
        this.#turnIds.add(turnId);
        while (this.#turnIds.size > this.#limit) {
            const oldest = this.#turnIds.values().next().value;
            if (oldest === undefined)
                break;
            this.#turnIds.delete(oldest);
        }
    }
    has(turnId) {
        return turnId !== undefined && this.#turnIds.has(turnId);
    }
}
/** A late bind for a completed provider id fails closed instead of publishing stale ownership or leaving a bearer alive. */
export class ProviderTurnGenerationRegistry {
    #owners = new Map();
    #completed;
    #earlyCompletions = new Map();
    #limit;
    constructor(limit = 4_096) {
        this.#completed = new RetiredTurnRegistry(limit);
        this.#limit = limit;
    }
    bind(threadId, generation, turnId) {
        if (this.#completed.has(turnId))
            return false;
        this.#owners.set(turnId, { threadId, generation });
        return true;
    }
    complete(threadId, turnId, outcome) {
        if (this.#completed.has(turnId))
            return null;
        const owner = this.#owners.get(turnId);
        if (owner && owner.threadId !== threadId)
            return null;
        this.#completed.retire(turnId);
        if (!owner) {
            // Never attribute an unbound event to the thread's current generation.
            if (outcome !== undefined) {
                this.#earlyCompletions.set(turnId, { threadId, outcome });
                while (this.#earlyCompletions.size > this.#limit) {
                    this.#earlyCompletions.delete(this.#earlyCompletions.keys().next().value);
                }
            }
            return null;
        }
        this.#owners.delete(turnId);
        return owner;
    }
    takeEarlyCompletion(threadId, turnId) {
        const receipt = this.#earlyCompletions.get(turnId);
        if (receipt?.threadId !== threadId)
            return undefined;
        this.#earlyCompletions.delete(turnId);
        return receipt.outcome;
    }
    deleteGeneration(threadId, generation) {
        const removed = [];
        for (const [turnId, owner] of this.#owners) {
            if (owner.threadId === threadId && owner.generation === generation) {
                this.#owners.delete(turnId);
                this.#completed.retire(turnId);
                removed.push(turnId);
            }
        }
        return removed;
    }
    clear() {
        this.#owners.clear();
        this.#earlyCompletions.clear();
    }
}
/** Gates a thread between a winning Stop and the async provider turn id; reference-counted, and each owner expires so a hung adapter cannot hold it. */
export class PendingTurnCancellations {
    #ownersByThread = new Map();
    #clearWaitersByThread = new Map();
    #ttlMs;
    constructor(ttlMs = 30_000) {
        this.#ttlMs = Math.max(1, Math.floor(ttlMs));
    }
    mark(threadId, ownerId) {
        const owners = this.#ownersByThread.get(threadId) ?? new Map();
        const previous = owners.get(ownerId);
        if (previous)
            clearTimeout(previous);
        const expiry = setTimeout(() => {
            // A clear + re-mark may have installed a newer timer: a stale callback must not clear it.
            if (this.#ownersByThread.get(threadId)?.get(ownerId) !== expiry)
                return;
            this.clear(threadId, ownerId);
        }, this.#ttlMs);
        expiry.unref?.();
        owners.set(ownerId, expiry);
        this.#ownersByThread.set(threadId, owners);
    }
    clear(threadId, ownerId) {
        const owners = this.#ownersByThread.get(threadId);
        const expiry = owners?.get(ownerId);
        if (expiry)
            clearTimeout(expiry);
        owners?.delete(ownerId);
        if (owners?.size !== 0)
            return;
        this.#ownersByThread.delete(threadId);
        const waiters = this.#clearWaitersByThread.get(threadId);
        this.#clearWaitersByThread.delete(threadId);
        for (const resolve of waiters ?? [])
            resolve();
    }
    /** Re-check after every wake: a cancellation can be renewed in the same microtask turn that clears an older owner. */
    async waitForClear(threadId) {
        while (this.has(threadId)) {
            await new Promise((resolve) => {
                const waiters = this.#clearWaitersByThread.get(threadId) ?? new Set();
                waiters.add(resolve);
                this.#clearWaitersByThread.set(threadId, waiters);
                if (!this.has(threadId)) {
                    waiters.delete(resolve);
                    if (waiters.size === 0)
                        this.#clearWaitersByThread.delete(threadId);
                    resolve();
                }
            });
        }
    }
    has(threadId) {
        return this.#ownersByThread.has(threadId);
    }
}
export function isTurnEventQuarantined(pending, retired, event) {
    if (retired.has(event.turnId))
        return true;
    if (!pending.has(event.threadId))
        return false;
    if (event.turnId)
        retired.retire(event.turnId);
    return true;
}
