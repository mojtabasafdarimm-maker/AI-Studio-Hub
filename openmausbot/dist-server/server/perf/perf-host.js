// The server's one performance recorder: turn timings from the bus and the store, the process sampler, rate-limited log
// lines for slow events, and the views the health read, a @devs report and the desktop's diagnostics take from them.
import { join } from "node:path";
import { createLoopStalls, requestArrivedBefore } from "./loop-stalls.js";
import { duration, limitHolds, perfHealth, perfLines, turnLine } from "./perf-report.js";
import { createProcessHealth } from "./process-health.js";
import { createProcessSampler, linuxProcessList, LINUX_SAMPLE_MS, nodeUtilization, OTHER_SAMPLE_MS, psProcessList } from "./process-sampler.js";
import { createTurnTimings } from "./turn-timings.js";
export const PERF_FILE = "perf-timings.json";
/** One line per kind of slow event at most this often; the ones held back are counted on the next. */
export const LOG_EVERY_MS = 60_000;
const RECENT_IN_REPORT = 10;
/** What a report shows when the recorder failed: diagnostics never fail because of it. */
export const PERF_UNAVAILABLE = ["## Performance", "(timings unavailable: the recorder failed; see the server log)"];
/** A log line per kind at most every LOG_EVERY_MS. */
export function rateLimitedLog(log, now) {
    const last = new Map();
    return (kind, line) => {
        const entry = last.get(kind);
        if (entry && now() - entry.at < LOG_EVERY_MS) {
            entry.held += 1;
            return;
        }
        log(`[perf] ${line}${entry?.held ? ` (+${entry.held} more since the last)` : ""}`);
        last.set(kind, { at: now(), held: 0 });
    };
}
export function slowLine(note, now) {
    if (note.kind === "turn")
        return `slow turn ${turnLine(note.turn)}`;
    if (note.kind === "tool")
        return `slow tool call: ${note.tool} ${duration(note.ms)} ${note.ok ? "ok" : "failed or left open"} engine ${note.engine ?? "?"} bot ${note.botId ?? "?"} thread ${note.threadId ?? "?"}`;
    return `usage limit refused a turn: engine ${note.engine ?? "?"} scope ${note.scope}${note.resetsAt ? ` resets in ${duration(Math.max(0, note.resetsAt - now))}` : ""}`;
}
export function createPerfHost(deps) {
    const now = deps.now ?? Date.now;
    const say = rateLimitedLog(deps.log ?? ((line) => console.warn(line)), now);
    const timings = createTurnTimings({
        file: join(deps.dataDir, PERF_FILE), now, botOf: (threadId) => deps.store.botByThread(threadId)?.id ?? null,
        slow: (note) => say(note.kind, slowLine(note, now())),
    });
    /** Runs `read`, or logs once a minute and returns `fallback`: nothing the recorder does may fail its caller. */
    const guarded = (what, read, fallback) => {
        try {
            return read();
        }
        catch (error) {
            say(`failed:${what}`, `the performance recorder failed (${what}): ${error instanceof Error ? error.name : "error"}`);
            return fallback;
        }
    };
    deps.store.onChange((change) => { if (change.type === "message")
        guarded("message", () => timings.noteMessage(change.threadId, change.message, requestArrivedBefore(change.message.at)), undefined); });
    deps.bus.subscribe((event) => guarded("event", () => timings.noteEvent(event), undefined));
    /** The limit clock is made after this host; until it is, there are no limits to read. */
    const limits = () => { try {
        return deps.limits?.() ?? null;
    }
    catch {
        return null;
    } };
    let held = new Set();
    const watchHolds = () => {
        const current = new Set(limitHolds(limits()).filter((hold) => hold.blocked).map((hold) => `${hold.driver}:${hold.window ?? "?"}`));
        for (const key of current)
            if (!held.has(key))
                say(`hold:${key}`, `usage limit hold started: ${key}`);
        for (const key of held)
            if (!current.has(key))
                say(`hold:${key}`, `usage limit hold ended: ${key}`);
        held = current;
    };
    const enginePids = () => new Map((deps.engines?.() ?? []).map(({ pid, threads }) => [pid, threads.map(timings.engineOf).find((kind) => kind !== null) ?? "unknown"]));
    const linux = process.platform === "linux", windows = process.platform === "win32";
    /** Its two warnings are said once each for the life of the server. */
    const processes = deps.processes ?? createProcessHealth({ warn: (kind, line) => say(kind, line) });
    const sampler = deps.sampler ?? createProcessSampler({
        list: linux ? () => linuxProcessList() : psProcessList, intervalMs: linux ? LINUX_SAMPLE_MS : OTHER_SAMPLE_MS,
        scope: deps.wholeMachine && linux ? "all" : "tree", utilization: nodeUtilization(), now, engines: enginePids,
        stalled: (ms) => say("loop", `event loop stalled: the ${linux ? 60 : 300}s sampler fired ${duration(ms)} late`), afterSample: watchHolds,
        seen: (rows, buckets) => processes.sample(rows, buckets),
    });
    if (deps.timer !== false && !windows)
        sampler.start();
    const stalls = deps.stalls ?? createLoopStalls();
    if (deps.timer !== false)
        stalls.start();
    if (deps.timer !== false && linux)
        guarded("limits", () => (deps.log ?? ((line) => console.warn(line)))(processes.startLine()), undefined);
    const sources = () => ({ hour: timings.window(), day: timings.day(), live: timings.live(), limits: limits(), process: windows ? null : sampler.report(), stalls: guarded("stalls", () => stalls.report(), null), processes: processes.report() });
    return {
        timings,
        sampler,
        noteHeld: (threadId, why) => guarded("held", () => timings.noteHeld(threadId, why), undefined),
        noteFailover: (threadId, why) => guarded("failover", () => timings.noteFailover(threadId, why), undefined),
        noteNotStarted: (threadId, turnId, refusal) => guarded("refused", () => timings.noteNotStarted(threadId, turnId, refusal), undefined),
        /** Logs a usage-limit hold that started or ended since the last check; the sampler runs it after each sample. */
        checkHolds: watchHolds,
        health: () => guarded("health", () => perfHealth(sources()), null),
        /** For a @devs report: these conversations' and bots' latest turns, then everything else. */
        lines(filter) {
            return guarded("lines", () => perfLines(sources(), timings.recent({ ...filter, limit: RECENT_IN_REPORT }), "Latest turns in this conversation or of its bots, newest last:"), PERF_UNAVAILABLE);
        },
        /** For the desktop's diagnostics export: every bot's latest turns. */
        text() {
            return guarded("text", () => perfLines(sources(), timings.recent({ limit: RECENT_IN_REPORT }), "Latest turns, newest last:"), PERF_UNAVAILABLE).join("\n");
        },
        /** The graceful shutdown: no more samples, and the turns since the last save written now. */
        stop() { sampler.stop(); stalls.stop(); guarded("save", () => timings.flush(), undefined); },
    };
}
