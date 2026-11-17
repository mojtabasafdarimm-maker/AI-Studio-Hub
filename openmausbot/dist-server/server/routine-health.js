// What a Cloud home's health report says about each routine, read from the saved run rows every time: failures in a row
// counted in memory would start again from zero at each restart and hide a routine that fails every day.
import { isCountedSkip } from "../shared/routines.js";
const ENDED = new Set(["completed", "failed", "missed", "cancelled"]);
const endedAt = (run) => run.finishedAt ?? run.createdAt;
/** Each routine that is on, and each outside trigger, with a run that ended: its newest ended run, and how many runs in a
 * row before it failed or were missed since the last one that completed (a cancelled run neither counts nor ends the
 * row). A row that only counts occurrences skipped while the routine was at work is no result and is left out, as is a
 * routine that is off or deleted, which is expected to run nothing. Newest first, at most `cap`. */
export function routineHealthOf(routines, runs, cap) {
    const on = new Set(routines.filter((routine) => routine.enabled).map((routine) => routine.id));
    const ended = new Map();
    for (const run of runs) {
        if (!ENDED.has(run.status) || isCountedSkip(run) || !(on.has(run.routineId) || run.webhookId === run.routineId))
            continue;
        const rows = ended.get(run.routineId);
        if (rows)
            rows.push(run);
        else
            ended.set(run.routineId, [run]);
    }
    const health = [];
    for (const [routineId, rows] of ended) {
        rows.sort((a, b) => endedAt(b) - endedAt(a) || b.createdAt - a.createdAt);
        let consecutiveFailures = 0;
        for (const run of rows) {
            if (run.status === "completed")
                break;
            if (run.status !== "cancelled")
                consecutiveFailures += 1;
        }
        health.push({ routineId, status: rows[0].status, at: endedAt(rows[0]), consecutiveFailures });
    }
    return health.sort((a, b) => b.at - a.at).slice(0, cap);
}
