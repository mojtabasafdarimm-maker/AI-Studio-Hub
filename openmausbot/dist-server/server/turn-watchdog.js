import { processAlive } from "./browser-processes.js";
import { sampleProcessTree } from "./drivers/acp/quiet-status.js";
import { redactSecretsInText } from "../shared/redact.js";
/** The longest-running shell command of a turn, or undefined when no running tool runs one. */
function oldestCommand(turn) {
    let oldest;
    for (const tool of turn.runningTools?.values() ?? []) {
        if (tool.command && (!oldest || tool.startedAt < oldest.startedAt))
            oldest = tool;
    }
    return oldest;
}
/** The longest-running shell command of a turn stopped at stopAt, with the whole minutes it ran: what the person is told
 * looks stuck, with any secret in it scrubbed. null when no running tool runs a shell command. */
export function stuckCommand(turn, stopAt) {
    const oldest = oldestCommand(turn);
    return oldest ? { command: redactSecretsInText(oldest.command), minutes: Math.max(1, Math.round((stopAt - oldest.startedAt) / 60_000)) } : null;
}
/** The silence that stops a turn whose engine process has exited: its engine can never answer it, so it waits only long
 * enough for the driver to report the turn's own end, and not for the tool limit. */
export const ENGINE_EXIT_STALL_MS = 2 * 60_000;
/** What the person is told when the watchdog stops a turn silent for silentMs: the shell command still running, with how
 * long it ran, so they know what looked stuck; otherwise how long the turn was silent. A turn whose engine process
 * exited is told that instead: no silence of its own stopped it. */
export function stallNotice(turn, silentMs, stopAt, reason = "silent") {
    if (reason === "engine-exited")
        return { key: "chat.notice.engineExited", params: {} };
    const stuck = stuckCommand(turn, stopAt);
    return stuck ? { key: "chat.notice.stalledCommand", params: stuck } : { key: "chat.notice.stalled", params: { minutes: Math.round(silentMs / 60_000) } };
}
// Number() also reads "Infinity" and "1e309" as numbers, and an endless limit would switch the watchdog off.
export function stallLimitMs(raw, fallback) {
    const ms = Number(raw);
    return Number.isFinite(ms) && ms > 0 ? ms : fallback;
}
/** The engine is known to run no process for the thread's turn: its driver tracks one and has none, or the one it names has
 * exited. A driver that tracks no process proves nothing, so this is false for it. */
export function engineProcessGone(adapter, threadId, alive = processAlive) {
    if (!adapter?.enginePid)
        return false;
    const pid = adapter.enginePid(threadId);
    return pid === undefined || !alive(pid);
}
/** The engine's process for the thread's turn has exited: the driver names one and that process is gone. A driver that
 * names no process for the turn proves nothing (the turn may not have started one yet), so this is false for it. */
export function engineProcessExited(adapter, threadId, alive = processAlive) {
    if (!adapter?.enginePid)
        return false;
    const pid = adapter.enginePid(threadId);
    return pid !== undefined && !alive(pid);
}
/** The CPU time used by the processes the thread's engine started since `since` (what a tool call started then runs, not
 * the engine or its tool servers); null when the driver tracks no engine process or the time cannot be read. */
