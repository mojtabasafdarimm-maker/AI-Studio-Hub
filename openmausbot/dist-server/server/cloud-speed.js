// How fast a Cloud home is, for the Admin's health read. Privacy invariant: numbers and
// fixed-bucket counts only, never what a message said, which bot it was for or where it came from. Everything is read
// when the report is built or counted on events the server already has: no timer and no sampler of its own.
import { readFileSync } from "node:fs";
import { uptime } from "node:os";
/** Upper bounds of the turn-start buckets (ms); one more bucket counts everything slower. The Admin reads the same edges. */
export const TURN_START_BUCKETS_MS = [500, 1_000, 2_000, 5_000, 15_000];
/** A read this soon after the last one keeps that one's CPU figures: a window this short says little. */
export const SPEED_MIN_WINDOW_MS = 60_000;
/** A process that came up this soon after its kernel booted started with its machine (a Fly machine start), so a wake's
 * time runs from the kernel's start; anywhere else (a container on a long-running server) it runs from the process's. */
const WITH_MACHINE_MS = 120_000;
/** The first request this soon after the server listens is the one that woke the home; a later one found it awake. */
const WAKE_REQUEST_MS = 5_000;
/** A person's message whose turn has not started after this long never will (refused, a setup card): it is dropped. */
const ACCEPTED_TTL_MS = 30 * 60_000;
const ACCEPTED_CAP = 500;
/** A turn whose end never came through is taken as over after this long, so its thread is timed again. */
const LIVE_TTL_MS = 6 * 3_600_000;
const PSI_RESOURCES = ["cpu", "memory", "io"];
/** `/proc/stat`'s first line: all CPU time and the stolen part, in USER_HZ ticks. Guest time is inside user time already. */
export function parseCpuStat(text) {
    const fields = /^cpu\s+([\d\s]+)$/m.exec(text)?.[1]?.trim().split(/\s+/).map(Number);
    if (!fields || fields.length < 4 || fields.some((value) => !Number.isFinite(value)))
        return null;
    return { total: fields.slice(0, 8).reduce((sum, value) => sum + value, 0), steal: fields.length >= 8 ? fields[7] : null };
}
/** A pressure file's cumulative "some" stall time, in microseconds. */
export function parsePressureTotal(text) {
    const total = /^some\b.*\btotal=(\d+)/m.exec(text)?.[1];
    return total === undefined ? null : Number(total);
}
/** The pressure file of this home's own cgroup when it has one (a container), else the whole machine's. Kept for the
 * process's life, so every window compares one counter with itself. */
function pressurePath(resource, read) {
    return [`/sys/fs/cgroup/${resource}.pressure`, `/proc/pressure/${resource}`].find((path) => {
        const text = read(path);
        return text !== null && parsePressureTotal(text) !== null;
    }) ?? null;
}
const percent = (value) => Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
/** A counter that went down (wrapped, or the kernel's view reset) says nothing about this window. */
const grew = (before, after) => before === null || before === undefined || after === null || after === undefined || after < before ? null : after - before;
const readText = (path) => { try {
    return readFileSync(path, "utf8");
}
catch {
    return null;
} };
export function createCloudSpeed(options = {}) {
    const read = options.read ?? readText, now = options.now ?? Date.now, monotonic = options.monotonic ?? (() => performance.now());
    const machineUptime = options.machineUptime ?? uptime, processUptime = options.processUptime ?? (() => process.uptime());
    const paths = Object.fromEntries(PSI_RESOURCES.map((resource) => [resource, pressurePath(resource, read)]));
    const sample = () => {
        const stat = read("/proc/stat");
        const psi = Object.fromEntries(PSI_RESOURCES.map((resource) => {
            const text = paths[resource] ? read(paths[resource]) : null;
            return [resource, text === null ? null : parsePressureTotal(text)];
        }));
        return { at: monotonic(), cpu: stat === null ? null : parseCpuStat(stat), psi };
    };
    let base = sample(), last = null;
    let bootMs = null, wakeFrom = null, readyAt = null, wakeMs = null;
    const turnStarts = Array.from({ length: TURN_START_BUCKETS_MS.length + 1 }, () => 0);
    const accepted = new Map(), live = new Map();
    const cpuFigures = () => {
        const current = sample(), ms = current.at - base.at;
        if (last && ms < SPEED_MIN_WINDOW_MS)
            return last;
        const total = grew(base.cpu?.total, current.cpu?.total), stolen = grew(base.cpu?.steal, current.cpu?.steal);
        const psi = Object.fromEntries(PSI_RESOURCES.map((resource) => {
            const stalled = grew(base.psi[resource], current.psi[resource]);
            return [resource, stalled === null || ms <= 0 ? null : percent(stalled / (ms * 10))];
        }));
        base = current;
        last = { windowS: ms > 0 ? Math.round(ms / 1000) : null, steal: total && stolen !== null ? percent(stolen / total * 100) : null, psi };
        return last;
    };
    return {
        /** The server listens: this boot's time, and where a wake's time starts. */
        ready() {
            if (readyAt !== null)
                return;
            readyAt = now();
            const processSeconds = processUptime(), machineSeconds = machineUptime();
            bootMs = Math.round(processSeconds * 1000);
            wakeFrom = readyAt - Math.round((machineSeconds - processSeconds < WITH_MACHINE_MS / 1000 ? machineSeconds : processSeconds) * 1000);
        },
        /** The first request after a boot from a stopped sleep reached the server. */
        wakeRequest(at) {
            if (readyAt === null || wakeFrom === null || wakeMs !== null || at - readyAt > WAKE_REQUEST_MS)
                return;
            wakeMs = Math.max(0, at - wakeFrom);
        },
        /** A person's message, stored while its thread runs no turn, waits for its turn to start. */
        noteMessage(threadId, message) {
            if (message.role !== "user" || message.kind !== "text" || message.steered || message.aside || message.from?.botId || message.peerAsk || message.automation)
                return;
            if ((live.get(threadId) ?? -Infinity) > now() - LIVE_TTL_MS || accepted.has(threadId))
                return;
            for (const [id, at] of accepted)
                if (at < now() - ACCEPTED_TTL_MS || accepted.size >= ACCEPTED_CAP)
                    accepted.delete(id);
                else
                    break;
            accepted.set(threadId, message.at);
        },
        noteEvent(event) {
            if (event.type === "turn.completed") {
                live.delete(event.threadId);
                return;
            }
            if (event.type !== "turn.started")
                return;
            live.delete(event.threadId);
            live.set(event.threadId, now());
            if (live.size > ACCEPTED_CAP)
                live.delete(live.keys().next().value);
            const at = accepted.get(event.threadId);
            if (at === undefined)
                return;
            accepted.delete(event.threadId);
            const waited = now() - at;
            if (waited < 0 || waited > ACCEPTED_TTL_MS)
                return;
            const bucket = TURN_START_BUCKETS_MS.findIndex((edge) => waited <= edge);
            turnStarts[bucket === -1 ? TURN_START_BUCKETS_MS.length : bucket] += 1;
        },
        report() {
            return { ...cpuFigures(), bootMs, wakeMs, turnStarts: [...turnStarts] };
        },
    };
}
