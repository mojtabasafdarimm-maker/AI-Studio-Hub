import { SLOW_TURN_MS } from "./day-ledger.js";
import { PHASES } from "./phases.js";
import { processHealthLines, trimmedProcessHealth } from "./process-health.js";
import { RING_CAP } from "./turn-timings.js";
/** The health report's `perf` field is at most this many bytes of JSON; parts are dropped, least useful first, to fit. */
export const PERF_HEALTH_MAX_BYTES = 8 * 1024;
export const PERF_HEALTH_VERSION = 1;
const LIVE_SHOWN = 5, TOOLS_SHOWN = 8, HOLDS_SHOWN = 8;
const LIMIT_DRIVERS = new Set(["claude", "codex", "grok", "opencode"]);
const WINDOWS = new Set(["5-hour", "weekly", "other"]);
/** Engines refusing work, or within 10 points of their limit: driver kind, window, use and reset time only. */
export function limitHolds(report) {
    return (report?.engines ?? []).filter((limit) => LIMIT_DRIVERS.has(limit.driver) && (limit.blocked || (limit.usedPercent ?? 0) >= 90)).map((limit) => ({
        driver: limit.driver, window: limit.window && WINDOWS.has(limit.window) ? limit.window : null,
        usedPercent: typeof limit.usedPercent === "number" ? Math.round(limit.usedPercent) : null,
        resetsAt: typeof limit.resetsAt === "number" && Number.isFinite(limit.resetsAt) ? limit.resetsAt : null, blocked: limit.blocked === true, held: limit.held === true,
    })).slice(0, HOLDS_SHOWN);
}
const phasesOf = (phases) => Object.fromEntries(PHASES.flatMap((phase) => (phases[phase] ? [[phase, phases[phase]]] : [])));
export function perfHealth(sources) {
    const { hour, day } = sources;
    const body = {
        v: PERF_HEALTH_VERSION,
        slowEdgesMs: [...SLOW_TURN_MS],
        h1: { turns: hour.turns, failed: hour.failed, partial: hour.partial, slow: hour.slow, phases: phasesOf(hour.phases) },
        h24: { turns: day.turns, failed: day.failed, slow: day.slow, phases: phasesOf(day.phases), tools: day.tools.slice(0, TOOLS_SHOWN), retries: day.retries, limits: day.limits, failovers: day.failovers },
        live: sources.live.slice(0, LIVE_SHOWN),
        holds: limitHolds(sources.limits),
        process: sources.process,
        stalls: sources.stalls ?? null,
        processes: sources.processes ?? null,
    };
    const size = () => JSON.stringify(body).length;
    if (size() > PERF_HEALTH_MAX_BYTES && body.process)
        body.process = { ...body.process, buckets: body.process.buckets.slice(0, 6) };
    if (size() > PERF_HEALTH_MAX_BYTES)
        body.h24.tools = body.h24.tools.slice(0, 4);
    if (size() > PERF_HEALTH_MAX_BYTES)
        body.live = body.live.slice(0, 2);
    if (size() > PERF_HEALTH_MAX_BYTES && body.processes)
        body.processes = trimmedProcessHealth(body.processes);
    if (size() > PERF_HEALTH_MAX_BYTES)
        body.process = null;
    if (size() > PERF_HEALTH_MAX_BYTES)
        body.stalls = null;
    if (size() > PERF_HEALTH_MAX_BYTES)
        body.processes = null;
    return body;
}
const stallLine = (stats) => stats
    ? `p50 ${duration(stats.p50)} p95 ${duration(stats.p95)} p99 ${duration(stats.p99)} max ${duration(stats.max)}, ${stats.over100ms} over 100ms, ${stats.over1s} over 1s` : "not measured yet";
const tallyLine = (tally) => `${tally.n} taking ${duration(tally.ms)} (longest ${duration(tally.maxMs)})`;
export const stallLines = (stalls) => [
    `Event loop stalls, measured all the time: last minute ${stallLine(stalls.m1)}; last hour ${stallLine(stalls.h1)}`,
    `  Whole-file saves: last minute ${tallyLine(stalls.saves.m1)}; last hour ${tallyLine(stalls.saves.h1)}`,
    `  Runtime store reads: last minute ${tallyLine(stalls.runtimeReads.m1)}; last hour ${tallyLine(stalls.runtimeReads.h1)}`,
];
/** 850ms, 14s, 6m12s, 1h03m. */
export function duration(ms) {
    if (ms < 1000)
        return `${Math.round(ms)}ms`;
    const seconds = Math.round(ms / 1000);
    if (seconds < 60)
        return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
    return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}
