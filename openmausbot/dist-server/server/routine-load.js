// Routines and runs as routines.json holds them, read back into the shapes RoutineManager works with: anything a hand
// edit or an older version left out of range is dropped, never trusted.
import { z } from "zod";
import { ROUTINE_CHECKS } from "../shared/routines.js";
import { isEffortLevel } from "../shared/wire.js";
import { isModelVariant } from "./contracts.js";
import { ROUTINE_PARTS } from "./package-parts.js";
import { loadAttachments, loadTimeoutMinutes } from "./routine-attachments.js";
import { isRoutineHoldCause } from "./routine-holds.js";
import { MAX_DATE_MS } from "./routine-intervals.js";
import { loadSchedule } from "./routine-schedules.js";
import { loadSkips } from "./routine-skips.js";
const persistedSourceThreadId = z.string().trim().min(1).optional().catch(undefined);
const HASH = /^[a-f0-9]{64}$/;
export function loadInstalledPackage(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const stamp = value;
    if (typeof stamp.installId !== "string" || !/^[a-f0-9]{32}$/.test(stamp.installId) || typeof stamp.key !== "string" || !stamp.key || stamp.key.length > 80)
        return undefined;
    const parts = stamp.parts;
    if (!parts || typeof parts !== "object" || !ROUTINE_PARTS.every((part) => HASH.test(String(parts[part]?.r)) && HASH.test(String(parts[part]?.w))))
        return undefined;
    return {
        installId: stamp.installId,
        key: stamp.key,
        parts: Object.fromEntries(ROUTINE_PARTS.map((part) => [part, { r: parts[part].r, w: parts[part].w }])),
    };
}
function loadTarget(value) {
    return value === "room-goal" ? "room-goal" : "bot";
}
const ROUTINE_GOAL_STATUSES = new Set([
    "completed",
    "needs-input",
    "blocked",
    "limit-reached",
    "paused",
    "stopped",
    "failed",
]);
function loadGoalStatus(value, target) {
    return target === "room-goal" && typeof value === "string" && ROUTINE_GOAL_STATUSES.has(value)
        ? value
        : undefined;
}
function loadGroupId(value, target) {
    if (target !== "room-goal" || typeof value !== "string")
        return undefined;
    return value.trim() || undefined;
}
/** Known checks, each once, in their own order; undefined when none. */
export function loadChecks(value) {
    if (!Array.isArray(value))
        return undefined;
    const checks = ROUTINE_CHECKS.filter((check) => value.includes(check));
    return checks.length ? checks : undefined;
}
/** A routine's checks, access and delivery as it may hold them; a field out of range is left out. */
export function withCheckFields(routine) {
    const clean = { ...routine, checks: routine.target === "bot" ? loadChecks(routine.checks) : undefined,
        access: routine.access === "read-and-draft" ? "read-and-draft" : undefined,
        deliver: routine.target === "bot" && routine.deliver === "brief" ? "brief" : undefined };
    return withoutUndefined(clean, ["checks", "access", "deliver"]);
}
const instant = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE_MS ? value : undefined;
function withoutUndefined(record, keys) {
    for (const key of keys)
        if (record[key] === undefined)
            delete record[key];
    return record;
}
/** Null when its schedule cannot load: the caller keeps it on disk, unscheduled. */
export function loadModelSelection(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const { instanceId, model, effort, variant } = value;
    if (typeof instanceId !== "string" || !instanceId.trim() || typeof model !== "string" || !model.trim())
        return undefined;
    if (effort !== undefined && (!isEffortLevel(effort) || variant !== undefined))
        return undefined;
    if (variant !== undefined && !isModelVariant(variant))
        return undefined;
    return { instanceId: instanceId.trim(), model: model.trim(), ...(effort === undefined ? {} : { effort }), ...(variant === undefined ? {} : { variant }) };
}
export function loadRoutine(routine, now) {
    const schedule = loadSchedule(routine.schedule, now);
    if (!schedule)
        return null;
    const target = loadTarget(routine.target);
    const loaded = {
        ...routine,
        schedule,
        target,
        groupId: loadGroupId(routine.groupId, target),
        runOn: routine.runOn ?? "maus",
        timeoutMinutes: loadTimeoutMinutes(routine.timeoutMinutes),
        attachments: loadAttachments(routine.attachments),
        sourceThreadId: persistedSourceThreadId.parse(routine.sourceThreadId),
        resultsThreadId: persistedSourceThreadId.parse(routine.resultsThreadId),
        overlap: routine.overlap === "queue" ? "queue" : undefined,
        runOnStartup: routine.runOnStartup === true ? true : undefined,
        modelSelection: routine.target === "room-goal" ? undefined : loadModelSelection(routine.modelSelection),
        skippedRuns: Number.isSafeInteger(routine.skippedRuns) && routine.skippedRuns > 0 ? routine.skippedRuns : undefined,
        lastSkippedAt: Number.isSafeInteger(routine.lastSkippedAt) && routine.lastSkippedAt >= 0 && routine.lastSkippedAt <= MAX_DATE_MS ? routine.lastSkippedAt : undefined,
        installedPackage: loadInstalledPackage(routine.installedPackage),
        checkedAt: instant(routine.checkedAt),
        checkTrouble: typeof routine.checkTrouble === "string" && routine.checkTrouble ? routine.checkTrouble.slice(0, 300) : undefined,
        checkTroubleCode: typeof routine.checkTrouble === "string" && routine.checkTrouble && typeof routine.checkTroubleCode === "string" ? routine.checkTroubleCode.slice(0, 80) : undefined,
        wakeAt: instant(routine.wakeAt),
        heldFor: isRoutineHoldCause(routine.heldFor) ? routine.heldFor : undefined,
    };
    delete loaded.failureStreak;
    delete loaded.noStartStreak;
    return withCheckFields(withoutUndefined(loaded, ["timeoutMinutes", "runOnStartup", "modelSelection", "installedPackage", "checkedAt", "checkTrouble", "checkTroubleCode", "wakeAt", "heldFor"]));
}
export function loadRun(run) {
    const target = loadTarget(run.target);
    const loaded = {
        ...run,
        target,
        goalStatus: loadGoalStatus(run.goalStatus, target),
        groupId: loadGroupId(run.groupId, target),
        runOn: run.runOn ?? "maus",
        timeoutMinutes: loadTimeoutMinutes(run.timeoutMinutes),
        attachments: loadAttachments(run.attachments),
        sourceThreadId: persistedSourceThreadId.parse(run.sourceThreadId),
        resultsThreadId: persistedSourceThreadId.parse(run.resultsThreadId),
        access: run.access === "read-and-draft" ? "read-and-draft" : undefined,
        deliver: run.deliver === "brief" ? "brief" : undefined,
        checkKey: typeof run.checkKey === "string" && /^[\w-]{1,128}$/.test(run.checkKey) ? run.checkKey : undefined,
        busyMs: instant(run.busyMs),
        workedMs: instant(run.workedMs),
        skipped: loadSkips(run.skipped),
    };
    return withoutUndefined(loaded, ["timeoutMinutes", "access", "deliver", "checkKey", "busyMs", "workedMs", "skipped"]);
}
const REQUEST_ACTIONS = new Set(["create", "update", "pause", "resume", "run_now", "delete"]);
/** The applied routine-request receipts routines.json holds, each whole: one with a field out of shape is dropped. */
export function loadRequestReceipts(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((receipt) => typeof receipt?.requestId === "string" &&
        typeof receipt?.messageId === "string" &&
        typeof receipt?.botId === "string" &&
        typeof receipt?.threadId === "string" &&
        REQUEST_ACTIONS.has(receipt?.action) &&
        receipt?.fingerprintVersion === 1 &&
        typeof receipt?.fingerprint === "string" && /^[a-f0-9]{64}$/.test(receipt.fingerprint) &&
        typeof receipt?.resultId === "string" &&
        Number.isFinite(receipt?.appliedAt));
}
/** The receipt of a request already applied; null when there is none. One that names another card throws. */
export function matchingRequestReceipt(receipts, request) {
    const receipt = receipts.find((candidate) => candidate.requestId === request.requestId);
    if (!receipt)
        return null;
    if (receipt.action !== request.action ||
        receipt.messageId !== request.messageId ||
        receipt.botId !== request.botId ||
        receipt.threadId !== request.threadId ||
        receipt.fingerprintVersion !== request.fingerprintVersion ||
        receipt.fingerprint !== request.fingerprint) {
        throw new Error("Routine request receipt does not match this confirmation card");
    }
    return receipt;
}
/** Keeps the receipt of a request just applied, newest first; applied before with another result, it throws. */
export function rememberRequest(receipts, request, resultId, appliedAt) {
    const existing = matchingRequestReceipt(receipts, request);
    if (existing) {
        if (existing.resultId !== resultId)
            throw new Error("Routine request receipt has another result");
        return;
    }
    receipts.unshift({ ...request, resultId, appliedAt });
}
