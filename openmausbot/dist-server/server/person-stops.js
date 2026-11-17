// Turns the person ended with Stop. Their chat shows one quiet "You stopped this." row and never an error for a
// turn they stopped; a Stop that names a turn already over (the second click of a double click) reaches nothing,
// so it can never land on the queued message that started next.
import { isStoppedTurnName, PERSON_STOPPED_TURN_NAME, STOPPED_TURN_NAME } from "../shared/client-cancel.js";
export class PersonStops {
    #byThread = new Map();
    #by = new Map();
    /** The person pressed Stop on the thread's live turn; `turnId` is undefined while that turn is still being
     * dispatched. A Stop that found nothing running or dispatching is no stop of anything. */
    stop(threadId, turnId, dispatching, by) {
        if (turnId === undefined && !dispatching)
            return;
        this.#byThread.set(threadId, turnId);
        if (by)
            this.#by.set(threadId, by);
        else
            this.#by.delete(threadId);
    }
    /** Who pressed that Stop, where several people use the server. */
    stopper(threadId) {
        return this.#byThread.has(threadId) ? this.#by.get(threadId) : undefined;
    }
    stopped(threadId, turnId) {
        if (!this.#byThread.has(threadId))
            return false;
        const stopped = this.#byThread.get(threadId);
        return stopped === undefined || turnId === undefined || stopped === turnId;
    }
    /** A turn started: a mark for any other turn on the thread is over (even if that turn's end was lost), and a mark
     * made during a dispatch is dropped at this start too, since it named no turn. */
    turnStarted(threadId, turnId) {
        if (this.#byThread.has(threadId) && this.#byThread.get(threadId) !== turnId)
            this.#forget(threadId);
    }
    /** A turn ended: its own stop goes, and so does one pressed during a dispatch; another turn's end leaves it be. */
    turnEnded(threadId, turnId) {
        if (!this.#byThread.has(threadId))
            return;
        const stopped = this.#byThread.get(threadId);
        if (stopped === undefined || stopped === turnId)
            this.#forget(threadId);
    }
    #forget(threadId) {
        this.#byThread.delete(threadId);
        this.#by.delete(threadId);
    }
}
/** A Stop that names a turn reaches it only while it is still the thread's live turn; one that names none reaches
 * whatever runs, as older clients expect. */
export function stopReachesLiveTurn(named, live) {
    return named === undefined || named === live;
}
/** The stopped row a turn ends with, or null when the turn already has one. */
export function stoppedTurnRow(messages, turnId, byPerson, by) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message.role === "user")
            break;
        if (message.kind === "activity" && isStoppedTurnName(message.tool?.name ?? "") && message.turnId === turnId)
            return null;
    }
    return { role: "bot", kind: "activity", tool: { name: byPerson ? PERSON_STOPPED_TURN_NAME : STOPPED_TURN_NAME, ok: true }, turnId, ...(byPerson && by ? { stoppedBy: by } : {}) };
}
