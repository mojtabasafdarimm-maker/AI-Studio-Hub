const MAX_SETTLED = 200;
export function createRunGate(prepare, settled) {
    const pending = new Map();
    /** null: ready to start. A string: why it cannot. Read once. */
    const results = new Map();
    return {
        /** false: start it. true: still being made ready. A string: it cannot start, and why. */
        hold(run) {
            if (results.has(run.id)) {
                const reason = results.get(run.id);
                results.delete(run.id);
                return reason ?? false;
            }
            if (pending.has(run.id))
                return true;
            const stop = new AbortController();
            const work = prepare?.(run, stop.signal);
            if (!work)
                return false;
            pending.set(run.id, stop);
            void work.catch(() => null).then((reason) => {
                if (pending.get(run.id) !== stop)
                    return;
                pending.delete(run.id);
                if (stop.signal.aborted)
                    return;
                if (results.size >= MAX_SETTLED)
                    results.delete(results.keys().next().value);
                results.set(run.id, reason);
                settled();
            });
            return true;
        },
        /** Stops the work for every held run that `waiting` no longer vouches for, and forgets its result. */
        sweep(waiting) {
            for (const [runId, stop] of pending) {
                if (waiting(runId))
                    continue;
                stop.abort();
                pending.delete(runId);
            }
            for (const runId of results.keys())
                if (!waiting(runId))
                    results.delete(runId);
        },
        waiting: (runId) => pending.has(runId),
    };
}
