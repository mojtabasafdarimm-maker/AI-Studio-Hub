// Boat's `state` says a sandbox is ready; it does not say that its command agent answers. Its gateway answers 502 after
// about 40 s when a sandbox is too slow to answer, which was seen on sandboxes that had just been resumed, with
// `hydrated: false` and a snapshot `in_progress`. So the provider's state alone never means ready here: a short `true`
// has to come back as well.
// Unverified: that `hydrated`, `hydration`, `lastSnapshotStatus`, `health` and `degradedSince` are sent on every read. They
// only lengthen the wait when present; absent, the wait is the short one.
import { setTimeout as delay } from "node:timers/promises";
import { transientClaimFailure } from "./auto-vm-claims.js";
import { boatAccount, boatFetch, runCommand } from "./boat.js";
import { boatHealth } from "./boat-health.js";
import { relayBody } from "./boat-relay.js";
import { cloudComputerCounters } from "./cloud-computer-counters.js";
import { cloudComputerDisk } from "./cloud-computer-disk.js";
export const READY_WAIT = {
    /** A live machine answers `true` in about 0.2 s. Eight seconds is forty times that, and well under the 40 s the provider's
     * gateway holds a command to a sandbox that does not answer, so a probe that hangs costs a turn seconds, not most of a minute. */
    probeTimeoutMs: 8_000,
    /** Between probes that got no answer. */
    probeGapMs: 3_000,
    /** A computer that answered a command this recently is not probed again. Shorter than any stop and resume takes
     * (about 13 s at the fastest) plus the ten idle minutes before this app stops one. */
    freshMs: 60_000,
    /** With the provider saying ready and giving no reason for the silence: a resume takes about 8 s, so this is ten of them. */
    answerPatienceMs: 90_000,
    /** With the provider saying the disk is still being restored. Restores of 5 to 30 minutes were seen; past ten the
     * computer is restarted instead, once. */
    restorePatienceMs: 10 * 60_000,
    readTimeoutMs: 10_000,
};
const UNDER_WAY = /^(in[_-]?progress|pending|running|hydrating|restoring)$/i;
const statusOf = (value) => typeof value === "string" ? value : value && typeof value === "object" && typeof value.status === "string"
    ? value.status : null;
export function boatSignals(sandbox) {
    const box = (sandbox && typeof sandbox === "object" ? sandbox : {});
    const hydration = statusOf(box.hydration), snapshot = statusOf(box.lastSnapshotStatus);
    const restoring = box.hydrated === false || (hydration !== null && UNDER_WAY.test(hydration)) || (snapshot !== null && UNDER_WAY.test(snapshot))
        ? true : box.hydrated === true ? false : null;
    const degraded = (typeof box.health === "string" && box.health !== "ok") || Boolean(box.degradedSince)
        ? true : box.health === "ok" ? false : null;
    return { restoring, degraded };
}
async function probeOnce(cfg, boxId, signal) {
    try {
        const disk = cloudComputerDisk.probeCommand(boxId);
        const out = await runCommand(cfg, boxId, disk ?? "true", { timeoutMs: READY_WAIT.probeTimeoutMs, probe: true, signal });
        if (disk && out.ok)
            cloudComputerDisk.probed(cfg, boxId, out.stdout);
        return out.ok ? true : out.unanswered ? false : null;
    }
    catch (error) {
        return transientClaimFailure(error) ? false : null;
    }
}
/** The provider's own object for one sandbox, or null when it could not be read. */
export async function readBoat(cfg, boxId) {
    try {
        const res = await boatFetch(cfg, `/sandboxes/${boxId}`, { signal: AbortSignal.timeout(READY_WAIT.readTimeoutMs) });
        const body = relayBody(boatAccount(cfg), await res.json().catch(() => null));
        return res.ok ? body?.sandbox ?? null : null;
    }
    catch {
        return null;
    }
}
export function createBoatReadiness(overrides = {}) {
    const deps = {
        probe: probeOnce, read: readBoat, health: boatHealth, counters: cloudComputerCounters, now: Date.now,
        sleep: (ms, signal) => delay(ms, undefined, { signal }).catch(() => undefined),
        ...overrides,
    };
    const waiting = new Map();
    /** Resolves once the computer answers a command, or says which wait ran out. A probe that is turned away counts as
     * an answer: the call that follows gets the provider's own refusal. */
    async function awaitAnswer(cfg, boxId, opts = {}) {
        if (!opts.woke && deps.health.answeredWithin(boxId, READY_WAIT.freshMs))
            return { ok: true, waitedMs: 0 };
        const started = deps.now();
        const hardStop = opts.deadline ?? Infinity;
        let phase = "waking";
        let failures = 0;
        const enter = (next) => {
            if (next === phase && waiting.has(boxId))
                return;
            phase = next;
            waiting.set(boxId, { phase, since: started });
            opts.onPhase?.(phase);
        };
        const done = (answer) => {
            waiting.delete(boxId);
            if (failures > 0 || opts.woke)
                deps.counters.count(boxId, phase === "restoring" ? "restoreWaits" : "wakes", answer.waitedMs);
            return answer;
        };
        for (;;) {
            const answered = await deps.probe(cfg, boxId, opts.signal);
            if (opts.signal?.aborted)
                return done({ ok: false, phase, waitedMs: deps.now() - started });
            if (answered !== false) {
                if (answered)
                    deps.health.answered(boxId);
                return done({ ok: true, waitedMs: deps.now() - started });
            }
            failures += 1;
            deps.health.unanswered(boxId);
            enter(boatSignals(await deps.read(cfg, boxId)).restoring === true ? "restoring" : phase);
            const patience = phase === "restoring" ? READY_WAIT.restorePatienceMs : READY_WAIT.answerPatienceMs;
            // The patience may be overrun by one probe; the caller's deadline never is.
            const next = deps.now() + READY_WAIT.probeGapMs;
            if (next >= started + patience || next + READY_WAIT.probeTimeoutMs > hardStop)
                return done({ ok: false, phase, waitedMs: deps.now() - started });
            await deps.sleep(READY_WAIT.probeGapMs, opts.signal);
        }
    }
    return {
        awaitAnswer,
        /** What a wait under way is waiting for, for the computer's own state line. */
        waitingOn: (boxId) => waiting.get(boxId) ?? null,
    };
}
export const boatReadiness = createBoatReadiness();
