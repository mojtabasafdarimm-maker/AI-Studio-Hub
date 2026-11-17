export function createJobSlots(limit) {
    let running = 0;
    const waiting = [];
    // A finished job hands its slot to the first waiter, so a caller arriving in between cannot take it.
    const release = () => {
        const next = waiting.shift();
        if (next)
            next.start();
        else
            running -= 1;
    };
    const slot = ({ signal, urgent, interactive = false, onWait }) => {
        signal?.throwIfAborted();
        if (running < limit || urgent?.()) {
            running += 1;
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            let poll;
            const unwait = () => {
                clearInterval(poll);
                signal?.removeEventListener("abort", leave);
                const at = waiting.indexOf(entry);
                if (at >= 0)
                    waiting.splice(at, 1);
            };
            // Handed a slot by a finished job: `running` already counts it.
            const entry = { interactive, start: () => { unwait(); resolve(); } };
            const leave = () => {
                unwait();
                reject(signal.reason instanceof Error ? signal.reason : new Error("stopped while waiting for a free slot"));
            };
            const behind = interactive ? waiting.findIndex((other) => !other.interactive) : -1;
            waiting.splice(behind < 0 ? waiting.length : behind, 0, entry);
            signal?.addEventListener("abort", leave, { once: true });
            if (urgent) {
                poll = setInterval(() => {
                    if (!urgent())
                        return;
                    unwait();
                    running += 1;
                    resolve();
                }, 250);
                poll.unref?.();
            }
            onWait?.();
        });
    };
    return {
        async run(job, options = {}) {
            await slot(options);
            try {
                return await job();
            }
            finally {
                release();
            }
        },
        limit,
        get running() { return running; },
        get waiting() { return waiting.length; },
    };
}
/** A whole number from 1 to 64 in `raw`, else `fallback`. */
export function slotLimit(raw, fallback) {
    const parsed = Number(raw);
    return raw !== undefined && raw.trim() !== "" && Number.isInteger(parsed) && parsed >= 1 && parsed <= 64 ? parsed : fallback;
}
/** One-off text calls nobody is waiting on (first-message suggestions, memory upkeep, skill review, thread titles): each
 * is an engine CLI process. OMB_BACKGROUND_TEXT_MAX sets how many run at once across all bots. */
export const backgroundTextSlots = createJobSlots(slotLimit(process.env.OMB_BACKGROUND_TEXT_MAX, 3));
/** git processes the checkpoints of all bots run at once; OMB_CHECKPOINT_GIT_MAX sets it. */
export const checkpointGitSlots = createJobSlots(slotLimit(process.env.OMB_CHECKPOINT_GIT_MAX, 4));
