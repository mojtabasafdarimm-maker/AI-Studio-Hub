import { availableMemory, boxMemory } from "../box-memory.js";
import { engineMemory } from "../engine-memory.js";
import { seenWithin } from "../thread-presence.js";
const DEFAULT_IDLE_MS = 10 * 60_000;
/** One warm engine and its MCP servers take 250 to 450 MB: on a box this small an idle one is soon given back, and the
 * next turn resumes its session by id. */
export const SMALL_BOX_BYTES = 1.5 * 1024 ** 3;
export const SMALL_BOX_IDLE_MS = 150_000;
const MINIMUM_IDLE_MS = 10_000;
/** setTimeout treats anything above 2^31-1 ms as 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;
function usableMilliseconds(raw) {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 && value <= MAX_TIMER_MS ? value : null;
}
/** Per-harness names (OMB_CLAUDE_SESSION_IDLE_*, OMB_ACP_SESSION_IDLE_*) win over OMB_SESSION_IDLE_MS /
 *  OMB_SESSION_IDLE_MIN_MS, which win over the box's default; the floor is the greater of ten seconds and any configured
 *  minimum. */
export function sessionIdlePolicy(driverPrefix, env = process.env, boxBytes = boxMemory().bytes) {
    const minimumMs = Math.max(MINIMUM_IDLE_MS, usableMilliseconds(env[`OMB_${driverPrefix}_SESSION_IDLE_MIN_MS`] ?? env.OMB_SESSION_IDLE_MIN_MS) ?? 0);
    const configured = usableMilliseconds(env[`OMB_${driverPrefix}_SESSION_IDLE_MS`] ?? env.OMB_SESSION_IDLE_MS) ?? (boxBytes <= SMALL_BOX_BYTES ? SMALL_BOX_IDLE_MS : DEFAULT_IDLE_MS);
    return { idleMs: Math.max(minimumMs, configured), minimumMs };
}
/** On a small box with less than half of it free, a second idle engine would leave no room for a turn's own engine. On a
 * self-hosted server whose memory or pids limit holds only so many engines (`fits`), no more stay idle than fit beside the
 * ones working: each holds its processes and threads against that limit while it waits. */
export function idleEnginesAllowed(box, availableBytes, fits = Infinity) {
    return Math.min(fits, box.bytes <= SMALL_BOX_BYTES && availableBytes < box.bytes / 2 ? 1 : Infinity);
}
/** Idle engines of every driver, the longest idle first. */
const warmEngines = new Map();
/** An engine went idle: when the box allows fewer idle engines than are up, the ones idle longest close now. */
export function keepWarm(key, engine, box = boxMemory(), available = availableMemory, fits = () => engineMemory.idleEnginesAllowed()) {
    const most = fits();
    if (box.bytes > SMALL_BOX_BYTES && most === Infinity)
        return;
    warmEngines.delete(key);
    warmEngines.set(key, engine);
    for (const [other, warm] of warmEngines)
        if (other !== key && !warm.idle())
            warmEngines.delete(other);
    const extra = warmEngines.size - idleEnginesAllowed(box, available(), most);
    if (extra <= 0)
        return;
    for (const [other, warm] of [...warmEngines].slice(0, extra)) {
        warmEngines.delete(other);
        warm.close();
    }
}
/** Closes an idle engine after `ms`, or sooner on a small box once another engine goes idle after it. */
export function armIdleClose(key, ms, engine) {
    const timer = setTimeout(engine.close, ms);
    timer.unref?.();
    keepWarm(key, engine);
    return timer;
}
export function stopIdleClose(key, timer) {
    if (timer)
        clearTimeout(timer);
    warmEngines.delete(key);
}
export function warmEngineKeys() {
    return [...warmEngines.keys()];
}
/** A person wrote in, opened or read the thread this recently: it is the conversation in front of them. */
const WATCHED_MS = 30 * 60_000;
/** A thread nobody has in front of them (a teammate's delegated work, a routine) keeps its engine this long. */
export const UNWATCHED_IDLE_MS = 30_000;
/**
 * How long one thread's idle engine stays up after a turn. Where turns wait for room (a Cloud home, a self-hosted Linux
 * server): briefly for a thread no person has had in front of them lately, and for the one they have, the configured time
 * scaled by the memory left (down to a tenth). Elsewhere the configured time.
 */
export function engineIdleMs(threadId, policy, memory = engineMemory, now = Date.now()) {
    if (!memory.enabled)
        return policy.idleMs;
    if (!seenWithin(threadId, WATCHED_MS, now))
        return Math.max(policy.minimumMs, Math.min(policy.idleMs, UNWATCHED_IDLE_MS));
    return Math.max(policy.minimumMs, Math.round(policy.idleMs * memory.headroom()));
}
/** Whether this thread's engine (`pid`, the process that exited) was just stopped to make room, or for want of it: a
 * driver does not start it again at once, into the same shortage. */
export const stoppedForRoom = (threadId, pid) => engineMemory.stoppedForRoom(threadId, pid);
