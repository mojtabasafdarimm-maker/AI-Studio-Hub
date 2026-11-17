// Who is here on a Team Cloud, in memory only (docs/team-cloud.md "Who is here"). A person is here while one of their
// sessions has the event stream open or a window of theirs said so lately, and for GRACE_MS after, so a reconnect or a
// phone in the background for a moment changes nothing. Each window says which conversation it shows; only a
// conversation `reads` allows (shared, and theirs to read) is ever kept, so a private chat is never recorded anywhere.
// Security: `reads` is the privacy gate. Every list is checked against it again when it is sent.
export const GRACE_MS = 45_000;
/** At most one arrival or departure frame per person this often; what changed in between is sent once, at the end. */
export const PERSON_GAP_MS = 5_000;
/** A window not heard from this long no longer shows its conversation. */
export const WINDOW_TTL_MS = 150_000;
/** A conversation's list of who has it open is sent at most this often. */
export const THREAD_GAP_MS = 750;
export const realClock = {
    now: Date.now,
    later(run, ms) {
        const timer = setTimeout(run, ms);
        timer.unref?.();
        return { cancel: () => clearTimeout(timer) };
    },
};
export function createTeamPresence(deps) {
    const clock = deps.clock ?? realClock;
    const graceMs = deps.graceMs ?? GRACE_MS;
    const people = new Map();
    const windows = new Map();
    const dirty = new Set();
    let threadTimer;
    let sweepTimer;
    const person = (email) => {
        let known = people.get(email);
        if (!known) {
            known = { streams: 0, lastActive: 0, here: false, announced: false, lastFrameAt: -Infinity };
            people.set(email, known);
        }
        return known;
    };
    function announce(email) {
        const one = people.get(email);
        if (!one || one.announced === one.here || one.frameTimer)
            return;
        const wait = one.lastFrameAt + PERSON_GAP_MS - clock.now();
        if (wait > 0) {
            one.frameTimer = clock.later(() => { one.frameTimer = undefined; announce(email); }, wait);
            return;
        }
        one.announced = one.here;
        one.lastFrameAt = clock.now();
        deps.emit({ type: "person", email, here: one.here });
    }
    function arrive(email) {
        const one = person(email);
        one.lastActive = clock.now();
        one.awayTimer?.cancel();
        one.awayTimer = undefined;
        if (!one.here) {
            one.here = true;
            announce(email);
        }
        return one;
    }
    function scheduleAway(email, one) {
        if (one.streams > 0)
            return;
        one.awayTimer?.cancel();
        one.awayTimer = clock.later(() => {
            one.awayTimer = undefined;
            if (one.streams > 0 || !one.here)
                return;
            const left = clock.now() - one.lastActive;
            if (left < graceMs)
                return scheduleAway(email, one);
            one.here = false;
            for (const [key, window] of windows)
                if (window.email === email)
                    dropWindow(key);
            announce(email);
        }, Math.max(0, one.lastActive + graceMs - clock.now()));
    }
    function touched(threadId) {
        if (threadId === null)
            return;
        dirty.add(threadId);
        threadTimer ??= clock.later(flushThreads, THREAD_GAP_MS);
    }
    function dropWindow(key) {
        const window = windows.get(key);
        if (!window)
            return;
        windows.delete(key);
        touched(window.threadId);
    }
    /** Who has this conversation open now, each checked against `reads` again. */
    function viewers(threadId) {
        const emails = new Set();
        for (const window of windows.values()) {
            if (window.threadId === threadId && people.get(window.email)?.here)
                emails.add(window.email);
        }
        return [...emails].filter((email) => deps.reads(email, threadId)).sort();
    }
    function flushThreads() {
        threadTimer = undefined;
        const threads = [...dirty];
        dirty.clear();
        for (const threadId of threads) {
            const open = viewers(threadId);
            if (open.length > 0)
                deps.emit({ type: "thread", threadId, people: open });
        }
    }
    function sweep() {
        sweepTimer = undefined;
        const stale = clock.now() - WINDOW_TTL_MS;
        for (const [key, window] of windows)
            if (window.at < stale)
                dropWindow(key);
        if (windows.size > 0)
            sweepTimer = clock.later(sweep, WINDOW_TTL_MS / 3);
    }
    return {
        /** One of this person's sessions opened the event stream. */
        streamOpened(email) {
            arrive(email).streams += 1;
        },
        streamClosed(email) {
            const one = people.get(email);
            if (!one || one.streams === 0)
                return;
            one.streams -= 1;
            one.lastActive = clock.now();
            scheduleAway(email, one);
        },
        /** A window of this person's is open, showing `threadId`: kept only when `reads` allows it, else as showing none. */
        window(email, key, threadId) {
            const one = arrive(email);
            scheduleAway(email, one);
            const shown = threadId !== null && deps.reads(email, threadId) ? threadId : null;
            const before = windows.get(key);
            if (before && before.email !== email)
                return;
            windows.set(key, { email, threadId: shown, at: clock.now() });
            sweepTimer ??= clock.later(sweep, WINDOW_TTL_MS / 3);
            if (before?.threadId !== shown) {
                touched(before?.threadId ?? null);
                touched(shown);
            }
        },
        here(email) {
            return people.get(email)?.here === true;
        },
        viewers,
        /** The person left the team: nothing of theirs stays, and nobody hears of it here (the people list does). */
        forget(email) {
            const one = people.get(email);
            one?.awayTimer?.cancel();
            one?.frameTimer?.cancel();
            people.delete(email);
            for (const [key, window] of windows)
                if (window.email === email)
                    dropWindow(key);
        },
        close() {
            threadTimer?.cancel();
            sweepTimer?.cancel();
            for (const one of people.values()) {
                one.awayTimer?.cancel();
                one.frameTimer?.cancel();
            }
        },
    };
}
