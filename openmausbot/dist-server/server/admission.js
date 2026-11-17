// Purity is the contract: no IO, no store reads, no adapter calls. Callers gather state, call admit(), and apply the decision.
export const DRAIN_COALESCE_WINDOW_MS = 120_000;
/** Room turns read only the room-context window's last N messages, so a bigger group would append lines the responder never sees. */
export const DRAIN_COALESCE_MAX_ITEMS = 30;
/** The first item always drains, so an empty identity never strands a queue. */
export function drainCoalesceHead(items, identityOf, queuedAtOf, maxItems) {
    const head = [];
    let previousIdentity;
    let previousAt;
    for (const item of items) {
        if (maxItems !== undefined && head.length >= maxItems)
            break;
        const identity = identityOf(item);
        const at = queuedAtOf(item);
        const gap = at - (previousAt ?? at);
        if (head.length === 0 || (identity === previousIdentity && gap >= 0 && gap <= DRAIN_COALESCE_WINDOW_MS)) {
            head.push(item);
        }
        else {
            break;
        }
        previousIdentity = identity;
        previousAt = at;
    }
    return head;
}
function imagesBlockSteer(message) {
    return message.carriesImages === true && message.engineCanSteerImages !== true;
}
/** Whether a live room turn holds this work back. A person's own send (sent now, or queued earlier) waits only for a
 * room turn on its own thread; every other kind of work waits for any room turn of the bot. */
export function roomTurnHolds(roomTurn, threadId, personSend) {
    return Boolean(roomTurn) && (!personSend || roomTurn.threadId === threadId);
}
export function admit(surface, message = {}, state = {}) {
    switch (surface) {
        case "direct-busy": {
            // Restart waits for the Stop it asks for. A chosen queue counts only where the turn could take steering: one that
            // cannot queues anyway, as it always has (person-first may still stop it for the person's message).
            if (message.followUp === "restart")
                return { action: "queue", chose: "restart" };
            if (message.engineCanSteer === true && message.followUp === "queue")
                return { action: "queue", chose: "queue" };
            if (message.engineCanSteer !== true || message.pendingComputerSelection)
                return { action: "queue" };
            if (imagesBlockSteer(message))
                return { action: "queue", blockedBy: "images" };
            return { action: "steer" };
        }
        case "direct": {
            // groupTurn here is roomTurnHolds(): a room turn on another thread does not hold a person's own thread.
            if (state.atCapacity || state.threadBusy || state.groupTurn || state.parksBehindCoordination) {
                // Capacity outranks a room turn in the receipt because the person can fix it.
                const reason = state.atCapacity ? "capacity" : state.groupTurn ? "group-turn" : undefined;
                return { action: "queue", reason };
            }
            return { action: "start" };
        }
        case "room":
            return (state.threadWorking ?? state.roomWorking) ? { action: "queue" } : { action: "start" };
        case "room-steer": {
            if (!message.speakerPresent || message.engineCanSteer !== true) {
                return { action: "queue" };
            }
            if (imagesBlockSteer(message))
                return { action: "queue", blockedBy: "images" };
            if (!message.isQueueHead) {
                return { action: "refuse", code: "queue-head-only" };
            }
            return { action: "steer" };
        }
        case "guarded": {
            // A guarded send is an external contract: never queued, never steered, never started under stale permissions.
            if (state.botBusy || state.threadBusy || state.atCapacity || state.parksBehindCoordination || state.groupTurn) {
                return { action: "refuse", code: "guarded_busy" };
            }
            return { action: "start" };
        }
        case "unattended": {
            if (state.botPresent === false)
                return { action: "refuse", code: "missing" };
            if (state.atCapacity || state.groupTurn)
                return { action: "refuse", code: "busy" };
            return { action: "start" };
        }
        case "peer": {
            if (state.threadBusy || state.atCapacity || state.groupTurn)
                return { action: "refuse", code: "busy" };
            return { action: "start" };
        }
        case "opened-thread": {
            if (state.atCapacity || state.groupTurn) {
                return { action: "queue", reason: state.atCapacity ? "capacity" : "group-turn" };
            }
            return { action: "start" };
        }
        case "incident": {
            // Never refused (a refused report is a lost one), never parked behind handed-on work, never steered.
            if (state.atCapacity || state.threadBusy || state.groupTurn) {
                return { action: "queue", reason: state.atCapacity ? "capacity" : state.groupTurn ? "group-turn" : undefined };
            }
            return { action: "start" };
        }
    }
}
