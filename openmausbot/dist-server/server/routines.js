import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./config.js";
import { OwnedFile } from "./atomic.js";
import { saveSoon } from "./save-batch.js";
import { RunProgressSave } from "./routine-progress-save.js";
import { redactSecretsInText } from "./redact.js";
import { activeRunsOf, nextDueOf, schedulerDueOf, wakeHoldOf } from "./routine-due.js";
import { startDueTimer } from "./due-timer.js";
import { intervalAllowsOccurrence, intervalHasRestrictions, isSameLocalDay, latestIntervalOccurrence } from "./routine-intervals.js";
import { cloneSchedule, limitResetOccurrence, mergeScheduleUpdate, nextOccurrence, RoutineScheduleError } from "./routine-schedules.js";
import { runsOnce } from "../shared/limit-reset.js";
import { limitResetRunOwed } from "./limit-reset-owed.js";
import { ROUTINE_HANDOFF_WAIT, isRoutineProblemRun, } from "../shared/routines.js";
import { composeExecutionPrompt, continuityCarry, ROUTINE_DEFERRAL_NOTICE_MS, ROUTINE_SUPERSEDED, routineFailure, routineHostWarning, supersededBy, } from "./routine-execution.js";
import { dispatchRefusal, engineFacts, nextScheduledRun, recoverRun, requeueOnce, startPrompt, weekRuns, } from "./routine-recovery.js";
import { askOf, settleAsk, waitingFor } from "./routine-waits.js";
import { failsLikeLastOutcome, outcomesNewestFirst } from "./routine-outcomes.js";
import { createRunGate } from "./routine-run-gate.js";
import { busyWait, markStop, RunClock, runOverLimit, SlowStops, withBoundedStops } from "./routine-bounds.js";
import { keepUnreadableAside, readRoutineFile, UNREADABLE_RETRY_MS } from "./routine-file.js";
import { noStartAlert, noStartSpacing, turnBackOn } from "./routine-no-start.js";
import { afterRunSpacing, failureSpacingAlert, runSpacing } from "./routine-failure-spacing.js";
import { blockingRun, recordSkip } from "./routine-skips.js";
import { restartRetryAt, startupDecision } from "./routine-restarts.js";
import { routineHealthOf } from "./routine-health.js";
import { Occurrences, ROUTINE_TURN_GONE } from "./routine-occurrences.js";
import { CATCH_UP_MS, planOccurrence, settleRestored, staggered } from "./routine-catch-up.js";
import { evictRuns } from "./routine-run-history.js";
import { RunWatch } from "./routine-run-watch.js";
import { scheduleSection } from "./routine-schedule-report.js";
import { EVENT_RETRY_WINDOW_MS, MAX_EVENT_RECEIPTS } from "./routine-event-receipts.js";
import { attachmentPathsOf, cloneAttachments } from "./routine-attachments.js";
import { loadInstalledPackage, matchingRequestReceipt, rememberRequest } from "./routine-load.js";
import { applyHolds, holdCauses } from "./routine-holds.js";
import { cancelUnfinishedRuns, interruptRunTurns } from "./routine-stops.js";
import { sanitizeInput } from "./routine-input.js";
import { applyCheckResult, clipRunOutput, codedLine, routineLine, runLineFields } from "./routine-lines.js";
import { checkHold, CHECK_BOOT_HOLD_MS } from "./routine-check-pacing.js";
import { resolveRoutineResultsThread, routineRunDefinition } from "./routine-run-definition.js";
export { intervalHasRestrictions } from "./routine-intervals.js";
export { nextOccurrence, RoutineScheduleError } from "./routine-schedules.js";
function routineRequestOwnerKey(owner) {
    return JSON.stringify([owner.requestId, owner.messageId, owner.botId, owner.threadId]);
}
const WAKE_HORIZON_MS = 60 * 60_000;
export const ROUTINE_RESTARTED = "OpenMausBot restarted while this routine was running";
const MAX_RUNS = 2_000;
const earliest = (...times) => times.reduce((first, at) => at === null ? first : first === null ? at : Math.min(first, at), null);
function cloneRoutine(routine) {
    return {
        ...routine,
        schedule: cloneSchedule(routine.schedule),
        attachments: cloneAttachments(routine.attachments),
    };
}
function cloneRun(run) {
    return {
        ...run,
        attachments: cloneAttachments(run.attachments),
        denials: run.denials ? [...run.denials] : undefined,
    };
}
export class RoutineManager {
    file;
    disk;
    now;
    options;
    routines = [];
    /** Written back unchanged on every save, so unrelated work never deletes a repairable row. */
    unloadedRoutines = [];
    runs = [];
    routineRequestReceipts = [];
    webhookRunReceipts = [];
    timer = null;
    startupRunsQueued = false;
    startupLaunchId;
    ticking = false;
    closing = false;
    ownerNotices = [];
    /** Why routines are held now (routine-holds.ts): a change between two of these pauses or frees routines. */
    holds = [];
    failureFacts = new Map();
    /** Saves are refused while unreadable, so an empty state never overwrites the file; malformedAttachments: a saved list failed to load, so no clear may trust attachmentPaths(). */
    unreadable = false;
    malformedAttachments = false;
    noStartOffsChecked = false;
    turnedBackOn = [];
    clock = new RunClock();
    slowStops = new SlowStops(() => this.now(), (threadId, state) => this.stopChanged(threadId, state));
    frozenPending = false;
    bootedAt;
    checking = new Set();
    progress = new RunProgressSave(() => this.file, () => this.save());
    gate = createRunGate((run, signal) => this.options.prepareRun?.(cloneRun(run), signal) ?? null, () => this.tickInBackground());
    ledger;
    watch;
    passedAt = -Infinity;
    constructor(options) {
        this.options = withBoundedStops(options, this.slowStops);
        this.file = options.file ?? join(DATA_DIR, "routines.json");
        this.disk = new OwnedFile(this.file, { mode: 0o600 });
        this.now = options.now ?? Date.now;
        this.bootedAt = this.now();
        this.ledger = new Occurrences(this.file, this.now, options.home?.machine);
        this.watch = new RunWatch(options.turnLive);
        this.load();
    }
    /** Reads routines.json into memory; false while it is there but cannot be read, when nothing in memory is trusted or saved. */
    load(read = readRoutineFile(this.file, this.now())) {
        const before = this.unreadable;
        this.unreadable = read.state === "unreadable";
        // The file's path and a fixed reason only: its content never reaches the log.
        if (read.state === "unreadable" && !before)
            console.error(`routines: ${this.file} cannot be read (${read.reason}), so no routine runs until it can; it is left as it is, with a copy at ${keepUnreadableAside(this.file) ?? "no path (the copy failed)"}`);
        if (read.state !== "ok")
            return read.state === "missing";
        ({ routines: this.routines, unloadedRoutines: this.unloadedRoutines, runs: this.runs, malformedAttachments: this.malformedAttachments, routineRequestReceipts: this.routineRequestReceipts,
            webhookRunReceipts: this.webhookRunReceipts, frozenPending: this.frozenPending, ownerNotices: this.ownerNotices, holds: this.holds,
            startupLaunchId: this.startupLaunchId, noStartOffsChecked: this.noStartOffsChecked } = read);
        this.disk.loaded(read.text);
        const cut = settleRestored(this.routines, this.runs, this.ledger.restoredThrough, this.now(), (routine, past) => this.advancePastOccurrence(routine, past, past)).map(cloneRun);
        this.ledger.restoredThrough = null;
        let restarts = 0;
        for (const run of this.runs.filter((candidate) => candidate.status === "running" || candidate.status === "waiting")) {
            settleAsk(run, undefined, this.now());
            if (run.threadId && run.target === "bot" && this.options.hasPendingDelegations?.(run.threadId) === true) {
                this.wait(run, ROUTINE_HANDOFF_WAIT);
                continue;
            }
            if (!requeueOnce(run, "restarted", ROUTINE_RESTARTED, this.now(), restartRetryAt(this.now(), restarts++, this.ledger.retryAfterBoot(run)))) {
                Object.assign(run, { status: "failed", error: ROUTINE_RESTARTED, attention: undefined, finishedAt: this.now() });
                if (run.target === "room-goal")
                    run.goalStatus = "failed";
            }
            cut.push(cloneRun(run));
        }
        const look = !this.noStartOffsChecked && this.options.moveFrozen?.() !== true;
        const back = look ? turnBackOn(this.routines, this.runs, this.holds[0], this.now(), (schedule, now) => this.initialOccurrence(schedule, now)) : [];
        // The look is noted with the next save: reading a file in which nothing changes writes nothing.
        if (look) {
            this.noStartOffsChecked = true;
            this.turnedBackOn = back.filter((routine) => routine.enabled);
        }
        this.ledger.observe(this.routines, this.runs, false)();
        if (cut.length > 0 || back.length > 0)
            this.saveLater();
        for (const run of cut) {
            if (run.threadId)
                this.options.onRunCut?.(run);
            this.notifyRunChanged(run);
            if (run.status === "failed")
                this.options.onRunFailed?.(run);
        }
        return true;
    }
    /** Files every saved routine and run names, unloaded rows too; null while routines.json is unreadable or a row's attachments are malformed, so nothing can clear them. */
    attachmentPaths() { return this.unreadable || this.malformedAttachments ? null : attachmentPathsOf([...this.routines, ...this.unloadedRoutines, ...this.runs]); }
    listRoutines() {
        return this.routines.map(routine => this.routineWithHealth(routine));
    }
    clearFrozenResultsThreads() {
        if (!this.frozenPending)
            return;
        for (const routine of this.routines) {
            if (routine.target === "bot" && routine.resultsThreadId !== undefined &&
                this.options.frozenResultsThread?.(routine.botId, routine.resultsThreadId))
                delete routine.resultsThreadId;
        }
        this.frozenPending = false;
        this.saveLater();
    }
    routineWithHealth(routine) {
        const outcomes = outcomesNewestFirst(this.runs, routine.id);
        const success = outcomes.findIndex(run => run.status === "completed");
        const failures = success < 0 ? outcomes.length : success;
        const { installedPackage: _installedPackage, ...visible } = cloneRoutine(routine);
        const warning = routineHostWarning(routine), week = weekRuns(this.runs, routine.id, this.now()), spaced = noStartSpacing(routine, this.runs);
        return { ...visible, ...(failures ? { failureStreak: failures } : {}), ...(spaced ? { noStartStreak: spaced.streak } : {}), ...(week ? { weekRuns: week } : {}), ...(warning ? { warning } : {}) };
    }
    packageStamps() {
        return this.routines.flatMap((routine) => routine.installedPackage
            ? [{ routineId: routine.id, botId: routine.botId, enabled: routine.enabled, stamp: structuredClone(routine.installedPackage) }]
            : []);
    }
    stampInstalledPackage(id, stamp) {
        const clean = loadInstalledPackage(stamp);
        if (!clean)
            throw new Error("Invalid routine package stamp");
        if (!this.routines.some((routine) => routine.id === id))
            return false;
        this.commitMutation(() => {
            const routine = this.routines.find((candidate) => candidate.id === id);
            routine.installedPackage = clean;
        });
        return true;
    }
    /** Whether routines.json cannot be read, and how often stopping a turn outlasted its wait: for the app and the health report. */
    schedulerState() { return { unreadable: this.unreadable, slowStops: this.slowStops.count }; }
    health(cap) { return routineHealthOf(this.routines, this.runs, cap); }
    /** The health report's `schedule` section (routine-schedule-report.ts), from the ledger as it is now. */
    scheduleReport() {
        const next = this.unreadable ? [] : this.routines.filter((routine) => routine.enabled && !routine.checks && routine.nextRunAt != null && this.targetState(routine) !== "missing")
            .map((routine) => ({ at: routine.nextRunAt, paused: routine.target !== "room-goal" && Boolean(this.options.pausedText?.(routine.botId)) }));
        return scheduleSection({ seq: this.ledger.sequence(this.unreadable), unreadable: this.unreadable || this.ledger.degraded, slowStops: this.slowStops.count, next, records: this.ledger.ledger.all(), boot: this.ledger.counts, now: this.now() });
    }
    /** A routine's scheduled occurrences as the ledger holds them, newest first: ids, times, counts and fixed words. */
    occurrences(routineId) { return this.ledger.ledger.ofRoutine(routineId).sort((a, b) => b.dueAt - a.dueAt).map((record) => structuredClone(record)); }
    /** Routines an earlier version had switched off that this start turned back on, handed over once, for a line to their bots. */
    takeTurnedBackOn() { return this.turnedBackOn.splice(0).map(cloneRoutine); }
    /** Each routine with the next run it will really make: one whose runs are spaced out is not due for the occurrences it skips. */
    planned(routines) { return routines.map((routine) => routine.checks || runsOnce(routine.schedule) ? routine : afterRunSpacing(routine, this.runs, this.now(), nextOccurrence)); }
    wakeHold(horizonMs = WAKE_HORIZON_MS) { return wakeHoldOf(this.planned(this.routines), this.runs, this.now(), horizonMs); }
    /** A Cloud home's sleep check (server/routine-due.ts). */
    hasActiveRuns() { return activeRunsOf(this.runs, this.now()); }
    nextDueAt() { return nextDueOf(this.planned(this.routines.filter((routine) => routine.target === "room-goal" || !this.options.pausedText?.(routine.botId))), this.runs, this.now()); }
    listRuns(from, to) {
        return this.runs
            .filter((r) => (from == null || r.scheduledFor >= from) && (to == null || r.scheduledFor <= to))
            .sort((a, b) => b.scheduledFor - a.scheduledFor)
            .map(cloneRun);
    }
    activeRunForBot(botId) {
        const run = this.runs.find((candidate) => candidate.botId === botId && ["running", "waiting"].includes(candidate.status));
        return run ? cloneRun(run) : null;
    }
    activeBotRunForBot(botId) {
        const run = this.runs.find((candidate) => candidate.target === "bot" &&
            candidate.botId === botId &&
            ["running", "waiting"].includes(candidate.status));
        return run ? cloneRun(run) : null;
    }
    routineRequestReceipt(requestId) {
        const receipt = this.routineRequestReceipts.find((candidate) => candidate.requestId === requestId);
        return receipt ? { ...receipt } : null;
    }
    routineRequestReceiptOwners() {
        return this.routineRequestReceipts.map(({ requestId, messageId, botId, threadId }) => ({
            requestId,
            messageId,
            botId,
            threadId,
        }));
    }
    /** Unsettled receipts are never count-evicted: an open card keeps its exactly-once recovery for its whole life. */
    forgetRoutineRequestReceipt(request) {
        const receipt = this.matchingRoutineRequestReceipt(request);
        if (!receipt)
            return false;
        const index = this.routineRequestReceipts.indexOf(receipt);
        this.commitMutation(() => {
            this.routineRequestReceipts.splice(index, 1);
        });
        return true;
    }
    forgetRoutineRequestReceiptsForThread(threadId) {
        const kept = this.routineRequestReceipts.filter((receipt) => receipt.threadId !== threadId);
        const removed = this.routineRequestReceipts.length - kept.length;
        if (removed === 0)
            return 0;
        this.commitMutation(() => {
            this.routineRequestReceipts = kept;
        });
        return removed;
    }
    reconcileRoutineRequestReceipts(reachable) {
        const keys = new Set(reachable.map(routineRequestOwnerKey));
        const kept = this.routineRequestReceipts.filter((receipt) => keys.has(routineRequestOwnerKey(receipt)));
        const removed = this.routineRequestReceipts.length - kept.length;
        if (removed === 0)
            return 0;
        this.commitMutation(() => {
            this.routineRequestReceipts = kept;
        });
        return removed;
    }
    isActiveThread(threadId) {
        return this.runs.some((run) => run.threadId === threadId && ["running", "waiting"].includes(run.status));
    }
    runForThread(threadId) {
        const run = this.runs.findLast((candidate) => candidate.threadId === threadId && ["running", "waiting"].includes(candidate.status)) ??
            this.runs.findLast((candidate) => candidate.threadId === threadId);
        return run ? cloneRun(run) : null;
    }
    noteReport(id, report) {
        const run = this.runs.find((candidate) => candidate.id === id);
        if (!run)
            return null;
        if (report)
            run.report = report;
        else
            delete run.report;
        this.saveLater();
        this.emitRun(run);
        return cloneRun(run);
    }
    create(input, request) {
        this.assertWritable();
        if (request) {
            const receipt = this.matchingRoutineRequestReceipt(request);
            if (receipt) {
                const committed = this.routines.find((routine) => routine.id === receipt.resultId);
                if (committed)
                    return this.routineWithHealth(committed);
                throw new Error("This routine request was already applied");
            }
        }
        const at = this.now();
        const clean = sanitizeInput(input, at);
        clean.schedule = this.timedSchedule(clean.schedule);
        if (this.targetState(clean) === "missing")
            throw new Error(this.missingTargetMessage(clean.target));
        const nextRunAt = clean.enabled ? this.initialOccurrence(clean.schedule, at) : null;
        if (clean.schedule.type === "interval" && clean.enabled && nextRunAt === null) {
            throw new Error("This interval has no future runs. Choose a later end date or turn it off.");
        }
        const routine = {
            id: randomUUID(),
            ...clean,
            // Only a confirmed chat card supplies `request`: the calendar API cannot pick an arbitrary transcript.
            sourceThreadId: request?.threadId,
            nextRunAt,
            createdAt: at,
            updatedAt: at,
        };
        const discardResults = this.applyResultsInput(routine, input.resultsThreadId);
        this.commitMutation(() => {
            this.routines.unshift(routine);
            if (request)
                this.rememberRoutineRequest(request, routine.id, at);
        }, discardResults);
        this.emitRoutine(routine);
        return this.routineWithHealth(routine);
    }
    /** Routines and runs another server holds, under their own ids: `apply` edits the lists, which are saved whole or not at all. */
    adopt(apply) { this.assertWritable(); let changed = []; this.commitMutation(() => { changed = apply({ routines: this.routines, runs: this.runs }); }); for (const routine of changed)
        this.emitRoutine(routine); }
    update(id, patch, request) {
        this.assertWritable();
        if (request) {
            const receipt = this.matchingRoutineRequestReceipt(request);
            if (receipt) {
                const committed = this.routines.find((routine) => routine.id === receipt.resultId);
                return committed ? this.routineWithHealth(committed) : null;
            }
        }
        const routine = this.routines.find((r) => r.id === id);
        if (!routine)
            return null;
        const now = this.now();
        const clean = sanitizeInput({
            name: patch.name ?? routine.name,
            prompt: patch.prompt ?? routine.prompt,
            target: patch.target ?? routine.target,
            botId: patch.botId ?? routine.botId,
            groupId: Object.hasOwn(patch, "groupId") ? patch.groupId : routine.groupId,
            runOn: patch.runOn ?? routine.runOn,
            enabled: patch.enabled ?? routine.enabled,
            schedule: patch.schedule ? mergeScheduleUpdate(routine.schedule, patch.schedule) : routine.schedule,
            durationMinutes: patch.durationMinutes ?? routine.durationMinutes,
            timeoutMinutes: Object.hasOwn(patch, "timeoutMinutes") ? patch.timeoutMinutes : routine.timeoutMinutes,
            attachments: patch.attachments ?? routine.attachments,
            continuity: patch.continuity ?? routine.continuity, sameConversation: patch.sameConversation ?? routine.sameConversation,
            modelSelection: Object.hasOwn(patch, "modelSelection") ? patch.modelSelection : routine.modelSelection,
            overlap: Object.hasOwn(patch, "overlap") ? patch.overlap : routine.overlap,
            runOnStartup: patch.runOnStartup ?? routine.runOnStartup,
            checks: Object.hasOwn(patch, "checks") ? patch.checks : routine.checks,
            access: Object.hasOwn(patch, "access") ? patch.access : routine.access,
            deliver: Object.hasOwn(patch, "deliver") ? patch.deliver : routine.deliver,
        }, now);
        clean.schedule = this.timedSchedule(clean.schedule, routine.id);
        if (this.targetState(clean) === "missing")
            throw new Error(this.missingTargetMessage(clean.target));
        const scheduleChanged = JSON.stringify(clean.schedule) !== JSON.stringify(routine.schedule);
        const enabledChanged = clean.enabled !== routine.enabled;
        if (enabledChanged && clean.enabled && clean.schedule.type === "once" && clean.schedule.at <= now)
            throw new RoutineScheduleError("Its time has passed. Edit it to pick a new time.");
        const nextRunAt = !clean.enabled ? null : scheduleChanged || enabledChanged
            ? this.initialOccurrence(clean.schedule, now)
            : routine.nextRunAt;
        if (clean.schedule.type === "interval" && clean.enabled && nextRunAt === null) {
            throw new Error("This interval has no future runs. Choose a later end date or turn it off.");
        }
        const destination = { ...routine, ...clean };
        if (destination.botId !== routine.botId)
            delete destination.resultsThreadId;
        const discardResults = this.applyResultsInput(destination, patch.resultsThreadId);
        let stopped;
        this.commitMutation(() => {
            Object.assign(routine, clean, {
                resultsThreadId: destination.resultsThreadId,
                nextRunAt,
                // updatedAt doubles as the confirmation cards' optimistic revision: keep it monotonic within one ms.
                updatedAt: Math.max(now, routine.updatedAt + 1),
            });
            if (patch.enabled !== undefined)
                delete routine.heldFor;
            for (const key of ["continuity", "sameConversation", "modelSelection", "overlap", "runOnStartup", "access", "deliver"])
                if (!clean[key])
                    delete routine[key];
            if (!clean.checks)
                for (const key of ["checks", "checkedAt", "checkTrouble", "checkTroubleCode", "wakeAt"])
                    delete routine[key];
            if (Object.hasOwn(patch, "timeoutMinutes") && patch.timeoutMinutes == null) {
                delete routine.timeoutMinutes;
            }
            if (patch.enabled === false)
                stopped = cancelUnfinishedRuns(this.runs, routine.id, this.now(), "paused");
            if (request)
                this.rememberRoutineRequest(request, routine.id, now);
        }, discardResults);
        for (const run of stopped?.cancelled ?? [])
            this.emitRun(run);
        interruptRunTurns(stopped?.waited ?? [], this.options);
        this.emitRoutine(routine);
        return this.routineWithHealth(routine);
    }
    remove(id, request) {
        this.assertWritable();
        if (request && this.matchingRoutineRequestReceipt(request))
            return true;
        const at = this.routines.findIndex((r) => r.id === id);
        if (at === -1)
            return false;
        const changedRuns = [];
        let stopped;
        this.commitMutation(() => {
            this.routines.splice(at, 1);
            for (const run of this.runs) {
                if (run.routineId !== id || run.status === "queued" || run.status === "waiting" || run.seenAt || !isRoutineProblemRun(run))
                    continue;
                run.seenAt = this.now();
                changedRuns.push(run);
            }
            stopped = cancelUnfinishedRuns(this.runs, id, this.now(), "deleted");
            if (request)
                this.rememberRoutineRequest(request, id, this.now());
        });
        for (const run of [...stopped.cancelled, ...changedRuns])
            this.emitRun(run);
        interruptRunTurns(stopped.waited, this.options);
        this.options.emit?.({ kind: "routine.deleted", routineId: id });
        return true;
    }
    /** A deleted bot's schedules go with it, or with `routineId` that one only (one person's alone, gone as they leave a team): each is removed, its unfinished runs stop, and its run history is dropped. */
    removeForBot(botId, routineId) {
        for (const routine of this.routines.filter((candidate) => candidate.botId === botId && (routineId === undefined || candidate.id === routineId)))
            this.remove(routine.id);
        for (const run of this.runs) {
            if (run.botId !== botId || (routineId !== undefined && run.routineId !== routineId) || !["queued", "running", "waiting"].includes(run.status))
                continue;
            run.status = "cancelled";
            if (run.target === "room-goal")
                run.goalStatus = "stopped";
            run.attention = undefined;
            run.finishedAt = this.now();
            run.error = routineId === undefined ? "The assigned bot was deleted" : "The routine was deleted";
            this.emitRun(run);
            interruptRunTurns([run], this.options);
        }
        const kept = this.runs.filter((run) => run.botId !== botId || (routineId !== undefined && run.routineId !== routineId));
        if (kept.length !== this.runs.length)
            this.commitMutation(() => { this.runs = kept; });
    }
    disableForGroup(groupId) {
        let changed = false;
        for (const routine of this.routines) {
            if (routine.target !== "room-goal" || routine.groupId !== groupId || (!routine.enabled && !routine.heldFor))
                continue;
            delete routine.heldFor;
            routine.enabled = false;
            routine.nextRunAt = null;
            routine.updatedAt = Math.max(this.now(), routine.updatedAt + 1);
            this.emitRoutine(routine);
            changed = true;
        }
        for (const run of this.runs) {
            if (run.target !== "room-goal" ||
                run.groupId !== groupId ||
                !["queued", "running", "waiting"].includes(run.status))
                continue;
            run.status = "cancelled";
            run.goalStatus = "stopped";
            run.attention = undefined;
            run.finishedAt = this.now();
            run.error = "The assigned room was deleted";
            this.emitRun(run);
            if (run.threadId) {
                void this.options.interruptGoal?.(groupId, run.threadId).catch(() => { });
            }
            changed = true;
        }
        if (changed)
            this.saveLater();
    }
    runNow(id, request) {
        if (this.closing)
            return null;
        if (request) {
            const receipt = this.matchingRoutineRequestReceipt(request);
            if (receipt) {
                const committed = this.runs.find((run) => run.id === receipt.resultId);
                return committed ? cloneRun(committed) : null;
            }
        }
        const routine = this.routines.find((r) => r.id === id);
        if (!routine)
            return null;
        let run;
        const allocations = [];
        const previousDestination = routine.resultsThreadId;
        this.commitMutation(() => {
            run = this.newRun(routine, this.now(), true, allocations, request?.threadId ?? routine.sourceThreadId);
            if (request)
                run.sourceThreadId = request.threadId;
            if (request)
                this.rememberRoutineRequest(request, run.id, this.now());
        }, () => this.discardResultsThreads(allocations));
        if (routine.resultsThreadId !== previousDestination)
            this.emitRoutine(routine);
        this.emitRun(run);
        queueMicrotask(() => this.tickInBackground());
        return cloneRun(run);
    }
    webhookRunReceipt(webhookId, deliveryId) {
        const receipt = this.webhookRunReceipts.find((candidate) => candidate.webhookId === webhookId && candidate.deliveryId === deliveryId &&
            candidate.acceptedAt >= this.now() - EVENT_RETRY_WINDOW_MS);
        if (receipt)
            return { id: receipt.runId };
        const active = this.runs.find((run) => run.webhookId === webhookId && run.deliveryId === deliveryId &&
            ["queued", "running", "waiting"].includes(run.status));
        return active ? { id: active.id } : null;
    }
    enqueueWebhook(input) {
        this.assertWritable();
        const existing = this.webhookRunReceipt(input.webhookId, input.deliveryId);
        if (existing)
            return existing;
        if (this.options.botState(input.botId) === "missing") {
            throw Object.assign(new Error("The assigned MAUS no longer exists"), { status: 410 });
        }
        const run = {
            id: randomUUID(), routineId: input.webhookId, routineName: input.webhookName, prompt: input.prompt, target: "bot",
            botId: input.botId, runOn: input.runOn, scheduledFor: input.receivedAt, status: "queued", manual: false,
            triggerSource: "webhook", webhookId: input.webhookId, deliveryId: input.deliveryId, attachments: [], createdAt: this.now(),
            resultsThreadId: input.resultsThreadId ?? this.options.eventResultsThread?.(input), ...(input.eventSource ? { eventSource: input.eventSource } : {}), ...(input.sameConversation ? { sameConversation: true } : {}), ...(input.byPerson ? { byPerson: true } : {}),
        };
        this.commitEvent(run, input.deliveryId, () => { this.runs.push(run); });
        return cloneRun(run);
    }
    /** Adds an outside event to its trigger's run that has not started yet, so a burst becomes one run. Null when there
     *  is no such run with the same conversation setting, or `merge` declines (the run is full). */
    mergeIntoQueuedRun(webhookId, deliveryId, sameConversation, merge) {
        this.assertWritable();
        const existing = this.webhookRunReceipt(webhookId, deliveryId);
        if (existing)
            return existing;
        const run = this.runs.findLast((candidate) => candidate.webhookId === webhookId && candidate.status === "queued" && !candidate.threadId && (candidate.sameConversation === true) === sameConversation);
        const merged = run?.prompt === undefined ? null : merge(run.prompt);
        if (!run || merged === null)
            return null;
        const before = run.prompt;
        this.commitEvent(run, deliveryId, () => { run.prompt = merged; }, () => { run.prompt = before; });
        return { id: run.id };
    }
    commitEvent(run, deliveryId, apply, revert) {
        const previousReceipts = this.webhookRunReceipts;
        const receipts = previousReceipts.filter((receipt) => receipt.acceptedAt >= this.now() - EVENT_RETRY_WINDOW_MS);
        // Never evict a promised retry identity to admit fresh work.
        if (receipts.length >= MAX_EVENT_RECEIPTS)
            throw Object.assign(new Error("Webhook retry history is full; try again later"), { status: 429 });
        receipts.push({ webhookId: run.webhookId, deliveryId, runId: run.id, acceptedAt: this.now() });
        const previousRuns = this.runs.slice();
        apply();
        this.webhookRunReceipts = receipts;
        try {
            this.save();
        }
        catch (error) {
            // Keep the live run objects tick() may be awaiting, not cloned snapshots.
            this.runs = previousRuns;
            this.webhookRunReceipts = previousReceipts;
            revert?.();
            throw error;
        }
        this.emitRun(run);
        queueMicrotask(() => this.tickInBackground());
    }
    activeWebhookRunCount(webhookId) {
        return this.runs.filter((run) => run.webhookId === webhookId && ["queued", "running", "waiting"].includes(run.status)).length;
    }
    cancelQueuedWebhook(webhookId, message) {
        let changed = false;
        for (const run of this.runs) {
            if (run.webhookId !== webhookId || run.status !== "queued")
                continue;
            run.status = "cancelled";
            run.attention = undefined;
            run.finishedAt = this.now();
            run.error = message.slice(0, 500);
            this.emitRun(run);
            changed = true;
        }
        if (changed)
            this.saveLater();
    }
    async cancelRun(id, reason) {
        const run = this.runs.find((r) => r.id === id);
        if (!run || !["queued", "running", "waiting"].includes(run.status))
            return null;
        run.status = "cancelled";
        if (run.target === "room-goal")
            run.goalStatus = "stopped";
        run.attention = undefined;
        run.finishedAt = this.now();
        if (reason)
            run.error = reason;
        this.saveLater();
        this.emitRun(run);
        if (run.threadId) {
            if (run.target === "room-goal") {
                await this.options.interruptGoal?.(run.groupId, run.threadId).catch(() => { });
            }
            else {
                await this.options.interruptTurn?.(run.botId, run.threadId).catch(() => { });
            }
        }
        queueMicrotask(() => this.tickInBackground());
        return cloneRun(run);
    }
    markSeen(id) {
        const run = this.runs.find((r) => r.id === id);
        if (!run)
            return null;
        if (!run.seenAt) {
            run.seenAt = this.now();
            this.saveLater();
            this.emitRun(run);
        }
        return cloneRun(run);
    }
    markAllSeen(visible = () => true) {
        const due = (run) => !run.seenAt && isRoutineProblemRun(run) && visible(run);
        if (!this.runs.some(due))
            return [];
        const stampAt = this.now();
        const updated = [];
        this.commitMutation(() => {
            for (const run of this.runs.filter(due)) {
                run.seenAt = stampAt;
                updated.push(run);
            }
        });
        for (const run of updated)
            this.emitRun(run);
        return updated.map(cloneRun);
    }
    /** The computer's clock moved to another time zone (a Cloud took its owner's): a daily or weekly time, or an interval
     * kept to some days or hours, now falls at another instant. A cron rule names its own zone, a one-time run is an
     * instant and a plain interval counts elapsed time, so those keep theirs. Returns how many moved. */
    rescheduleLocalTimes() {
        const now = this.now();
        const moved = this.routines.filter((routine) => {
            const local = routine.schedule.type === "daily" || (routine.schedule.type === "interval" && intervalHasRestrictions(routine.schedule));
            if (!routine.enabled || routine.nextRunAt == null || !local)
                return false;
            const next = nextOccurrence(routine.schedule, now);
            if (next === routine.nextRunAt)
                return false;
            routine.nextRunAt = next;
            return true;
        });
        if (moved.length)
            this.saveLater();
        for (const routine of moved)
            this.emitRoutine(routine);
        return moved.length;
    }
    /** The engines' reset times changed: each limit-reset routine that is on takes its engine's new time, once the run it owes a passed reset was made (limit-reset-owed.ts). */
    retimeLimitResets() {
        const moved = this.routines.filter((routine) => {
            if (!routine.enabled || routine.schedule.type !== "limit_reset" || limitResetRunOwed(routine, this.runs, this.now()))
                return false;
            const schedule = this.timedSchedule(routine.schedule, routine.id);
            if (schedule.type !== "limit_reset" || (schedule.at === routine.schedule.at && schedule.at === routine.nextRunAt))
                return false;
            routine.schedule = schedule;
            routine.nextRunAt = schedule.at;
            return true;
        });
        if (moved.length)
            this.saveLater();
        for (const routine of moved)
            this.emitRoutine(routine);
        return moved.length;
    }
    /** Moves only the next run to `until`; the runs after it keep their schedule. A limit-reset routine has no time to move. */
    /** Why routines wait now (routine-holds.ts). Returns the causes that began and paused a routine, for one line to the owner. */
    holdFor(causes) {
        const after = holdCauses(causes);
        if (this.unreadable || after.join() === this.holds.join())
            return [];
        let held;
        this.commitMutation(() => { held = applyHolds(this.routines, this.runs, this.holds, after, this.now(), (schedule, now) => this.initialOccurrence(schedule, now)); this.holds = after; });
        for (const run of held.cancelled)
            this.emitRun(run);
        for (const routine of [...held.paused, ...held.resumed])
            this.emitRoutine(routine);
        return held.paused.length ? held.began : [];
    }
    deferNextRun(id, until) {
        const routine = this.routines.find((candidate) => candidate.id === id);
        if (!routine)
            return null;
        if (!routine.enabled || routine.nextRunAt === null || routine.nextRunAt >= until || routine.schedule.type === "limit_reset")
            return this.routineWithHealth(routine);
        this.commitMutation(() => {
            if (routine.schedule.type === "once")
                routine.schedule = { type: "once", at: until };
            routine.nextRunAt = until;
        });
        this.emitRoutine(routine);
        return this.routineWithHealth(routine);
    }
    timedSchedule(schedule, routineId, ranFor) {
        if (schedule.type !== "limit_reset")
            return schedule;
        const last = ranFor ?? (routineId ? this.runs.findLast((run) => run.routineId === routineId && run.triggerSource === "schedule")?.scheduledFor : undefined);
        return { ...schedule, at: limitResetOccurrence(this.options.limitResetAt?.(schedule.engine) ?? null, last) };
    }
    get isTicking() { return this.ticking; }
    tickInBackground() { this.tick().catch((error) => console.error("routines: a scheduler pass failed", error)); }
    start() {
        if (this.closing || this.timer)
            return;
        if (!this.startupRunsQueued)
            this.startupRunsQueued = this.queueStartupRuns();
        this.timer = startDueTimer({ run: () => this.tick(), now: this.now, onError: (error) => console.error("routines: a scheduler pass failed", error),
            next: () => this.unreadable ? this.now() + UNREADABLE_RETRY_MS : earliest(schedulerDueOf(this.routines, this.runs, this.now(), this.bootedAt + CHECK_BOOT_HOLD_MS, (routine) => this.targetState(routine) === "missing"), this.ledger.beatDueAt(), this.watch.dueAt(this.runs, this.now())) });
    }
    stop() {
        this.timer?.stop();
        this.timer = null;
        try {
            this.progress.flush();
        }
        catch (error) {
            console.error("routines: could not save run progress", error);
        }
    }
    /** At shutdown: a run whose turn the shutdown cuts stays running on disk, for the next start to pick up once. */
    close() {
        this.closing = true;
        this.progress.atOnce();
        this.stop();
        this.ledger.close();
    }
    queueStartupRuns() {
        if (this.options.skipStartupRuns)
            return true;
        const launchId = this.options.launchId, now = this.now();
        if (launchId !== undefined && launchId === this.startupLaunchId)
            return true;
        const flagged = this.routines.filter((routine) => routine.enabled && routine.runOnStartup && routine.schedule.type !== "once" &&
            (routine.schedule.type !== "interval" || routine.schedule.endsAt === undefined || now <= routine.schedule.endsAt));
        const marked = flagged.filter((routine) => !(routine.nextRunAt != null && routine.nextRunAt <= now && now - routine.nextRunAt <= CATCH_UP_MS) &&
            !this.runs.some((run) => run.routineId === routine.id && ["queued", "running", "waiting"].includes(run.status)));
        if (marked.length === 0 && launchId === undefined)
            return true;
        const previousLaunchId = this.startupLaunchId, decision = startupDecision(launchId, previousLaunchId, now), runs = [], allocations = [];
        try {
            this.commitMutation(() => {
                if (decision.run && decision.marker !== undefined)
                    this.startupLaunchId = decision.marker;
                for (const routine of marked) {
                    const startup = () => Object.assign(this.newRun(routine, now, false, allocations), { triggerSource: "startup" });
                    if (!decision.run) {
                        runs.push(recordSkip(this.runs, startup, { behind: decision.behind(routine.id), why: "routines.server.part.restartedSoon" }, now, now).row);
                        continue;
                    }
                    runs.push(startup());
                    if (routine.nextRunAt != null && routine.nextRunAt <= now)
                        this.advancePastOccurrence(routine, now, routine.nextRunAt);
                }
            }, () => {
                this.startupLaunchId = previousLaunchId;
                this.discardResultsThreads(allocations);
            });
        }
        catch (error) {
            console.error("routines: could not queue startup runs", error);
            return false;
        }
        for (const routine of marked)
            this.emitRoutine(routine);
        for (const run of runs)
            this.emitRun(run);
        return true;
    }
    async tick() {
        if (this.closing || this.ticking)
            return;
        this.ticking = true;
        try {
            const now = this.now();
            this.gate.sweep((id) => this.runs.some((run) => run.id === id && run.status === "queued"));
            if (this.unreadable) {
                const read = readRoutineFile(this.file, now);
                if (read.state === "unreadable" || this.options.restartsToReload?.() === true)
                    return;
                this.load(read);
                this.startupRunsQueued = this.queueStartupRuns();
                this.options.onReadable?.();
                for (const routine of this.routines)
                    this.emitRoutine(routine);
            }
            for (const threadId of this.slowStops.sweep())
                interruptRunTurns(this.runs.filter((run) => run.threadId === threadId).slice(-1), this.options);
            this.ledger.beat();
            for (const run of this.watch.lost(this.runs, now))
                this.settleFailure(run, ROUTINE_TURN_GONE, {});
            for (const run of this.runs) {
                const over = runOverLimit(run, this.clock, now);
                if (over)
                    await this.stopRun(Object.assign(run, over.codes), over.text, "limit-reached");
            }
            const isDue = (routine) => !this.closing && routine.enabled && this.targetState(routine) !== "missing" && (!routine.checks
                ? routine.nextRunAt != null && routine.nextRunAt <= now
                : now >= this.bootedAt + CHECK_BOOT_HOLD_MS && [routine.nextRunAt, routine.wakeAt].some((at) => at != null && at <= now));
            // An unanswered wait gives way to its routine's next occurrence, which would otherwise be skipped behind it.
            for (const routine of this.routines.filter(isDue)) {
                if (routine.checks || runsOnce(routine.schedule) || now - routine.nextRunAt > CATCH_UP_MS)
                    continue;
                const stale = this.runs.filter((run) => run.routineId === routine.id && supersededBy(routine.nextRunAt, run, this.options.handedOffWorkLive));
                for (const run of stale)
                    await this.cancelRun(run.id, ROUTINE_SUPERSEDED);
            }
            const dueRoutines = this.routines.filter(isDue);
            const scheduledRuns = [], countedSkips = [];
            let lateStarts = 0;
            const allocations = [];
            const checks = [];
            if (dueRoutines.length > 0) {
                this.commitMutation(() => {
                    for (const routine of dueRoutines) {
                        // A routine with checks never misses: however late, one check reads everything since the last.
                        if (routine.checks) {
                            if (!this.checking.has(routine.id))
                                checks.push({ id: routine.id, hold: checkHold(this.runs, routine.id, now) });
                            if (routine.nextRunAt != null && routine.nextRunAt <= now)
                                this.advancePastOccurrence(routine, now, routine.nextRunAt);
                            delete routine.wakeAt;
                            continue;
                        }
                        const plan = planOccurrence(routine, now, this.options.home?.cloud === true, this.passedAt >= routine.nextRunAt), scheduledFor = plan.scheduledFor;
                        if (this.ledger.decided(routine.id, scheduledFor)) {
                            this.advancePastOccurrence(routine, now, plan.through);
                            continue;
                        }
                        const once = runsOnce(routine.schedule), blocker = once ? undefined : blockingRun(this.runs, routine.id), spaced = once ? null : runSpacing(routine, this.runs);
                        const scheduledQueued = this.runs.some(run => run.routineId === routine.id && run.status === "queued" &&
                            (run.triggerSource ?? (run.manual ? "manual" : "schedule")) === "schedule");
                        const capped = routine.target !== "room-goal" && this.options.pausedText?.(routine.botId) ? null : this.options.capSkip?.(routine.botId, routine.id);
                        const skipFor = capped ?? (blocker && !(routine.overlap === "queue" && !scheduledQueued) ? { behind: blocker.run.id, why: blocker.why, waitingSince: blocker.waitingSince }
                            : spaced && spaced.until > now ? { behind: spaced.behind, why: spaced.why } : undefined);
                        if (!skipFor) {
                            if (plan.older)
                                countedSkips.push(Object.assign(this.newRun(routine, plan.older.scheduledFor, false, allocations), plan.older.fields));
                            scheduledRuns.push(Object.assign(this.newRun(routine, scheduledFor, false, allocations), plan.fields, plan.late ? staggered(now, lateStarts++) : {}));
                        }
                        else {
                            const skip = recordSkip(this.runs, () => this.newRun(routine, plan.through, false, allocations), skipFor, plan.through, now, plan.count > 1 ? { count: plan.count - 1, scheduledFor: plan.first } : undefined);
                            (skip.tell ? scheduledRuns : countedSkips).push(skip.row);
                            if (!capped) {
                                routine.skippedRuns = Math.min(Number.MAX_SAFE_INTEGER, (routine.skippedRuns ?? 0) + plan.count);
                                routine.lastSkippedAt = plan.through;
                            }
                            else if (once) {
                                if (routine.schedule.type === "once")
                                    routine.schedule = { type: "once", at: capped.resetsAt };
                                routine.nextRunAt = capped.resetsAt;
                                continue;
                            } // a capped once-only run is not used up: it runs when the cap resets
                        }
                        this.advancePastOccurrence(routine, now, plan.through);
                    }
                }, () => this.discardResultsThreads(allocations));
            }
            // Publish only after the scheduler batch is durable: reporting may persist transcript cards.
            for (const routine of dueRoutines)
                this.emitRoutine(routine);
            for (const run of scheduledRuns)
                this.emitRun(run);
            // A counted skip the owner is not told about changes its row only: no card, no notice.
            for (const run of countedSkips)
                this.options.emit?.({ kind: "routine.run", run: cloneRun(run) });
            for (const run of scheduledRuns) {
                if (run.status === "missed")
                    this.options.onRunFailed?.(cloneRun(run));
            }
            for (const { id, hold } of checks)
                this.runChecks(id, hold).catch((error) => console.error(`routines: the checks of ${id} failed`, error));
            // Oldest first, by id: a rollback across awaits can replace the run objects, and the array with them.
            let indexed = null, byId = new Map();
            for (const id of this.runs.map((run) => run.id)) {
                if (this.closing)
                    return;
                if (indexed !== this.runs)
                    [indexed, byId] = [this.runs, new Map(this.runs.map((run) => [run.id, run]))];
                const run = byId.get(id);
                if (!run || run.status !== "queued" || (run.retryAt ?? 0) > now)
                    continue;
                const triggerSource = run.triggerSource ?? (run.manual ? "manual" : "schedule");
                const definition = triggerSource === "schedule"
                    ? this.routines.find((routine) => routine.id === run.routineId)
                    : undefined;
                if (definition?.schedule.type === "interval") {
                    const latest = latestIntervalOccurrence(definition.schedule, now);
                    if (latest !== null && latest > run.scheduledFor) {
                        run.scheduledFor = latest;
                        this.saveLater();
                        this.emitRun(run);
                    }
                    const requiresCurrentDayOccurrence = definition.schedule.weekdays !== undefined || definition.schedule.window !== undefined;
                    const mayDispatch = intervalAllowsOccurrence(definition.schedule, now) &&
                        (!requiresCurrentDayOccurrence || (latest !== null && isSameLocalDay(latest, now)));
                    if (!mayDispatch) {
                        if (nextOccurrence(definition.schedule, now) === null) {
                            this.failRun(run, "The routine ended before this scheduled run could start", "missed");
                        }
                        continue;
                    }
                }
                const checked = triggerSource === "webhook" || run.checkKey ? undefined : this.routines.find((routine) => routine.id === run.routineId && routine.checks);
                if (checked) {
                    this.runChecks(checked.id, checkHold(this.runs, checked.id, now, run.id), run.id).catch((error) => console.error(`routines: the checks of ${checked.id} failed`, error));
                    continue;
                }
                const sameRoutineWorking = (triggerSource === "schedule" || run.sameConversation) && this.runs.some(other => other.id !== run.id && other.routineId === run.routineId && ["running", "waiting"].includes(other.status));
                const held = sameRoutineWorking || this.runs.some((other) => other.routineId === run.routineId && this.slowStops.holds(other.threadId));
                const state = held ? "busy" : this.targetState(run);
                if (state === "busy") {
                    if (run.deferredAt == null) {
                        run.deferredAt = now;
                        this.saveLater();
                        this.emitRun(run);
                    }
                    if (run.deferredNoticeAt == null && !run.checkKey && now - run.deferredAt >= ROUTINE_DEFERRAL_NOTICE_MS) {
                        run.deferredNoticeAt = now;
                        this.saveLater();
                        this.emitRun(run);
                        this.options.onRunDeferred?.(cloneRun(run));
                    }
                    const busy = busyWait(run, this.clock, triggerSource === "schedule" && !held && run.checkKey === undefined, now);
                    if (busy.missed)
                        this.failRun(Object.assign(run, busy.missed.codes), busy.missed.text, "missed");
                    else if (busy.changed)
                        this.saveLater();
                    continue;
                }
                if (state === "missing") {
                    this.failRun(run, this.missingTargetMessage(run.target));
                    continue;
                }
                const paused = run.target === "room-goal" ? null : this.options.pausedText?.(run.botId);
                if (!this.ledger.ready(run))
                    continue;
                if (this.ledger.startedElsewhere(run)) {
                    const line = codedLine("error", "routines.server.duplicate");
                    Object.assign(run, line.codes);
                    void this.cancelRun(run.id, line.text);
                    continue;
                }
                if (paused) {
                    if (triggerSource !== "manual" && this.options.held?.(run.botId))
                        void this.cancelRun(run.id, paused);
                    else
                        this.failRun(run, paused);
                    continue;
                }
                const startedBy = run.byPerson ? "manual" : triggerSource, capped = this.options.capText?.(run.botId, startedBy);
                if (capped) {
                    if (startedBy === "manual")
                        this.failRun(run, capped);
                    else
                        void this.cancelRun(run.id, capped);
                    continue;
                }
                const gated = triggerSource === "manual" ? false : this.gate.hold(run);
                if (gated === true) {
                    if (this.options.preparing && run.attention !== this.options.preparing) {
                        run.attention = this.options.preparing;
                        this.emitRun(run);
                    }
                    continue;
                }
                if (gated) {
                    this.failRun(run, gated);
                    continue;
                }
                const startedAt = this.now();
                const suffix = ` · ${new Date(startedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
                const title = `${run.routineName.slice(0, 80 - suffix.length).trimEnd()}${suffix}`;
                const joined = run.threadId || (run.target === "room-goal" ? null : this.options.joinConversation?.(run)) || null;
                const task = joined
                    ? { threadId: joined }
                    : run.target === "room-goal"
                        ? run.groupId
                            ? this.options.createGoalTask?.(run.groupId, title) ?? null
                            : this.options.createTask(run.botId, title, run)
                        : this.options.createTask(run.botId, title, run);
                if (!task) {
                    this.failRun(run, run.target === "room-goal"
                        ? "Could not create a room task for this goal"
                        : "Could not create a task for this run");
                    continue;
                }
                Object.assign(run, { threadId: task.threadId, startedAt, status: "running" });
                this.clock.from(run, "workedMs", startedAt);
                delete run.workedMs;
                this.clock.stop(run, "busyMs", true);
                try {
                    this.save();
                }
                catch (error) {
                    Object.assign(run, { status: "queued", startedAt: undefined });
                    throw error;
                }
                this.emitRun(run);
                try {
                    const prompt = run.prompt ?? this.routines.find((r) => r.id === run.routineId)?.prompt;
                    if (!prompt) {
                        this.failThread(task.threadId, "The routine was deleted before it could start", { cause: "refused" });
                        continue;
                    }
                    const triggerSource = run.triggerSource ?? (run.manual ? "manual" : "schedule");
                    if (run.target === "room-goal") {
                        if (!this.options.startGoal) {
                            this.failThread(task.threadId, "Room goal routines are unavailable");
                            continue;
                        }
                        await this.options.startGoal(run.groupId, task.threadId, prompt, run.botId, run.id, (message) => this.failThread(task.threadId, message, { cause: "refused" }));
                    }
                    else {
                        await this.options.startTurn(run.botId, task.threadId, startPrompt(run, prompt, composeExecutionPrompt({ id: run.routineId, name: run.routineName, trigger: triggerSource, runOn: run.runOn ?? "maus" }, prompt, run.attachments, continuityCarry(run, this.routines, this.runs)), (first) => this.options.promptSaid?.(task.threadId, first) === true), run.runOn ?? "maus", triggerSource, (message) => this.failThread(task.threadId, message, { cause: "refused" }));
                    }
                }
                catch (error) {
                    this.failThread(task.threadId, error instanceof Error ? error.message : String(error), dispatchRefusal(error));
                }
            }
        }
        finally {
            this.ticking = false;
            this.passedAt = this.now();
        }
    }
    /** Runs a routine's checks: what needs the AI becomes one run, or fills `manual`, the queued run the person started.
     * Nothing new leaves no run behind a scheduled check, and a quiet completed one behind a manual check. */
    async runChecks(routineId, hold, manual) {
        const hook = this.options.checks, key = manual ?? routineId, routine = this.routines.find((candidate) => candidate.id === routineId);
        if (this.closing || !hook || !routine || this.checking.has(key))
            return;
        const revision = routine.updatedAt;
        this.checking.add(key);
        let result;
        try {
            result = await hook.check(cloneRoutine(routine), { manual: manual !== undefined, ...(hold ? { hold } : {}) });
        }
        catch (error) {
            console.error(`routines: the checks of ${routineId} failed`, error);
            result = { trouble: routineLine("routines.server.checksFailed"), troubleCode: "routines.server.checksFailed" };
        }
        finally {
            this.checking.delete(key);
        }
        const current = this.routines.find((candidate) => candidate.id === routineId);
        const queued = manual === undefined ? undefined : this.runs.find((run) => run.id === manual && run.status === "queued");
        if (this.closing || !current?.checks || (manual === undefined ? !current.enabled : !queued)) {
            if (result.run)
                hook.release(result.run.key);
            return;
        }
        if (current.updatedAt !== revision) {
            if (result.run)
                hook.release(result.run.key);
            return this.runChecks(routineId, hold, manual);
        }
        const allocations = [];
        let run;
        try {
            this.commitMutation(() => {
                applyCheckResult(current, result, this.now());
                if (result.run) {
                    run = queued ?? this.newRun(current, this.now(), false, allocations);
                    if (queued)
                        Object.assign(run, routineRunDefinition(current), {
                            timeoutMinutes: current.timeoutMinutes,
                            resultsThreadId: resolveRoutineResultsThread(current, this.options.resolveResultsThread, allocations, this.now(), run.sourceThreadId),
                        });
                    if (run.timeoutMinutes === undefined)
                        delete run.timeoutMinutes;
                    Object.assign(run, { prompt: result.run.prompt, checkKey: result.run.key });
                }
                else if (queued && !result.trouble) {
                    Object.assign(queued, { status: "completed", output: routineLine("routines.server.nothingNew"), outputCode: "routines.server.nothingNew", report: { state: "quiet" }, finishedAt: this.now() });
                }
            }, () => this.discardResultsThreads(allocations));
        }
        catch (error) {
            if (result.run)
                hook.release(result.run.key);
            return console.error(`routines: could not save the checks of ${routineId}`, error);
        }
        this.emitRoutine(current);
        if (queued && !result.run && result.trouble)
            this.failRun(queued, result.trouble);
        else if (run ?? queued)
            this.emitRun((run ?? queued));
        if (run)
            queueMicrotask(() => this.tickInBackground());
    }
    handleRuntimeEvent(event) {
        const run = this.runs.find((r) => r.threadId === event.threadId && ["running", "waiting"].includes(r.status));
        if (event.type === "turn.completed")
            this.slowStops.confirmed(event.threadId);
        this.watch.seen(event.threadId);
        if (!run || (run.target === "bot" && run.status === "waiting" && !run.asked && this.options.routineTurn?.(event.threadId) === false))
            return null;
        if (event.type === "turn.started" || event.type === "turn.completed")
            settleAsk(run, undefined, this.now());
        // A room goal's orchestrator owns its result (finishGoalRun); a member's completion is intermediate.
        if (run.target === "room-goal" &&
            (run.goalStatus === "needs-input" || run.goalStatus === "paused" ||
                event.type === "turn.completed" || (event.type === "item.completed" && event.itemType === "assistant_text")))
            return null;
        if (event.type === "turn.started") {
            this.clock.work(run, this.now());
        }
        else if (event.type === "request.opened") {
            run.asked ??= askOf(event, this.now());
            this.wait(run, waitingFor(run.asked));
        }
        else if (event.type === "request.resolved") {
            const unanswered = settleAsk(run, event, this.now());
            if (unanswered) {
                void this.stopRun(run, unanswered, "stopped");
                return cloneRun(run);
            }
            this.clock.work(run, this.now());
        }
        else if (event.type === "item.completed" && event.itemType === "assistant_text") {
            run.output = clipRunOutput(redactSecretsInText(event.text).trim(), 2_000);
        }
        else if (event.type === "runtime.error") {
            Object.assign(run, runLineFields("error", event.message, event.text));
            this.failureFacts.set(run.id, engineFacts(event));
        }
        else if (event.type === "turn.completed") {
            if (this.closing && (!event.ok || event.stopReason === "cancelled" || event.stopReason === "interrupted"))
                return null;
            if (event.cost != null)
                run.cost = (run.cost ?? 0) + event.cost;
            if (event.denials?.length)
                run.denials = [...new Set([...(run.denials ?? []), ...event.denials])];
            if (!event.ok) {
                this.settleFailure(run, routineFailure(run.error, event.stopReason), { ...this.failureFacts.get(run.id), stopReason: event.stopReason });
                return cloneRun(run);
            }
            this.failureFacts.delete(run.id);
            const waitsOnTeammates = this.options.hasPendingDelegations?.(event.threadId) === true, handoffRefused = waitsOnTeammates ? null : this.options.refusedHandoff?.(event.threadId);
            if (handoffRefused) {
                this.failRun(Object.assign(run, { partial: Boolean(run.output) || undefined }), handoffRefused);
                queueMicrotask(() => this.tickInBackground());
                return cloneRun(run);
            }
            if (waitsOnTeammates)
                this.wait(run, ROUTINE_HANDOFF_WAIT);
            else {
                Object.assign(run, { status: "completed", attention: undefined, finishedAt: this.now() });
                this.ownerNotices = this.ownerNotices.filter((notice) => notice.botId !== run.botId);
            }
            run.error = undefined;
        }
        else {
            return null;
        }
        if (event.type === "turn.completed")
            this.saveLater();
        else
            this.progress.soon();
        this.emitRun(run);
        if (event.type === "turn.completed")
            queueMicrotask(() => this.tickInBackground());
        return cloneRun(run);
    }
    /** A completed run whose answer its consumer could not use: it fails like any run, so its items go back. */
    rejectResult(id, why) {
        const run = this.runs.find((candidate) => candidate.id === id && candidate.status === "completed");
        if (run)
            this.failRun(run, why);
    }
    failThread(threadId, message, facts = {}) {
        const run = this.runs.find((r) => r.threadId === threadId && ["running", "waiting"].includes(r.status));
        if (run)
            this.settleFailure(run, message, facts);
    }
    settleFailure(run, failure, facts) {
        this.failureFacts.delete(run.id);
        if (this.closing)
            return;
        const held = facts.limit !== undefined || facts.limitResetsAt !== undefined ? facts.limit ?? "engine" : facts.stopReason === "auth_required" ? "signed-out" : undefined, backupReady = held !== undefined && this.options.limitBackup?.(run.botId, held) === true;
        const recovery = recoverRun(run, failure, { ...facts, ...(backupReady ? { backupReady } : {}), nextScheduled: nextScheduledRun(run, this.routines) }, this.now(), this.ownerNotices);
        if (!recovery.queued)
            this.failRun(Object.assign(run, { partial: (facts.partial && Boolean(run.output)) || undefined }), recovery.error, "failed", recovery.alert);
        else {
            this.saveLater();
            this.emitRun(run);
            if (recovery.alert)
                this.options.onRunDeferred?.(cloneRun(run), recovery.alert);
        }
        queueMicrotask(() => this.tickInBackground());
    }
    finishGoalRun(runId, status, detail) {
        const run = this.runs.find((candidate) => candidate.id === runId &&
            candidate.target === "room-goal" &&
            ["running", "waiting"].includes(candidate.status));
        if (!run || status === "working")
            return null;
        const safeDetail = redactSecretsInText(detail).trim();
        run.goalStatus = status;
        if (status === "failed" || status === "blocked" || status === "limit-reached") {
            this.failRun(run, safeDetail ||
                (status === "limit-reached" ? "The room goal reached its turn limit" : "The room goal is blocked"));
        }
        else if (status === "needs-input" || status === "paused") {
            this.wait(run, safeDetail.slice(0, 500) || (status === "paused" ? "The room goal is paused" : "The team needs your input"));
            run.error = undefined;
            this.saveLater();
            this.emitRun(run);
        }
        else {
            run.status = status === "stopped" ? "cancelled" : "completed";
            run.attention = undefined;
            run.finishedAt = this.now();
            run.error = undefined;
            if (status !== "stopped")
                run.output = safeDetail.slice(0, 2_000) || undefined;
            this.saveLater();
            this.emitRun(run);
        }
        queueMicrotask(() => this.tickInBackground());
        return cloneRun(run);
    }
    /** Timed from when it began, so a later occurrence can tell a wait that went unanswered. */
    wait(run, attention) {
        if (run.status !== "waiting" || run.waitingSince === undefined)
            run.waitingSince = this.now();
        this.clock.rest(run, this.now());
        Object.assign(run, { status: "waiting", attention });
    }
    async stopRun(run, detail, status) {
        if (run.target === "room-goal")
            run.goalStatus = status;
        this.failRun(run, detail);
        if (!run.threadId)
            return;
        if (run.target === "room-goal")
            await this.options.interruptGoal?.(run.groupId, run.threadId, { status, detail }).catch(() => { });
        else
            await this.options.interruptTurn?.(run.botId, run.threadId).catch(() => { });
    }
    failRun(run, message, status = "failed", alert) {
        Object.assign(run, { status, attention: undefined, error: redactSecretsInText(message).slice(0, 500), finishedAt: this.now() });
        const routine = this.routines.find((candidate) => candidate.id === run.routineId), spaced = status === "failed" ? noStartAlert(routine, this.runs, run) ?? failureSpacingAlert(routine, this.runs, run) : undefined;
        this.saveLater();
        this.emitRun(run);
        const repeat = failsLikeLastOutcome(this.runs, run) || (run.checkKey !== undefined && outcomesNewestFirst(this.runs, run.routineId, run.id)[0]?.status === "failed");
        this.options.onRunFailed?.(cloneRun(run), spaced ?? (alert === undefined && repeat ? null : alert));
    }
    advancePastOccurrence(routine, now, occurrence) {
        if (routine.schedule.type === "limit_reset" && routine.schedule.repeat === "every_reset")
            routine.schedule = this.timedSchedule(routine.schedule, routine.id, occurrence);
        routine.nextRunAt =
            runsOnce(routine.schedule) ? null : nextOccurrence(routine.schedule, Math.max(now, occurrence));
        // Not a definition edit: bumping updatedAt here would stale a pending confirmation card.
        if (runsOnce(routine.schedule)) {
            routine.enabled = false;
            routine.updatedAt = Math.max(now, routine.updatedAt + 1);
        }
        else if (routine.schedule.type === "interval" && routine.nextRunAt === null) {
            routine.enabled = false;
            routine.updatedAt = Math.max(now, routine.updatedAt + 1);
        }
    }
    targetState(target) {
        if (target.target === "room-goal") {
            if (!this.options.goalState)
                return "missing";
            return this.options.goalState(target.groupId, target.botId);
        }
        return this.options.botState(target.botId);
    }
    missingTargetMessage(target) {
        return target === "room-goal"
            ? "The assigned room or coordinator no longer exists"
            : "The assigned bot no longer exists";
    }
    initialOccurrence(schedule, now) {
        // The original time, not max(at, now): tick() decides fire vs missed from it.
        if (schedule.type === "once" || schedule.type === "limit_reset")
            return schedule.at;
        return nextOccurrence(schedule, now);
    }
    newRun(routine, scheduledFor, manual, allocations, sourceThreadId = routine.sourceThreadId) {
        const resultsThreadId = resolveRoutineResultsThread(routine, this.options.resolveResultsThread, allocations, this.now(), sourceThreadId);
        const run = {
            id: randomUUID(),
            routineId: routine.id,
            ...routineRunDefinition(routine),
            scheduledFor,
            status: "queued",
            manual,
            triggerSource: manual ? "manual" : "schedule",
            sourceThreadId,
            resultsThreadId,
            createdAt: this.now(),
        };
        this.runs.push(run);
        return run;
    }
    discardResultsThreads(allocations) {
        for (const { botId, threadId } of allocations) {
            try {
                this.options.discardResultsThread?.(botId, threadId);
            }
            catch (error) {
                console.error("routine: could not discard uncommitted results thread", error);
            }
        }
    }
    applyResultsInput(routine, value) {
        if (routine.target !== "bot") {
            if (value != null)
                throw Object.assign(new Error("Results threads are only available for bot routines"), { status: 400 });
            delete routine.resultsThreadId;
            return;
        }
        if (value === undefined)
            return;
        if (value === null) {
            const destination = this.options.resolveResultsThread?.(routine, true);
            if (!destination || destination.main) {
                delete routine.resultsThreadId;
                return;
            }
            routine.resultsThreadId = destination.threadId;
            return () => this.options.discardResultsThread?.(routine.botId, destination.threadId);
        }
        if (typeof value !== "string" || !value.trim() || !this.options.isResultsThread?.(routine.botId, value.trim())) {
            throw Object.assign(new Error("Choose a visible results thread belonging to this bot"), { status: 400 });
        }
        routine.resultsThreadId = value.trim();
    }
    emitRoutine(routine) {
        this.timer?.poke();
        this.options.emit?.({ kind: "routine", routine: this.routineWithHealth(routine) });
    }
    emitRun(run) {
        this.timer?.poke();
        this.options.emit?.({ kind: "routine.run", run: cloneRun(run) });
        this.notifyRunChanged(run);
        if (run.checkKey && !["queued", "running", "waiting"].includes(run.status))
            this.options.checks?.settled(cloneRun(run));
        if (run.status === "completed" || run.status === "failed") {
            const routine = this.routines.find(candidate => candidate.id === run.routineId);
            if (routine)
                this.emitRoutine(routine);
        }
    }
    notifyRunChanged(run) {
        try {
            this.options.onRunChanged?.(cloneRun(run));
        }
        catch (error) {
            console.error("routine: source-thread lifecycle update failed", error);
        }
    }
    matchingRoutineRequestReceipt(request) { return matchingRequestReceipt(this.routineRequestReceipts, request); }
    rememberRoutineRequest(request, resultId, appliedAt) { rememberRequest(this.routineRequestReceipts, request, resultId, appliedAt); }
    /** The row of a run whose stop did not finish in time says so, until the stop is confirmed. */
    stopChanged(threadId, state) {
        const run = this.runs.findLast((candidate) => candidate.threadId === threadId);
        if (run && markStop(run, state)) {
            this.saveLater();
            this.timer?.poke();
            this.options.emit?.({ kind: "routine.run", run: cloneRun(run) });
        }
    }
    assertWritable() {
        if (this.unreadable)
            throw Object.assign(new Error("Saved routines could not be read. Repair routines.json before changing them."), { status: 503 });
    }
    /** Rolls memory back when the write fails, so a retry never mistakes an uncommitted action for a durable one. */
    commitMutation(mutate, rollback) {
        const before = {
            routines: this.routines.map(cloneRoutine),
            runs: this.runs.map(cloneRun),
            receipts: this.routineRequestReceipts.map((receipt) => ({ ...receipt })),
        };
        try {
            mutate();
            this.save();
        }
        catch (error) {
            this.routines = before.routines;
            this.runs = before.runs;
            this.routineRequestReceipts = before.receipts;
            try {
                rollback?.();
            }
            catch (cleanupError) {
                console.error("routine: could not discard uncommitted results thread", cleanupError);
            }
            throw error;
        }
    }
    /** Lands at the end of the running save batch (server/save-batch.ts); what a caller rolls back on failure uses save. */ saveLater() { saveSoon(this, () => this.save()); }
    save() {
        if (this.unreadable) {
            this.progress.written();
            return;
        }
        evictRuns(this.runs, MAX_RUNS);
        const recordOccurrences = this.ledger.observe(this.routines, this.runs);
        mkdirSync(dirname(this.file), { recursive: true });
        this.disk.write(JSON.stringify({
            version: 1,
            ...(this.frozenPending ? {} : { frozenResultsCleared: true }),
            routines: [...this.routines, ...this.unloadedRoutines],
            runs: this.runs,
            routineRequestReceipts: this.routineRequestReceipts,
            webhookRunReceipts: this.webhookRunReceipts,
            ...(this.startupLaunchId === undefined ? {} : { startupLaunchId: this.startupLaunchId }), ...(this.noStartOffsChecked ? { noStartOffsChecked: true } : {}),
            ...(this.ownerNotices.length ? { ownerNotices: this.ownerNotices } : {}),
            ...(this.holds.length ? { holds: this.holds } : {}),
        }));
        this.progress.written();
        recordOccurrences();
    }
}
