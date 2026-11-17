import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { DATA_DIR } from "./config.js";
const FILE = join(DATA_DIR, "box-delete-requests.json");
const LOCK_FILE = join(DATA_DIR, "box-delete-requests.lock");
const MAX_RECORDS = 4_096;
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 20;
const MAX_REAPER_GENERATIONS = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOT_ID = /^[A-Za-z0-9_-]{1,120}$/;
const BOAT_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const OPERATION_ID = /^bdop_[a-f0-9]{32}$/;
const PROVIDER_STATUSES = new Set(["pending", "processing", "blocked", "completed"]);
/** Codes of a create refused while the bot's previous computer is being removed, or right after its removal finished. */
export const BOAT_DELETING = "computer_deleting", BOAT_DELETION_FINISHED = "previous_deletion_finished";
const lockWait = new Int32Array(new SharedArrayBuffer(4));
function validTimestamp(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function validName(value) {
    return typeof value === "string"
        && value.length > 0
        && value.length <= 100
        && !/[\r\n\0]/.test(value);
}
function isRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const record = value;
    if (typeof record.boxId !== "string"
        || !BOAT_ID.test(record.boxId)
        || !validName(record.name)
        || !(record.ownerBotId === null || (typeof record.ownerBotId === "string" && BOT_ID.test(record.ownerBotId)))
        || !["prepared", "accepted", "blocked"].includes(record.phase)
        || !validTimestamp(record.requestedAt)
        || !validTimestamp(record.updatedAt)
        || record.updatedAt < record.requestedAt
        || !(record.operationId === undefined || (typeof record.operationId === "string" && OPERATION_ID.test(record.operationId)))
        || !(record.status === undefined || (typeof record.status === "string" && PROVIDER_STATUSES.has(record.status))))
        return false;
    if (record.phase === "prepared")
        return record.operationId === undefined && record.status === undefined;
    if (record.phase === "accepted") {
        return typeof record.operationId === "string"
            && (record.status === "pending" || record.status === "processing" || record.status === "completed");
    }
    return record.status === "blocked";
}
function stateError(detail, cause) {
    return Object.assign(new Error(`Cloud computer deletion is paused because its recovery state is ${detail}. `
        + "Check the Boat provider before repairing OpenMausBot's local state."), { status: 503, cause });
}
function clone(record) {
    return { ...record };
}
function nextUpdatedAt(record) {
    return Math.max(Date.now(), record.updatedAt);
}
function loadFresh() {
    let raw;
    try {
        raw = JSON.parse(readFileSync(FILE, "utf8"));
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return [];
        throw stateError("unreadable", error);
    }
    const journal = raw;
    if (!journal
        || typeof journal !== "object"
        || Array.isArray(journal)
        || journal.version !== 1
        || !Array.isArray(journal.records)
        || journal.records.length > MAX_RECORDS
        || !journal.records.every(isRecord))
        throw stateError("invalid");
    const boatIds = new Set();
    const operationIds = new Set();
    for (const record of journal.records) {
        if (boatIds.has(record.boxId))
            throw stateError("invalid");
        boatIds.add(record.boxId);
        if (record.operationId) {
            if (operationIds.has(record.operationId))
                throw stateError("invalid");
            operationIds.add(record.operationId);
        }
    }
    return journal.records.map(clone);
}
function save(records) {
    try {
        mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
        writeFileAtomic(FILE, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, { mode: 0o600 });
    }
    catch (error) {
        throw stateError("unavailable", error);
    }
}
function isLockOwner(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const owner = value;
    return owner.version === 1
        && Number.isInteger(owner.pid)
        && Number(owner.pid) > 0
        && Number(owner.pid) <= 0x7fffffff
        && typeof owner.token === "string"
        && UUID.test(owner.token)
        && validTimestamp(owner.createdAt);
}
function readLockOwner() {
    let raw;
    try {
        raw = readFileSync(LOCK_FILE, "utf8");
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return null;
        throw stateError("lock is unreadable", error);
    }
    try {
        const owner = JSON.parse(raw);
        if (!isLockOwner(owner))
            throw stateError("lock is invalid");
        return owner;
    }
    catch (error) {
        if (error.status === 503)
            throw error;
        throw stateError("lock is invalid", error);
    }
}
function processIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        const code = error?.code;
        if (code === "ESRCH")
            return false;
        if (code === "EPERM")
            return true;
        throw stateError("lock owner could not be verified", error);
    }
}
function unlinkCandidate(path) {
    try {
        unlinkSync(path);
    }
    catch (error) {
        if (error?.code !== "ENOENT") {
            throw stateError("lock cleanup failed", error);
        }
    }
}
function readReaperOwner(path, targetToken) {
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return null;
        throw stateError("stale-lock recovery record is unreadable", error);
    }
    if (/^[1-9][0-9]*\n?$/.test(raw)) {
        const pid = Number(raw.trim());
        if (Number.isInteger(pid) && pid <= 0x7fffffff)
            return { legacy: true, pid };
    }
    try {
        const owner = JSON.parse(raw);
        if (!isLockOwner(owner) || !("targetToken" in owner) || owner.targetToken !== targetToken) {
            throw stateError("stale-lock recovery record is invalid");
        }
        return owner;
    }
    catch (error) {
        if (error.status === 503)
            throw error;
        throw stateError("stale-lock recovery record is invalid", error);
    }
}
function publishReaper(path, owner) {
    const candidate = `${path}.candidate-${owner.pid}-${owner.token}`;
    try {
        writeFileSync(candidate, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600, flush: true });
    }
    catch (error) {
        throw stateError("stale-lock recovery candidate is unavailable", error);
    }
    try {
        try {
            linkSync(candidate, path);
            return true;
        }
        catch (error) {
            if (error?.code === "EEXIST")
                return false;
            throw stateError("stale-lock recovery is unavailable", error);
        }
    }
    finally {
        unlinkCandidate(candidate);
    }
}
function successorReaperPath(targetToken, identity) {
    const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32);
    return `${LOCK_FILE}.reap-${targetToken}-${digest}`;
}
function claimReaperAuthority(expected) {
    let reaperPath = `${LOCK_FILE}.reap-${expected.token}`;
    for (let generation = 0; generation < MAX_REAPER_GENERATIONS; generation += 1) {
        const candidate = {
            version: 1,
            pid: process.pid,
            token: randomUUID(),
            createdAt: Date.now(),
            targetToken: expected.token,
        };
        if (publishReaper(reaperPath, candidate))
            return true;
        const current = readReaperOwner(reaperPath, expected.token);
        if (!current)
            continue;
        if (processIsAlive(current.pid))
            return false;
        const identity = "legacy" in current ? `legacy:${current.pid}` : current.token;
        reaperPath = successorReaperPath(expected.token, identity);
    }
    throw stateError("stale lock could not be recovered after repeated interrupted attempts");
}
function reapDeadLock(expected) {
    if (!claimReaperAuthority(expected))
        return false;
    const current = readLockOwner();
    if (!current || current.token !== expected.token)
        return true;
    if (processIsAlive(current.pid))
        return false;
    try {
        unlinkSync(LOCK_FILE);
    }
    catch (error) {
        if (error?.code !== "ENOENT") {
            throw stateError("stale lock could not be retired", error);
        }
    }
    return true;
}
function acquireJournalLock() {
    try {
        mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    }
    catch (error) {
        throw stateError("lock directory is unavailable", error);
    }
    const owner = {
        version: 1,
        pid: process.pid,
        token: randomUUID(),
        createdAt: Date.now(),
    };
    const candidate = `${LOCK_FILE}.candidate-${owner.pid}-${owner.token}`;
    try {
        writeFileSync(candidate, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600, flush: true });
    }
    catch (error) {
        throw stateError("lock candidate is unavailable", error);
    }
    const deadline = performance.now() + LOCK_WAIT_MS;
    try {
        for (;;) {
            try {
                linkSync(candidate, LOCK_FILE);
                return owner;
            }
            catch (error) {
                if (error?.code !== "EEXIST") {
                    throw stateError("lock could not be acquired", error);
                }
            }
            const current = readLockOwner();
            const reaped = current !== null && !processIsAlive(current.pid) && reapDeadLock(current);
            if (performance.now() >= deadline)
                throw stateError("locked by another OpenMausBot process");
            if (reaped)
                continue;
            Atomics.wait(lockWait, 0, 0, LOCK_RETRY_MS);
        }
    }
    finally {
        unlinkCandidate(candidate);
    }
}
function releaseJournalLock(owner) {
    const current = readLockOwner();
    if (!current || current.token !== owner.token || current.pid !== owner.pid) {
        throw stateError("lock ownership changed unexpectedly");
    }
    try {
        unlinkSync(LOCK_FILE);
    }
    catch (error) {
        throw stateError("lock could not be released", error);
    }
}
function withJournalLock(operation) {
    const owner = acquireJournalLock();
    try {
        return operation(loadFresh());
    }
    finally {
        releaseJournalLock(owner);
    }
}
function validateIdentity(identity) {
    if (!BOAT_ID.test(identity.boxId))
        throw new Error("invalid cloud computer id for deletion");
    if (!validName(identity.name))
        throw new Error("invalid cloud computer name for deletion");
    if (!(identity.ownerBotId === null || BOT_ID.test(identity.ownerBotId))) {
        throw new Error("invalid cloud computer owner for deletion");
    }
}
function parseOperation(boxId, value, expectedStatus) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("invalid cloud computer deletion operation");
    }
    const operation = value;
    if (typeof operation.id !== "string"
        || !OPERATION_ID.test(operation.id)
        || operation.kind !== "sandbox"
        || operation.targetId !== boxId
        || typeof operation.status !== "string"
        || !PROVIDER_STATUSES.has(operation.status)
        || (expectedStatus !== undefined && operation.status !== expectedStatus))
        throw new Error("invalid or mismatched cloud computer deletion operation");
    return operation;
}
/** The immutable target is written before DELETE is sent; in-flight work wins, and a blocked operation may be retried explicitly. */
export function prepareBoatDeletion(identity) {
    validateIdentity(identity);
    return withJournalLock((records) => {
        const existing = records.find((record) => record.boxId === identity.boxId);
        if (existing) {
            if (existing.name !== identity.name || existing.ownerBotId !== identity.ownerBotId) {
                throw stateError("conflicted with the remembered deletion target");
            }
            if (existing.phase !== "blocked")
                return clone(existing);
        }
        if (!existing && records.length >= MAX_RECORDS)
            throw stateError("full");
        const now = Date.now();
        const prepared = {
            ...identity,
            phase: "prepared",
            requestedAt: now,
            updatedAt: now,
        };
        save([...records.filter((record) => record.boxId !== identity.boxId), prepared]);
        return clone(prepared);
    });
}
/** Binds a provider receipt to this exact target, so another Boat's operation can never attach to the fence. */
export function markBoatDeletionAccepted(boxId, value) {
    if (!BOAT_ID.test(boxId))
        throw new Error("invalid cloud computer id for deletion");
    const operation = parseOperation(boxId, value);
    if (operation.status === "blocked") {
        throw new Error("blocked cloud computer deletion must use markBoatDeletionBlocked");
    }
    const acceptedStatus = operation.status;
    return withJournalLock((records) => {
        const existing = records.find((record) => record.boxId === boxId);
        if (!existing || existing.phase === "blocked")
            throw stateError("out of date");
        if (existing.operationId && existing.operationId !== operation.id) {
            throw stateError("conflicted with another deletion operation");
        }
        if (records.some((record) => record.boxId !== boxId && record.operationId === operation.id)) {
            throw stateError("conflicted with another deletion operation");
        }
        const ranks = {
            pending: 0,
            processing: 1,
            completed: 2,
        };
        if (existing.phase === "accepted"
            && existing.status !== undefined
            && existing.status !== "blocked"
            && ranks[acceptedStatus] < ranks[existing.status])
            return clone(existing);
        const accepted = {
            ...existing,
            phase: "accepted",
            operationId: operation.id,
            status: acceptedStatus,
            updatedAt: nextUpdatedAt(existing),
        };
        save(records.map((record) => record.boxId === boxId ? accepted : record));
        return clone(accepted);
    });
}
/** The target stays fenced; only a deliberate deletion retry may prepare it again. */
export function markBoatDeletionBlocked(boxId, value) {
    if (!BOAT_ID.test(boxId))
        throw new Error("invalid cloud computer id for deletion");
    const operation = value === undefined ? null : parseOperation(boxId, value, "blocked");
    return withJournalLock((records) => {
        const existing = records.find((record) => record.boxId === boxId);
        if (!existing)
            throw stateError("out of date");
        if (operation && existing.operationId && existing.operationId !== operation.id) {
            throw stateError("conflicted with another deletion operation");
        }
        if (operation
            && records.some((record) => record.boxId !== boxId && record.operationId === operation.id))
            throw stateError("conflicted with another deletion operation");
        const blocked = {
            ...existing,
            phase: "blocked",
            ...(operation?.id || existing.operationId ? { operationId: operation?.id ?? existing.operationId } : {}),
            status: "blocked",
            updatedAt: nextUpdatedAt(existing),
        };
        save(records.map((record) => record.boxId === boxId ? blocked : record));
        return clone(blocked);
    });
}
export function boatDeletionSnapshot() {
    return withJournalLock((records) => records.map(clone));
}
export function getBoatDeletion(boxId) {
    if (!BOAT_ID.test(boxId))
        throw new Error("invalid cloud computer id for deletion");
    return withJournalLock((records) => {
        const record = records.find((candidate) => candidate.boxId === boxId);
        return record ? clone(record) : null;
    });
}
export function hasPendingBoatDeletionForBot(botId) {
    if (!BOT_ID.test(botId))
        throw new Error("invalid bot id for cloud computer deletion");
    return withJournalLock((records) => records.some((record) => record.ownerBotId === botId));
}
/** Only after a direct absence or a completed target-bound operation proves the Boat is gone. */
export function retireBoatDeletion(boxId) {
    if (!BOAT_ID.test(boxId))
        throw new Error("invalid deleted cloud computer id");
    withJournalLock((records) => {
        const next = records.filter((record) => record.boxId !== boxId);
        if (next.length !== records.length)
            save(next);
    });
}
