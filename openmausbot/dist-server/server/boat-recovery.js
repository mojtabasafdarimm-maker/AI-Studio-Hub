// A cloud computer that stopped answering: waited for while the provider is still restoring its disk, restarted once, then
// replaced (its deletion frees the plan's place, and the next use creates a new one) or, with automatic replacement off,
// left for the person. The bot and the person are told once. Nothing here asks the person anything.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import * as boat from "./boat.js";
import { BOAT_DELETING, BOAT_DELETION_FINISHED, getBoatDeletion } from "./boat-delete-journal.js";
import { boatHealth, DEAD_COMPUTER } from "./boat-health.js";
import { boatReadiness, boatSignals, readBoat, READY_WAIT } from "./boat-ready.js";
import { cloudComputerCounters } from "./cloud-computer-counters.js";
import { cloudFailureOf } from "./boat-limit.js";
import { DATA_DIR } from "./config.js";
import { CLOUD_COMPUTER_CAPPED, CLOUD_COMPUTER_DEAD_WAITING, CLOUD_COMPUTER_NEEDS_PERSON, CLOUD_COMPUTER_NOT_RESPONDING, CLOUD_COMPUTER_REPLACED, CLOUD_COMPUTER_REPLACED_BY_PERSON, CLOUD_COMPUTER_RESTARTED, CLOUD_COMPUTER_RESTARTING, CLOUD_COMPUTER_RESTARTING_UNANSWERED, CLOUD_COMPUTER_RESTORING, CLOUD_COMPUTER_STILL_RESTORING, CLOUD_COMPUTER_TEAM_NOT_RESPONDING, CLOUD_COMPUTER_UNREACHABLE, recoveryUnderWay, } from "../shared/cloud-computer-recovery.js";
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const KEPT_MS = DAY_MS;
const STOP_WAIT_MS = 90_000;
const WAKE_BUDGET_MS = 120_000;
const POLL_MS = 2_500;
/** A restart or replacement no longer running after this long has ended where the next start picks it up. */
const STALE_MS = 15 * 60_000;
/** How often a computer that is waited on before a restart (a disk restore, too short a silence, an unread state) is looked at again. */
const RECHECK_MS = 30_000;
/** With no other computer to compare against, a silent one is restarted only after this long without one answer. */
const SOLO_SILENCE_MS = 5 * 60_000;
/** A restart the person asked for answers the panel within this, however long the disk takes. */
const MANUAL_ANSWER_WAIT_MS = 3 * 60_000;
const READY = new Set(["idle", "ready", "running"]);
/** Whether a dead computer is deleted and replaced without the person. Off unless OMB_CLOUD_COMPUTER_AUTO_REPLACE is "1" or
 * config.json has `"features": {"cloudComputerAutoReplace": true}`; the environment, "1" or "0", wins. Off by default until
 * the provider confirms that deleting a computer whose host is unreachable is safe for the rest of the account. */
