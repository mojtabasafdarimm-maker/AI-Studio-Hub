// Covers the gap before a member turn marks the bot busy: woken waiters must claim in the same synchronous step, or all read the bot as free.
export class RoomMemberLock {
    holders = new Map();
    listeners = new Set();
    holder(botId) {
        return this.holders.get(botId);
    }
    heldElsewhere(botId, threadId) {
        const holder = this.holders.get(botId);
        return holder !== undefined && holder !== threadId;
    }
    claim(botId, threadId) {
        if (this.heldElsewhere(botId, threadId))
            return false;
        this.holders.set(botId, threadId);
        return true;
    }
    release(botId, threadId) {
        if (this.holders.get(botId) !== threadId)
            return false;
        this.holders.delete(botId);
        this.notify(botId);
        return true;
    }
    releaseThread(threadId) {
        const released = [];
        for (const [botId, holder] of this.holders) {
            if (holder === threadId)
                released.push(botId);
        }
        for (const botId of released)
            this.holders.delete(botId);
        for (const botId of released)
            this.notify(botId);
        return released;
    }
    onRelease(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    notify(botId) {
        // A snapshot: a woken waiter may unsubscribe, or a new one subscribe, during this loop.
        // oxlint-disable-next-line unicorn/no-useless-spread
        for (const listener of [...this.listeners]) {
            try {
                listener(botId);
            }
            catch {
            }
        }
    }
}
