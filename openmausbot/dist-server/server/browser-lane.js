// One bot call per browser at a time, from its first page read to its last, so another call's console clear never lands
// between an action and its read, and fill_login's typing never shares the browser with a capture.
export class BrowserLanes {
    lanes = new Map();
    held(session) { return this.lanes.has(session); }
    /** Waits at most `waitMs` for earlier calls; null, without running `fn`, when the wait ran out. */
    async run(session, fn, waitMs) {
        const previous = this.lanes.get(session);
        let release;
        const mine = new Promise((resolve) => { release = resolve; });
        const tail = previous ? previous.then(() => mine) : mine;
        this.lanes.set(session, tail);
        const leave = () => { if (this.lanes.get(session) === tail)
            this.lanes.delete(session); };
        if (previous) {
            let timer;
            const ready = await Promise.race([previous.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), waitMs); timer.unref(); })]);
            clearTimeout(timer);
            // Gave up: later calls still wait for the earlier one, not for this.
            if (!ready) {
                release();
                void tail.then(leave);
                return null;
            }
        }
        try {
            return await fn();
        }
        finally {
            release();
            leave();
        }
    }
}