const iso = (at) => new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
const phaseLine = (phases) => PHASES.flatMap((phase) => { const stats = phases[phase]; return stats ? [`${phase} p50 ${duration(stats.p50)} p95 ${duration(stats.p95)} max ${duration(stats.max)}`] : []; }).join("; ");
const slowLine = (slow) => SLOW_TURN_MS.map((edge, index) => `${slow[index] ?? 0} over ${duration(edge)}`).join(", ");
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const counts = (map) => Object.entries(map).sort((a, b) => b[1] - a[1]).map(([key, count]) => `${key} ${count}`).join(", ");
export function turnLine(turn) {
    const parts = PHASES.filter((phase) => phase !== "total" && turn.ms[phase] !== undefined)
        .map((phase) => `${phase} ${duration(turn.ms[phase])}${phase === "queue" && turn.queueWhy ? ` (${turn.queueWhy})` : ""}`);
    const tools = turn.tools.map((tool) => `${tool.kind} ${tool.n}x ${duration(tool.ms)}${tool.errors ? ` ${tool.errors} failed` : ""}${tool.open ? ` ${tool.open} left open` : ""}`);
    const extra = [
        turn.retries ? `retries ${turn.retries} (${(turn.retryWhy ?? []).join(", ")}), backoff ${duration(turn.backoffMs)}` : "",
        turn.limit ? `usage limit (${turn.limit})${turn.limitResetsAt ? ` resets ${iso(turn.limitResetsAt)}` : ""}` : "",
        turn.failover ? `moved to a backup AI (${turn.failover})` : "",
    ].filter(Boolean);
    return `${iso(turn.startedAt)} bot ${turn.botId ?? "?"} thread ${turn.threadId ?? "?"} ${turn.engine ?? "?"} ${turn.stop} ${duration(turn.ms.total ?? 0)}: ${parts.join(", ")}`
        + (tools.length ? ` [${tools.join("; ")}]` : "") + (extra.length ? `; ${extra.join("; ")}` : "");
}
/** Plain lines for people: the last hour and day, what runs now, usage limits, processes and the given recent turns. */
export function perfLines(sources, recent, recentTitle) {
    const { hour, day } = sources;
    const lines = ["## Performance (timings only: no messages, names, files or addresses)"];
    lines.push(`Last hour: ${plural(hour.turns, "turn")}, ${hour.failed} failed${hour.partial ? ` (only the latest ${RING_CAP} kept)` : ""}; slow: ${slowLine(hour.slow)}`);
    if (hour.turns)
        lines.push(`  ${phaseLine(hour.phases)}`);
    lines.push(`Last 24 h: ${plural(day.turns, "turn")}, ${day.failed} failed; slow: ${slowLine(day.slow)}`);
    if (day.turns)
        lines.push(`  ${phaseLine(day.phases)}`);
    if (day.tools.length)
        lines.push(`  Tool kinds by time: ${day.tools.slice(0, TOOLS_SHOWN).map((tool) => `${tool.kind} ${duration(tool.ms)} (${plural(tool.n, "call")}, p95 ${duration(tool.p95)}, max ${duration(tool.max)}${tool.errors ? `, ${tool.errors} failed` : ""}${tool.open ? `, ${tool.open} left open` : ""})`).join("; ")}`);
    if (day.retries.n)
        lines.push(`  Retries: ${day.retries.n} in ${plural(day.retries.turns, "turn")}, ${duration(day.retries.backoffMs)} of backoff (${counts(day.retries.why)})`);
    if (Object.keys(day.limits).length || day.failovers)
        lines.push(`  Usage limits refused: ${counts(day.limits) || "none"}; moved to a backup AI: ${day.failovers}`);
    const holds = limitHolds(sources.limits);
    lines.push(`Usage limits now: ${holds.length ? holds.map((hold) => `${hold.driver} ${hold.window ?? "?"} ${hold.usedPercent ?? "?"}%${hold.blocked ? " refusing work" : ""}${hold.resetsAt ? ` until ${iso(hold.resetsAt)}` : ""}`).join("; ") : "none near or at a limit"}`);
    lines.push(`Running now: ${sources.live.length ? sources.live.slice(0, LIVE_SHOWN).map((turn) => `bot ${turn.botId ?? "?"} thread ${turn.threadId ?? "?"} ${turn.engine ?? "?"} ${duration(turn.ageMs)}, ${turn.state}${turn.tool ? ` (${turn.tool})` : ""} for ${duration(turn.stateMs)}`).join("; ") : "no turn"}`);
    const proc = sources.process;
    if (proc && proc.samples) {
        lines.push(`Processes, last hour (${proc.scope === "all" ? "every process here" : "this app's own"}, sampled every ${proc.intervalS}s): ${proc.buckets.map((bucket) => `${bucket.bucket} ${bucket.cpu60mS}s CPU (5 min ${bucket.cpu5mS}s, peak ${bucket.peakPct}% of a core, ${bucket.procs} running, ${bucket.rssMB} MB)`).join("; ")}`);
        lines.push(`  Browsers running: ${proc.browsers}${proc.unseen60mS !== null ? `; CPU no sample accounts for: ${proc.unseen60mS}s` : ""}`);
        lines.push(`Event loop: busy ${proc.loop.eluPct ?? "?"}% (max ${proc.loop.eluMaxPct ?? "?"}%), sampler timer late p95 ${duration(proc.loop.driftP95Ms)}, max ${duration(proc.loop.driftMaxMs)} (one reading per sample)`);
    }
    else
        lines.push("Processes: not sampled yet");
    if (sources.stalls)
        lines.push(...stallLines(sources.stalls));
    if (sources.processes)
        lines.push(...processHealthLines(sources.processes));
    lines.push(recentTitle);
    lines.push(...(recent.length ? recent.map((turn) => `  ${turnLine(turn)}`) : ["  (none)"]));
    return lines;
}
