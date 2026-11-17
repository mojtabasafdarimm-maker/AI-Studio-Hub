// Nothing a bot does on its own holds a routine's schedule up without end: a started run stops after a limit of work, a
// scheduled run queued behind its busy bot is given up after an hour, and stopping a turn never keeps the scheduler
// from its other routines. Each ends with its reason on the run's row. The work and the busy wait are added up one
// scheduler pass at a time, each step capped, so the hours a computer slept, or a clock that jumped, are in neither.
import { ROUTINE_GOAL_RUN_LIMIT_MINUTES, ROUTINE_RUN_LIMIT_MINUTES } from "../shared/routines.js";
import { DUE_CLOCK_MS } from "./due-timer.js";
import { codedLine, fittedLine } from "./routine-lines.js";
import { ROUTINE_BUSY_WAIT_MS } from "./routine-recovery.js";
import { activeMs } from "./routine-waits.js";
/** How often the scheduler passes while a run works, to count that work. */
export const COUNT_STEP_MS = DUE_CLOCK_MS;
/** The most one pass adds to a count: a longer gap is the computer asleep or the clock moved, not work. */
export const COUNT_STEP_CAP_MS = 2 * COUNT_STEP_MS;
/** How long the scheduler waits for a turn to stop before it goes on to its other work. */
export const SCHEDULER_STOP_WAIT_MS = 10_000;
/** After a stop that did not finish in that time, its routine starts no new run until the stop is confirmed, or this long has passed. */
export const STOP_CONFIRM_WAIT_MS = 5 * 60_000;
/** While it waits, the stop is sent again this often. */
export const STOP_RETRY_MS = 60_000;
/** Adds up a run's `workedMs` (time in status running since its current start) and `busyMs` (time a scheduled run has
 * been seen queued behind its busy bot), pass by pass. When each was last counted is kept in memory only, so the time a
 * process was down is in neither. */
export class RunClock {
    counted = new WeakMap();
    /** Adds the time since `field` was last counted, at most COUNT_STEP_CAP_MS; the first sight of a run adds nothing. The total. */
    count(run, field, now) {
        const at = this.counted.get(run) ?? {}, since = at[field];
        this.counted.set(run, { ...at, [field]: now });
        run[field] = (run[field] ?? 0) + (since === undefined ? 0 : Math.min(COUNT_STEP_CAP_MS, Math.max(0, now - since)));
        return run[field];
    }
    /** Counting starts from `now`: nothing before it is added. */
    from(run, field, now) { this.counted.set(run, { ...this.counted.get(run), [field]: now }); }
    /** Counting stops. `forget` drops the total too. */
    stop(run, field, forget = false) {
        const { [field]: _stopped, ...rest } = this.counted.get(run) ?? {};
        this.counted.set(run, rest);
        if (forget)
            delete run[field];
    }
    /** The run goes to work, at its start or after a wait. */
    work(run, now) {
        this.from(run, "workedMs", now);
        Object.assign(run, { status: "running", attention: undefined });
    }
    /** The run begins to wait: its work so far is counted, and the wait is not. */
    rest(run, now) {
        if (run.status === "running")
            this.count(run, "workedMs", now);
        this.stop(run, "workedMs");
    }
}
const defaultLimitMs = (run) => (run.target === "room-goal" ? ROUTINE_GOAL_RUN_LIMIT_MINUTES : ROUTINE_RUN_LIMIT_MINUTES) * 60_000;
const started = (run) => run.startedAt != null && (run.status === "running" || run.status === "waiting");
/** When the scheduler must next look at a started run: when a routine's own limit is reached, or, under the default
 * limit, at the next step of counting its work. Null while neither applies (it is not started, it waits under the
 * default limit, or a request of its own is open, which no limit counts). */
export function runLimitAt(run, now) {
    if (!started(run))
        return null;
    if (run.timeoutMinutes != null)
        return run.asked ? null : now + Math.max(0, run.timeoutMinutes * 60_000 - activeMs(run, now));
    return run.status === "running" ? now + Math.min(COUNT_STEP_MS, Math.max(0, defaultLimitMs(run) - (run.workedMs ?? 0))) : null;
}
/** Counts this pass's work for a running run, and says why a started run must stop now; null while it is within its
 * limit. A routine's own limit counts as it always has (`activeMs`: the time since the run started, less its open
 * approvals and questions). The default one counts work only, so it never ends a run that waits. */