export function cloudComputerAutoReplace(cfg, env = process.env) {
    const override = env.OMB_CLOUD_COMPUTER_AUTO_REPLACE?.trim();
    if (override === "1")
        return true;
    if (override === "0")
        return false;
    return cfg.features?.cloudComputerAutoReplace === true;
}
export function createBoatRecovery(deps) {
    const health = deps.health ?? boatHealth;
    const now = deps.now ?? Date.now;
    const file = deps.file ?? join(DATA_DIR, "boat-replacements.json");
    const pollMs = deps.pollMs ?? POLL_MS;
    const autoReplace = deps.autoReplace ?? (() => cloudComputerAutoReplace(deps.cfg()));
    const eligible = (owner) => deps.eligible?.(owner) ?? true;
    const readiness = deps.readiness ?? boatReadiness;
    const read = deps.read ?? readBoat;
    /** When each computer was first seen not answering with its disk still being restored. */
    const restoringSince = new Map();
    const recheckMs = deps.recheckMs ?? RECHECK_MS;
    const verdicts = new Map();
    const judge = (owner, boxId, why) => verdicts.set(owner, { boxId, why, at: now() });
    const states = new Map();
    const lanes = new Map();
    const restarts = new Map();
    const timers = new Map();
    const retired = new Set();
    /** Lines already told about a computer still not answering, so a long outage is reported once. */
    const told = new Map();
    const restartedOwners = new Set();
    const restartToldAt = new Map();
    /** When the provider's `error` was first seen for each computer. */
    const errorSeen = new Map();
    let lastAutoRestartAt = -Infinity;
    let closed = false;
    const load = () => {
        try {
            const parsed = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
            return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry?.owner === "string"
                && typeof entry.boxId === "string" && typeof entry.at === "number") : [];
        }
        catch {
            return [];
        }
    };
    let entries = load();
    const write = (next) => {
        entries = next.filter((entry) => now() - entry.at < KEPT_MS);
        writeFileAtomic(file, JSON.stringify(entries));
    };
    const update = (boxId, patch) => write(entries.map((entry) => entry.boxId === boxId ? { ...entry, ...patch } : entry));
    const set = (owner, boxId, state, manual = false) => {
        states.set(owner, { state, at: now(), boxId, ...(manual ? { manual: true } : {}) });
        deps.changed?.(owner);
    };
    const clear = (owner, boxId) => {
        if (verdicts.get(owner)?.boxId === boxId)
            verdicts.delete(owner);
        restoringSince.delete(boxId);
        told.delete(boxId);
        errorSeen.delete(boxId);
        if (states.get(owner)?.boxId !== boxId)
            return;
        states.delete(owner);
        deps.changed?.(owner);
    };
    const tellOnce = (owner, boxId, state, line) => {
        set(owner, boxId, state);
        const lines = told.get(boxId) ?? new Set();
        told.set(boxId, lines);
        if (lines.has(line))
            return;
        lines.add(line);
        deps.tell(owner, line);
    };
    const needsPerson = (owner, boxId) => {
        if (!eligible(owner))
            judge(owner, boxId, "shared");
        tellOnce(owner, boxId, "needs-person", eligible(owner) ? "needsPerson" : "teamNotResponding");
    };
    const personBusy = (owner, boxId) => deps.personActive?.(owner) === true || health.personUsedWithin(boxId, DEAD_COMPUTER.personGraceMs);
    /** The provider's `error`, seen now: true once it was also seen at least DEAD_COMPUTER.deadConfirmMs earlier. */
    const deadConfirmed = (boxId) => {
        const first = errorSeen.get(boxId);
        if (first === undefined)
            errorSeen.set(boxId, now());
        return first !== undefined && now() - first >= DEAD_COMPUTER.deadConfirmMs;
    };
    /** One recovery at a time per owner, in the order asked. */
    function lane(owner, work) {
        const started = (lanes.get(owner) ?? Promise.resolve()).catch(() => undefined).then(work);
        const settled = started.finally(() => { if (lanes.get(owner) === settled)
            lanes.delete(owner); });
        lanes.set(owner, settled);
        return started;
    }
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function restart(owner, boxId, manual = false) {
        const cfg = deps.cfg();
        set(owner, boxId, "restarting", manual);
        restarts.set(boxId, now());
        const started = now();
        try {
            const stopped = await boat.boatFetch(cfg, `/sandboxes/${boxId}/stop`, { method: "POST", signal: AbortSignal.timeout(30_000) });
            await stopped.body?.cancel().catch(() => undefined);
            if (!stopped.ok && stopped.status !== 409)
                return "refused";
        }
        catch {
            return "refused";
        }
        for (const deadline = Date.now() + STOP_WAIT_MS; Date.now() < deadline && !closed;) {
            const seen = await boat.inspectBoatIdentity(cfg, boxId);
            const state = seen.identity?.state;
            if (seen.available && (!seen.identity || state === "error" || (state && boat.SLEEPING_BOAT_STATES.has(state) && state !== "archiving")))
                break;
            await wait(pollMs);
        }
        const woken = await boat.readyBoat(cfg, owner, WAKE_BUDGET_MS).catch(() => null);
        if (!woken || woken.id !== boxId)
            return "no-answer";
        // The provider reports a resumed computer ready before it answers, so one probe right after the resume proves nothing.
        const answer = await readiness.awaitAnswer(cfg, boxId, { woke: true, ...(manual ? { deadline: now() + MANUAL_ANSWER_WAIT_MS } : {}) });
        cloudComputerCounters.count(boxId, "restarts", now() - started);
        if (!answer.ok)
            return "no-answer";
        health.answered(boxId);
        return "answers";
    }
    const listWorks = async (cfg) => {
        try {
            const listed = await boat.boatFetch(cfg, "/sandboxes?limit=1", { signal: AbortSignal.timeout(20_000) });
            await listed.body?.cancel().catch(() => undefined);
            return listed.ok;
        }
        catch {
            return false;
        }
    };
    function unreachable(owner, boxId) {
        tellOnce(owner, boxId, "unreachable", "unreachable");
        deps.log(`cloud computer ${owner}: ${boxId} is not responding, and the provider can't be shown to be up; nothing was deleted`);
    }
    /** `dead` is the provider's word that the machine is gone; otherwise this computer only stopped answering. */
    async function replace(owner, target, opts = {}) {
        const cfg = deps.cfg();
        const recorded = entries.find((entry) => entry.boxId === target.boxId);
        // Only a delete already fenced on disk is finished without asking again.
        const fenced = Boolean(recorded && getBoatDeletion(target.boxId));
        if (!opts.manual) {
            if (!eligible(owner)) {
                needsPerson(owner, target.boxId);
                return "held";
            }
            if (!fenced && health.answeredWithin(target.boxId, DEAD_COMPUTER.answeredGraceMs)) {
                clear(owner, target.boxId);
                return "kept";
            }
            if (!autoReplace()) {
                needsPerson(owner, target.boxId);
                deps.log(`cloud computer ${owner}: ${target.boxId} is ${opts.dead ? "dead" : "not responding"}; automatic replacement is off, so it waits for the person`);
                return "held";
            }
            if (!fenced) {
                if (personBusy(owner, target.boxId)) {
                    needsPerson(owner, target.boxId);
                    return "held";
                }
                if (opts.dead && !deadConfirmed(target.boxId)) {
                    needsPerson(owner, target.boxId);
                    return "waiting";
                }
                if (!(await listWorks(cfg))) {
                    unreachable(owner, target.boxId);
                    return "held";
                }
                const automatic = entries.filter((entry) => !entry.manual && entry.boxId !== target.boxId && now() - entry.at < HOUR_MS);
                if (automatic.filter((entry) => entry.owner === owner).length >= DEAD_COMPUTER.replacementsPerHour) {
                    tellOnce(owner, target.boxId, "capped", "capped");
                    deps.log(`cloud computer ${owner}: ${target.boxId} was already replaced in the last hour; left as it is`);
                    return "capped";
                }
                if (automatic.length >= DEAD_COMPUTER.installationDeletesPerHour) {
                    needsPerson(owner, target.boxId);
                    deps.log(`cloud computer ${owner}: ${target.boxId} left for the person: this installation already deleted a computer by itself in the last hour`);
                    return "held";
                }
            }
        }
        set(owner, target.boxId, "replacing", opts.manual);
        if (!recorded)
            write([...entries, { owner, boxId: target.boxId, at: now(), ...(opts.manual ? { manual: true } : {}) }]);
        retired.add(target.boxId);
        let outcome;
        try {
            const deleted = await boat.requestRecordedBoatDeletion(cfg, { boxId: target.boxId, name: target.name, ownerBotId: owner });
            outcome = deleted === "confirmed" ? "confirmed" : "pending";
        }
        catch (error) {
            deps.log(`cloud computer ${owner}: deleting ${target.boxId} was not confirmed; its next start finishes it: ${error instanceof Error ? error.message : String(error)}`);
            outcome = "failed";
        }
        boat.forgetBoatId(target.boxId);
        health.forget(target.boxId);
        if (outcome === "failed") {
            if (!getBoatDeletion(target.boxId))
                retired.delete(target.boxId);
            return outcome;
        }
        set(owner, target.boxId, "replaced", opts.manual);
        if (!opts.manual) {
            deps.tell(owner, "replaced");
            update(target.boxId, { toldPerson: true });
        }
        deps.log(`cloud computer ${owner}: replaced ${target.boxId} (${opts.manual ? "asked for" : opts.dead ? "the provider reports it in error" : "not responding"})`);
        return outcome;
    }
    /** A fresh probe that got no answer, with the provider's list working; false when that is not so (the outcome is
     * reported). `witness`: before a delete, another computer of this installation must have answered as well. A restart
     * keeps the files, so the provider's own list answering is enough for it: an installation with one computer in use has
     * no witness, and would otherwise never be restarted. */
    async function stillDown(owner, boxId, cfg, witness = true) {
        const probe = await boat.probeBoat(cfg, boxId);
        if (probe !== false) {
            if (probe)
                health.answered(boxId);
            clear(owner, boxId);
            return false;
        }
        if (!(await listWorks(cfg))) {
            unreachable(owner, boxId);
            return false;
        }
        // An installation whose other computers do not answer either cannot tell a dead machine from its own outage.
        if (witness && !health.otherAnsweredWithin(boxId, DEAD_COMPUTER.witnessMs)) {
            needsPerson(owner, boxId);
            return false;
        }
        return true;
    }
    /** After the restart: replaced once the provider says the machine is gone, or after DEAD_COMPUTER.replaceAfterMs of no
     * answers while another computer of this installation answers (else the provider itself may be down). */
    async function decide(owner, boxId) {
        timers.delete(owner);
        const cfg = deps.cfg();
        const since = health.notRespondingSince(boxId);
        const seen = await boat.inspectBoatIdentity(cfg, boxId);
        if (!seen.available)
            return unreachable(owner, boxId);
        if (!seen.identity || !(await boat.boatNameMatchesBot(owner, seen.identity.name)))
            return clear(owner, boxId);
        if (seen.identity.state === "error")
            return void await replace(owner, seen.identity, { dead: true });
        if (since === null || !READY.has(seen.identity.state))
            return clear(owner, boxId);
        const left = since + DEAD_COMPUTER.replaceAfterMs - now();
        if (left > 0) {
            set(owner, boxId, "not-responding");
            const timer = setTimeout(() => void lane(owner, () => decide(owner, boxId)).catch((error) => deps.log(`cloud computer ${owner}: ${String(error)}`)), left);
            timer.unref?.();
            timers.set(owner, timer);
            return;
        }
        if (!(await stillDown(owner, boxId, cfg)))
            return;
        await replace(owner, seen.identity);
    }
    async function notResponding(owner, boxId) {
        const cfg = deps.cfg();
        set(owner, boxId, "not-responding");
        const seen = await boat.inspectBoatIdentity(cfg, boxId);
        if (!seen.available)
            return unreachable(owner, boxId);
        if (!seen.identity || !(await boat.boatNameMatchesBot(owner, seen.identity.name)))
            return clear(owner, boxId);
        if (seen.identity.state === "error")
            return void await replace(owner, seen.identity, { dead: true });
        if (!READY.has(seen.identity.state)) {
            health.forget(boxId);
            return clear(owner, boxId);
        }
        // Every guard before a stop: it closes the person's programs, and three failed probes can be this home's own outage.
        if (!(await stillDown(owner, boxId, cfg, false)))
            return;
        const since = Math.min(health.notRespondingSince(boxId) ?? now(), restoringSince.get(boxId) ?? now());
        restoringSince.set(boxId, since);
        /** Looks again shortly instead of restarting now. */
        const later = (state) => {
            set(owner, boxId, state);
            const timer = setTimeout(() => {
                timers.delete(owner);
                if (!closed)
                    void lane(owner, () => notResponding(owner, boxId)).catch((error) => deps.log(`cloud computer ${owner}: ${String(error)}`));
            }, recheckMs);
            timer.unref?.();
            timers.set(owner, timer);
        };
        // The provider's command gateway can fail for every computer while its API still calls each one ready. Then a
        // restart helps nobody and stops work that is still running, so one is made only when this computer alone is silent.
        const witnessed = health.otherAnsweredWithin(boxId, DEAD_COMPUTER.witnessMs);
        if (!witnessed && health.othersSilentWithin(boxId, DEAD_COMPUTER.witnessMs)) {
            deps.log(`cloud computer ${owner}: ${boxId} is not responding, and neither are this installation's other computers; nothing was restarted`);
            return unreachable(owner, boxId);
        }
        const box = await read(cfg, boxId);
        const state = box && typeof box === "object" ? box.state : undefined;
        // A state that could not be read is unknown, never a reason to restart.
        if (typeof state !== "string" || !READY.has(state))
            return now() - since < DEAD_COMPUTER.replaceAfterMs ? later("not-responding") : decide(owner, boxId);
        if (boatSignals(box).restoring === true && now() - since < READY_WAIT.restorePatienceMs)
            return later("restoring");
        if (!witnessed && now() - since < SOLO_SILENCE_MS)
            return later("not-responding");
        const lastRestart = restarts.get(boxId);
        const limited = (lastRestart !== undefined && now() - lastRestart < HOUR_MS) || now() - lastAutoRestartAt < DEAD_COMPUTER.restartGapMs;
        if (limited || personBusy(owner, boxId)) {
            // A restart that just failed stays the reason: it says more than the limit that restart itself set off.
            const failed = verdicts.get(owner);
            if (!(limited && failed?.boxId === boxId && failed.why === "restart-failed"))
                judge(owner, boxId, limited ? "restart-limited" : "person-busy");
            deps.log(`cloud computer ${owner}: ${boxId} is not responding and was not restarted: ${limited ? "a restart was made too recently" : "a person is using it"}`);
        }
        else {
            lastAutoRestartAt = now();
            deps.log(`cloud computer ${owner}: ${boxId} is not responding though the provider reports it ready; restarting it`);
            const restarted = await restart(owner, boxId);
            if (restarted === "answers") {
                set(owner, boxId, "restarted");
                told.delete(boxId);
                if (now() - (restartToldAt.get(boxId) ?? -Infinity) >= DAY_MS) {
                    restartToldAt.set(boxId, now());
                    deps.tell(owner, "restarted");
                }
                restartedOwners.add(owner);
                return;
            }
            judge(owner, boxId, "restart-failed");
            deps.log(`cloud computer ${owner}: ${boxId} still does not answer after a restart`);
        }
        return decide(owner, boxId);
    }
    const unsubscribe = health.onNotResponding((boxId) => {
        const owner = boat.boatOwnerOf(boxId);
        if (!owner || closed)
            return;
        if (!eligible(owner))
            return needsPerson(owner, boxId);
        if (lanes.has(owner) || timers.has(owner))
            return;
        set(owner, boxId, "not-responding");
        void lane(owner, () => notResponding(owner, boxId)).catch((error) => deps.log(`cloud computer ${owner}: recovery failed: ${String(error)}`));
    });
    boat.onDeadBoat(async (_cfg, owner, dead) => {
        if (!eligible(owner)) {
            needsPerson(owner, dead.boxId);
            throw Object.assign(new Error(CLOUD_COMPUTER_TEAM_NOT_RESPONDING), { status: 409 });
        }
        const outcome = await lane(owner, () => replace(owner, dead, { dead: true }));
        if (outcome === "capped") {
            throw Object.assign(new Error("it stopped working within an hour of being replaced, and MausBot replaces it at most once an hour; Replace computer in the computer panel tries once more"), { status: 409 });
        }
        if (outcome === "kept")
            throw Object.assign(new Error(CLOUD_COMPUTER_NOT_RESPONDING), { status: 409 });
        if (outcome === "waiting")
            throw Object.assign(new Error(CLOUD_COMPUTER_DEAD_WAITING), { status: 409 });
        if (outcome === "held")
            throw Object.assign(new Error(CLOUD_COMPUTER_NEEDS_PERSON), { status: 409 });
        throw Object.assign(new Error("the previous cloud computer deletion finished — retry to create a new computer"), { status: 409, code: outcome === "confirmed" ? BOAT_DELETION_FINISHED : BOAT_DELETING });
    });
    return {
        /** What the computer panel shows; ended states for an hour. */
        status(owner) {
            const found = states.get(owner);
            if (!found)
                return null;
            const age = now() - found.at;
            const over = recoveryUnderWay(found.state)
                ? !lanes.has(owner) && !timers.has(owner) && age >= STALE_MS
                : age >= HOUR_MS || (["unreachable", "capped", "needs-person"].includes(found.state) && health.answeredWithin(found.boxId, age));
            if (over) {
                clear(owner, found.boxId);
                return null;
            }
            return { state: found.state, at: found.at, ...(found.manual ? { manual: true } : {}) };
        },
        /** In place of a computer call: `before` it runs, while the computer is being restarted or replaced; `after` it got no
         * answer, what is known about why. */
        refusal(boxId, phase) {
            if (retired.has(boxId))
                return CLOUD_COMPUTER_NOT_RESPONDING;
            const owner = boat.boatOwnerOf(boxId);
            const found = owner ? states.get(owner) : undefined;
            if (found?.boxId === boxId && found.state === "restarting")
                return phase === "before" ? CLOUD_COMPUTER_RESTARTING : CLOUD_COMPUTER_RESTARTING_UNANSWERED;
            if (found?.boxId === boxId && found.state === "restoring")
                return phase === "before" ? CLOUD_COMPUTER_RESTORING : CLOUD_COMPUTER_STILL_RESTORING;
            if (found?.boxId === boxId && recoveryUnderWay(found.state))
                return CLOUD_COMPUTER_NOT_RESPONDING;
            if (phase === "before")
                return null;
            if (found?.boxId === boxId && found.state === "unreachable")
                return CLOUD_COMPUTER_UNREACHABLE;
            if (found?.boxId === boxId && found.state === "capped")
                return CLOUD_COMPUTER_CAPPED;
            if (found?.boxId === boxId && found.state === "needs-person")
                return eligible(owner) ? CLOUD_COMPUTER_NEEDS_PERSON : CLOUD_COMPUTER_TEAM_NOT_RESPONDING;
            return health.notRespondingSince(boxId) === null ? null : CLOUD_COMPUTER_NOT_RESPONDING;
        },
        /** Told once, with the first call on the owner's computer after a replacement or a restart. */
        notice(boxId) {
            const owner = boat.boatOwnerOf(boxId);
            if (!owner)
                return null;
            if (restartedOwners.delete(owner))
                return CLOUD_COMPUTER_RESTARTED;
            const owed = entries.filter((entry) => entry.owner === owner && entry.boxId !== boxId && !entry.toldBot);
            if (!owed.length)
                return null;
            write(entries.map((entry) => owed.includes(entry) ? { ...entry, toldBot: true, toldPerson: true } : entry));
            if (owed.some((entry) => !entry.toldPerson && !entry.manual))
                deps.tell(owner, "replaced");
            return owed.every((entry) => entry.manual) ? CLOUD_COMPUTER_REPLACED_BY_PERSON : CLOUD_COMPUTER_REPLACED;
        },
        /** A start the Admin turned away for computers at once, right after this owner's computer was replaced: the old one's
         * place is still being given back. */
        claimSentence(owner, error) {
            const recent = entries.some((entry) => entry.owner === owner && now() - entry.at < 15 * 60_000);
            return recent && cloudFailureOf(error).limit?.reason === "at_once" ? CLOUD_COMPUTER_NOT_RESPONDING : undefined;
        },
        /** Its computer is dead at the provider, has stopped answering, or is being handled here: what lets the person act
         * during a turn. A computer that came back (restarted, or already replaced) is not stuck. */
        stuck(owner) {
            const box = boat.boatIdOf(owner), state = states.get(owner)?.state;
            return (state !== undefined && state !== "restarted" && state !== "replaced") || boat.deadBoatOf(owner) !== null
                || (box !== null && health.notRespondingSince(box) !== null);
        },
        /** Why this owner's computer, not answering, was left as it is; null while that is not decided, once it answers, or
         * when it was decided before `since`. Written before the state moves to one that has ended. */
        verdict: (owner, since = -Infinity) => {
            const found = verdicts.get(owner);
            return found && found.at >= since ? found.why : null;
        },
        /** The panel's Restart computer: the same restart the automatic path tries first. */
        async restart(owner) {
            const found = await boat.findBoat(deps.cfg(), owner);
            if (!found)
                throw Object.assign(new Error(boat.deadBoatOf(owner) ? "This computer can't be restarted; replace it instead." : "This bot has no cloud computer to restart."), { status: 409 });
            const outcome = await lane(owner, () => restart(owner, found.id, true));
            if (outcome === "answers") {
                set(owner, found.id, "restarted", true);
                return { answers: true };
            }
            clear(owner, found.id);
            return { answers: false };
        },
        /** The panel's Replace computer, confirmed by the person: the same deletion the automatic path makes, with no hourly limit. */
        async replace(owner) {
            const found = (await boat.findBoat(deps.cfg(), owner)) ?? boat.deadBoatOf(owner);
            if (!found)
                throw Object.assign(new Error("This bot has no cloud computer to replace."), { status: 409 });
            const target = "boxId" in found ? found : { boxId: String(found.id), name: String(found.name) };
            const outcome = await lane(owner, () => replace(owner, target, { manual: true }));
            if (outcome === "failed")
                throw Object.assign(new Error("The old computer's deletion was not confirmed. Try again in a minute."), { status: 503 });
            return { replaced: true };
        },
        close() {
            closed = true;
            unsubscribe();
            boat.onDeadBoat(null);
            for (const timer of timers.values())
                clearTimeout(timer);
            timers.clear();
        },
    };
}
