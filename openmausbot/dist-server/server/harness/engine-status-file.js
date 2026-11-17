import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomicIfChanged } from "../atomic.js";
const text = (value) => typeof value === "string";
const flag = (value) => typeof value === "boolean";
function strings(value, keys) {
    if (!value || typeof value !== "object")
        return undefined;
    const record = value;
    return keys.every((key) => text(record[key])) ? Object.fromEntries(keys.map((key) => [key, record[key]])) : undefined;
}
function account(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const { email, organization, method } = value;
    return {
        ...(text(email) ? { email } : {}),
        ...(text(organization) ? { organization } : {}),
        ...(method === "login" || method === "api-key" ? { method } : {}),
    };
}
export function snapshotFrom(value) {
    if (!value || typeof value !== "object")
        return null;
    const raw = value;
    if (raw.state !== "available" && raw.state !== "unavailable")
        return null;
    const update = strings(raw.update, ["title", "message", "command"]);
    const skipServerInstall = raw.update?.serverInstall === false;
    const warning = strings(raw.warning, ["title", "message"]);
    const signedInAs = account(raw.account);
    return {
        state: raw.state,
        ...(text(raw.reason) ? { reason: raw.reason } : {}),
        ...(flag(raw.authenticated) ? { authenticated: raw.authenticated } : {}),
        ...(flag(raw.chatgptPlan) ? { chatgptPlan: raw.chatgptPlan } : {}),
        // Until the start-up read reaches it, OpenCode on its free models alone still ranks and reads as the backup it is.
        ...(flag(raw.freeFallback) ? { freeFallback: raw.freeFallback } : {}),
        ...(text(raw.authenticationUnavailableReason) ? { authenticationUnavailableReason: raw.authenticationUnavailableReason } : {}),
        ...(signedInAs ? { account: signedInAs } : {}),
        ...(text(raw.version) || raw.version === null ? { version: raw.version } : {}),
        ...(update ? { update: { ...update, ...(skipServerInstall ? { serverInstall: false } : {}) } } : {}),
        ...(raw.billing === "metered" || raw.billing === "subscription" ? { billing: raw.billing } : {}),
        ...(warning ? { warning } : {}),
    };
}
/** At most one write a second, of the latest rows: the start-up read lands a probe at a time, and on Windows each
 * rename onto a file a scanner holds is retried for up to ~155 ms. */
export const STATUS_SAVE_DELAY_MS = 1_000;
const unsaved = new Set();
let exitHooked = false;
/** Writes what every file's delay still holds. A clean exit runs it, so a stopped Cloud's next wake starts from the
 * latest status; a hard kill (SIGKILL, kill() on Windows) loses at most that second, until the next read corrects it. */
export function flushEngineStatusFiles() {
    for (const write of unsaved)
        write();
}
/** Account display identity only, never credentials; kept beside the engines' other local state under providers/. */
export function engineStatusFile(file) {
    let saved;
    let pending;
    let timer;
    const write = () => {
        unsaved.delete(write);
        if (timer)
            clearTimeout(timer);
        timer = undefined;
        const body = pending;
        pending = undefined;
        if (body === undefined || body === saved)
            return;
        try {
            mkdirSync(dirname(file), { recursive: true });
            writeFileAtomicIfChanged(file, body, { mode: 0o600, durable: false });
            saved = body;
        }
        catch {
        }
    };
    return {
        /** The statuses the last run recorded, for the engines still configured with the same driver and CLI. */
        read(target) {
            const seeds = new Map();
            let rows;
            try {
                rows = JSON.parse(readFileSync(file, "utf8")).engines;
            }
            catch {
                return seeds;
            }
            if (!Array.isArray(rows))
                return seeds;
            for (const row of rows) {
                if (!row || !text(row.instanceId))
                    continue;
                const now = target(row.instanceId);
                const snapshot = snapshotFrom(row.snapshot);
                if (snapshot && now && now.driverKind === row.driverKind && now.cli === (row.cli ?? null))
                    seeds.set(row.instanceId, snapshot);
            }
            return seeds;
        },
        save(rows) {
            pending = JSON.stringify({ v: 1, engines: rows });
            if (pending === saved) {
                pending = undefined;
                return;
            }
            if (!timer) {
                timer = setTimeout(write, STATUS_SAVE_DELAY_MS);
                timer.unref?.();
                unsaved.add(write);
                if (!exitHooked) {
                    exitHooked = true;
                    process.once("exit", flushEngineStatusFiles);
                }
            }
        },
    };
}