export function runOverLimit(run, clock, now) {
    if (!started(run))
        return null;
    const worked = run.status === "running" ? clock.count(run, "workedMs", now) : run.workedMs ?? 0;
    if (run.timeoutMinutes != null)
        return activeMs(run, now) >= run.timeoutMinutes * 60_000 ? fittedLine("error", `Stopped after reaching the ${run.timeoutMinutes}-minute run limit`, undefined) : null;
    return run.status === "running" && worked >= defaultLimitMs(run) ? codedLine("error", "routines.server.overLimit", { hours: defaultLimitMs(run) / 3_600_000 }) : null;
}
/** A queued run that cannot start because its bot is busy. While `counts` (a scheduled occurrence, not one of checked
 * items, not behind its own routine's earlier run), the passes that see it so add up in `busyMs`, and the line is why it
 * is given up once that reaches ROUTINE_BUSY_WAIT_MS: its routine's next occurrence does the work. Any other run waits
 * as long as it takes (nothing comes after an event's or a person's run), and `busyMs` is dropped. `changed`: worth saving. */
export function busyWait(run, clock, counts, now) {
    const before = run.busyMs;
    if (!counts) {
        clock.stop(run, "busyMs", true);
        return { changed: before !== undefined, missed: null };
    }
    const total = clock.count(run, "busyMs", now);
    const changed = before === undefined || Math.floor(before / 60_000) !== Math.floor(total / 60_000);
    return { changed, missed: total >= ROUTINE_BUSY_WAIT_MS ? codedLine("error", "routines.server.busyTooLong", { minutes: ROUTINE_BUSY_WAIT_MS / 60_000 }) : null };
}
/** Stops of a turn that did not finish in SCHEDULER_STOP_WAIT_MS, by conversation: the old turn may still be running, so
 * its routine starts nothing new until the stop is confirmed (the stop returns, or the turn's end arrives) or
 * STOP_CONFIRM_WAIT_MS passes. `changed` hears each state, to mark the run's row. */
export class SlowStops {
    /** How often a stop did not finish in time, since this process started. */
    count = 0;
    open = new Map();
    now;
    changed;
    constructor(now, changed) {
        this.now = now;
        this.changed = changed;
    }
    timedOut(threadId) {
        this.count += 1;
        console.warn(`routines: stopping a turn did not finish in ${SCHEDULER_STOP_WAIT_MS / 1000} s; the scheduler went on without it`);
        if (this.open.has(threadId))
            return;
        this.open.set(threadId, { since: this.now(), triedAt: this.now() });
        this.changed(threadId, "pending");
    }
    confirmed(threadId) {
        if (this.open.delete(threadId))
            this.changed(threadId, "confirmed");
    }
    holds(threadId) {
        return threadId !== undefined && this.open.has(threadId);
    }
    /** Gives up on stops outstanding for STOP_CONFIRM_WAIT_MS; the conversations whose stop is due to be sent again. */
    sweep() {
        const now = this.now(), again = [];
        for (const [threadId, stop] of this.open) {
            if (now - stop.since >= STOP_CONFIRM_WAIT_MS) {
                this.open.delete(threadId);
                this.changed(threadId, "unconfirmed");
            }
            else if (now - stop.triedAt >= STOP_RETRY_MS) {
                stop.triedAt = now;
                again.push(threadId);
            }
        }
        return again;
    }
}
/** Marks a finished run's row while its stop is outstanding, and says so for good when it was never confirmed; a stop
 * confirmed in time leaves no mark. False when the row is as it was. */
export function markStop(run, state) {
    if (["queued", "running", "waiting"].includes(run.status))
        return false;
    if (state === "confirmed") {
        if (run.attentionCode !== "routines.server.stopPending")
            return false;
        Object.assign(run, { attention: undefined, attentionCode: undefined, attentionParams: undefined });
        return true;
    }
    const line = state === "pending" ? codedLine("attention", "routines.server.stopPending", { minutes: STOP_CONFIRM_WAIT_MS / 60_000 }) : codedLine("attention", "routines.server.stopUnconfirmed");
    Object.assign(run, line.codes, { attention: line.text });
    return true;
}
async function within(work, slow, threadId) {
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve("late"), SCHEDULER_STOP_WAIT_MS); timer.unref?.(); });
    try {
        if (await Promise.race([work, late]) !== "late")
            return slow.confirmed(threadId);
        slow.timedOut(threadId);
        work.then(() => slow.confirmed(threadId), () => { });
    }
    finally {
        clearTimeout(timer);
    }
}
/** A live view of the same options in which each stop of a turn or goal is given SCHEDULER_STOP_WAIT_MS: an engine that
 * never answers its interrupt is noted in `slow` and left behind, while the stop itself keeps going. */
export function withBoundedStops(options, slow) {
    return Object.create(options, {
        interruptTurn: { get: () => options.interruptTurn && (async (botId, threadId) => within(options.interruptTurn(botId, threadId), slow, threadId)) },
        interruptGoal: { get: () => options.interruptGoal && (async (groupId, threadId, outcome) => within(options.interruptGoal(groupId, threadId, outcome), slow, threadId)) },
    });
}
