/** Signals for a bot's tool calls that outlive a check: each aborts once its request is gone, or once `sweep` finds the
 * turn's grant no longer active. Security: a revoked grant must reach a call already in flight, not only the next one. */
export function createTurnCallSignals(isActive) {
    const calls = new Map();
    return {
        signal(grant, res) {
            const call = new AbortController();
            calls.set(call, grant);
            const onClose = () => {
                calls.delete(call);
                if (!res.writableEnded)
                    call.abort();
            };
            if (res.closed)
                onClose();
            else
                res.once("close", onClose);
            return call.signal;
        },
        /** Called after grants are revoked. */
        sweep() {
            for (const [call, grant] of calls) {
                if (isActive(grant))
                    continue;
                calls.delete(call);
                call.abort();
            }
        },
    };
}
