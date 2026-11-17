export class LiveTurns {
    #byThread = new Map();
    #busy;
    /** `busy`: whether the thread is still working, as the harness's own records say. */
    constructor(busy) {
        this.#busy = busy;
    }
    onEvent(event) {
        if (!event.turnId)
            return;
        if (event.type === "turn.started")
            this.#byThread.set(event.threadId, event.turnId);
        else if (event.type === "turn.completed" && this.#byThread.get(event.threadId) === event.turnId)
            this.#byThread.delete(event.threadId);
    }
    /** A new turn is being dispatched on the thread: whatever turn it held before is over, its end lost or not. */
    dispatchStarted(threadId) {
        this.#byThread.delete(threadId);
    }
    running(threadId) {
        const turnId = this.#byThread.get(threadId);
        return turnId !== undefined && this.#busy(threadId) ? turnId : undefined;
    }
}
