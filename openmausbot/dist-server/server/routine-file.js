// routines.json as it is read at start, and again while it cannot be read. A file that is there but unreadable is never
// taken for an empty one: the caller refuses every save while it stays so, a copy is set aside the first time each
// unreadable content is seen, and the read is tried again until it works.
import { readFileSync } from "node:fs";
import { attachmentsMalformed } from "./routine-attachments.js";
import { loadEventReceipts } from "./routine-event-receipts.js";
import { holdCauses } from "./routine-holds.js";
import { loadRequestReceipts, loadRoutine, loadRun } from "./routine-load.js";
import { loadOwnerNotices } from "./routine-recovery.js";
/** While routines.json cannot be read, the read is tried again this often. */
export const UNREADABLE_RETRY_MS = 60_000;
export function readRoutineFile(file, now) {
    try {
        const text = readFileSync(file, "utf8"), disk = JSON.parse(text);
        if (disk === null || typeof disk !== "object" || Array.isArray(disk))
            throw new Error("Invalid routines file");
        for (const key of ["routines", "runs", "routineRequestReceipts", "webhookRunReceipts"]) {
            if (key in disk && !Array.isArray(disk[key]))
                throw new Error(`Invalid routines file: ${key} is not a list`);
        }
        const saved = (disk.routines ?? []), unloadedRoutines = [];
        const routines = saved.flatMap((routine) => {
            const loaded = loadRoutine(routine, now);
            if (loaded)
                return [loaded];
            console.warn(`routines: keeping ${String(routine.id)} on disk unscheduled; its schedule could not load`);
            unloadedRoutines.push(routine);
            return [];
        });
        const runs = (disk.runs ?? []).map(loadRun);
        return {
            state: "ok", text, routines, unloadedRoutines, runs,
            malformedAttachments: attachmentsMalformed([...saved, ...(disk.runs ?? [])]),
            routineRequestReceipts: loadRequestReceipts(disk.routineRequestReceipts),
            webhookRunReceipts: loadEventReceipts(disk.webhookRunReceipts, runs, now),
            frozenPending: disk.frozenResultsCleared !== true,
            ownerNotices: loadOwnerNotices(disk.ownerNotices),
            holds: holdCauses(disk.holds),
            startupLaunchId: typeof disk.startupLaunchId === "string" ? disk.startupLaunchId : undefined,
            noStartOffsChecked: disk.noStartOffsChecked === true,
        };
    }
    catch (error) {
        if (error.code === "ENOENT")
            return { state: "missing" };
        return { state: "unreadable", reason: error instanceof SyntaxError ? "invalid JSON" : error instanceof Error ? error.message : "unable to read routines" };
    }
}
export { keepUnreadableAside } from "./unreadable-aside.js";