export async function engineCommandCpuMs(adapter, threadId, since, sample = sampleProcessTree) {
    const pid = adapter?.enginePid?.(threadId);
    return pid === undefined ? null : (await sample(pid, since)).cpuMs;
}
const SUSPENDED_SWEEPS = 3;
const parked = (turn) => turn.waitingOnHuman || turn.waitingOnComputer;
export class TurnWatchdog {
    turns = new Map();
    unheldSince = new Map();
    /** Each turn's last read of its shell command's CPU time: the command it was read for (by start) and whether a read is out. */
    cpu = new WeakMap();
    timer = null;
    opts;
    // No parameter properties: Node's type-stripping cannot transform them.
    constructor(opts) {
        this.opts = opts;
    }
    now() {
        return this.opts.now?.() ?? Date.now();
    }
    start() {
        if (this.timer)
            return;
        // Real time, not now(): a sleeping computer suspends the process while the wall clock runs on, so the timer fires
        // that much late, and that time was not the turns' silence.
        let lastTickAt = Date.now();
        this.timer = setInterval(() => {
            const at = Date.now();
            const gap = at - lastTickAt;
            lastTickAt = at;
            this.sweep(gap > SUSPENDED_SWEEPS * this.opts.checkMs ? gap : 0);
        }, this.opts.checkMs);
        this.timer.unref?.();
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
        this.turns.clear();
        this.unheldSince.clear();
    }
    watch(threadId, botId) {
        const at = this.now();
        this.turns.set(threadId, { threadId, botId, startedAt: at, lastEventAt: at, waitingOnHuman: false, waitingOnComputer: false,
            runningTools: new Map() });
    }
    observe(event) {
        const turn = this.turns.get(event.threadId);
        if (!turn)
            return;
        turn.lastEventAt = this.now();
        if ((event.type !== "item.started" && event.type !== "item.completed") || event.itemType !== "tool" || !event.itemId)
            return;
        if (event.type === "item.completed")
            turn.runningTools.delete(event.itemId);
        else
            turn.runningTools.set(event.itemId, { startedAt: turn.lastEventAt, ...(event.summary ? { command: event.summary } : {}) });
    }
    setWaitingOnHuman(threadId, waiting) {
        const turn = this.turns.get(threadId);
        if (!turn)
            return;
        turn.waitingOnHuman = waiting;
        turn.lastEventAt = this.now();
    }
    setWaitingOnComputer(threadId, waiting) {
        const turn = this.turns.get(threadId);
        if (!turn)
            return;
        turn.waitingOnComputer = waiting;
        turn.lastEventAt = this.now();
    }
    settle(threadId) {
        this.turns.delete(threadId);
    }
    /** A Stop that discards the turn's later events leaves no way for a tool or a wait to report its end: watch the teardown as a fresh silent turn. */
    eventsDiscarded(threadId) {
        const turn = this.turns.get(threadId);
        if (turn)
            this.watch(threadId, turn.botId);
    }
    /** Stops a watched turn now, as a stall would (server/crash-guard.ts: an error in the turn's own work). */
    fail(threadId, reason = "server-error") {
        const turn = this.turns.get(threadId);
        if (!turn)
            return false;
        this.turns.delete(threadId);
        this.opts.onStall(turn, this.now() - turn.lastEventAt, reason);
        return true;
    }
    watching(threadId) {
        return this.turns.has(threadId);
    }
    waiting(threadId) {
        const turn = this.turns.get(threadId);
        return turn !== undefined && parked(turn);
    }
    /** A turn of this bot is answering now: running and not parked on a person or a computer. One that goes silent is
     * stopped by the sweep, so this never holds anything for longer than toolStallMs without events or a command's CPU use. */
    answering(botId) {
        for (const turn of this.turns.values())
            if (turn.botId === botId && !parked(turn))
                return true;
        return false;
    }
    /**
     * sleptMs: the real time since the last sweep when the process was suspended; it is forgiven, not counted as silence.
     * It may include up to one checkMs of awake time, so a stall after a sleep is caught up to one checkMs late, the
     * same lag a sweep already has; never early.
     */
    sweep(sleptMs = 0) {
        const at = this.now();
        for (const turn of this.turns.values()) {
            if (sleptMs)
                turn.lastEventAt = Math.min(at, turn.lastEventAt + sleptMs);
            const limit = this.silenceLimit(turn);
            if (limit === null)
                continue;
            // server/testing/group-local-vm-hooks.mjs rewrites the silentMs comparison below: keep that name.
            const { ms: silentMs, reason } = limit;
            if (at - turn.lastEventAt >= this.opts.stallMs)
                this.readCommandCpu(turn);
            if (at - turn.lastEventAt < silentMs)
                continue;
            this.turns.delete(turn.threadId);
            this.opts.onStall(turn, silentMs, reason);
        }
        this.freeUnheld(at);
    }
    /** null: the turn may wait on, parked while its engine is not known to be gone. */
    silenceLimit(turn) {
        if (parked(turn))
            return this.opts.engineGone?.(turn) ? { ms: this.opts.parkedStallMs, reason: "silent" } : null;
        // The engine's process is gone: nothing can finish this turn, so it waits for the driver's own word, not for a tool's.
        if (this.opts.engineExited?.(turn))
            return { ms: this.opts.engineExitStallMs, reason: "engine-exited" };
        return { ms: turn.runningTools.size > 0 ? Math.max(this.opts.stallMs, this.opts.toolStallMs) : this.opts.stallMs, reason: "silent" };
    }
    /** Reads the CPU time of a silent turn's shell command; one whose time changed since the last read is working (it gained
     * some, or a process came or went, as a build's compiler runs do), and that counts as an event, so a command that keeps
     * working is never stopped and one that stops for toolStallMs is. */
    readCommandCpu(turn) {
        const read = this.opts.commandCpuMs, command = parked(turn) ? undefined : oldestCommand(turn);
        if (!read || !command)
            return;
        const last = this.cpu.get(turn);
        if (last?.reading)
            return;
        const since = command.startedAt, previous = last?.since === since ? last.ms : null;
        this.cpu.set(turn, { since, ms: previous, reading: true });
        void Promise.resolve().then(() => read(turn, since)).catch(() => null).then((ms) => {
            // A read that failed keeps the last one to compare with.
            this.cpu.set(turn, { since, ms: ms ?? previous, reading: false });
            if (ms !== null && previous !== null && ms !== previous && this.turns.get(turn.threadId) === turn)
                turn.lastEventAt = Math.max(turn.lastEventAt, this.now());
        });
    }
    freeUnheld(at) {
        const unheld = this.opts.unheld;
        if (!unheld)
            return;
        const still = new Map();
        for (const { threadId, botId } of unheld.threads()) {
            if (this.turns.has(threadId))
                continue;
            const since = this.unheldSince.get(threadId) ?? at;
            if (at - since < this.opts.stallMs)
                still.set(threadId, since);
            else
                unheld.free(threadId, botId);
        }
        this.unheldSince = still;
    }
}
