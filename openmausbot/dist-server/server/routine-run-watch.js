// A started run whose turn is gone is not left `running` for ever. The host says whether a run's conversation still has
// a turn of its own; once it has said no for TURN_GONE_MS of scheduler passes in a row, with no event from that
// conversation in between, the run is handed back to be started again or failed. The passes are added up one at a
// time, each step capped, so the hours a computer slept count for nothing.
import { COUNT_STEP_CAP_MS, COUNT_STEP_MS } from "./routine-bounds.js";
export const TURN_GONE_MS = 5 * 60_000;
export class RunWatch {
    live;
    events = new Map();
    gone = new Map();
    /** `live`: whether the run's conversation has a turn working or about to; null when the host cannot tell. */
    constructor(live) {
        this.live = live;
    }
    /** An event arrived from this conversation. */
    seen(threadId) {
        if (this.live)
            this.events.set(threadId, (this.events.get(threadId) ?? 0) + 1);
    }
    /** The runs whose turn has now been gone for TURN_GONE_MS. */
    lost(runs, now) {
        const lost = [], watched = new Set();
        if (!this.live)
            return lost;
        for (const run of runs) {
            if (!started(run))
                continue;
            const events = this.events.get(run.threadId) ?? 0, before = this.gone.get(run.id);
            if (this.live(run) !== false)
                continue;
            watched.add(run.id);
            const ms = before && before.events === events ? before.ms + Math.min(COUNT_STEP_CAP_MS, Math.max(0, now - before.lookedAt)) : 0;
            this.gone.set(run.id, { ms, lookedAt: now, events });
            if (ms >= TURN_GONE_MS)
                lost.push(run);
        }
        for (const id of this.gone.keys())
            if (!watched.has(id))
                this.gone.delete(id);
        for (const threadId of this.events.keys())
            if (!runs.some((run) => run.threadId === threadId && started(run)))
                this.events.delete(threadId);
        return lost;
    }
    /** When the scheduler must next look: a step on while a run is at work, so a turn that goes is noticed. */
    dueAt(runs, now) {
        return this.live && runs.some(started) ? now + COUNT_STEP_MS : null;
    }
}
const started = (run) => run.status === "running" && run.startedAt != null && run.threadId !== undefined;
