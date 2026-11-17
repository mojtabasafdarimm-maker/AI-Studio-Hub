import { isRoutineProblemRun } from "../shared/routines.js";
/** However old they are, each automation keeps at least this many of its newest runs in the app's window. */
export const NEWEST_RUNS_PER_AUTOMATION = 5;
const ACTIVE = new Set(["queued", "running", "waiting"]);
/** The runs the app loads at start (`GET /api/routines?since=`): those scheduled since `since`, and, whatever their age,
 * every unfinished run, every failed or missed run not yet seen, and each automation's newest runs back to its newest
 * settled run that was no problem, so its status, its run of failures and its latest runs read as with every run loaded.
 * `newestFirst` is ordered by scheduledFor, newest first. */
export function appRunWindow(newestFirst, since) {
    const reach = new Map();
    return newestFirst.filter((run) => {
        const own = reach.get(run.routineId) ?? { count: 0, settled: false };
        reach.set(run.routineId, own);
        const reached = own.count < NEWEST_RUNS_PER_AUTOMATION || !own.settled;
        own.count += 1;
        if (run.status !== "cancelled" && !ACTIVE.has(run.status) && !isRoutineProblemRun(run))
            own.settled = true;
        return reached || run.scheduledFor >= since || ACTIVE.has(run.status) || (isRoutineProblemRun(run) && !run.seenAt);
    });
}
/** `since` asks for the app's window; `from` and `to` for exactly the runs scheduled in that range; `thread` for the
 * runs that worked in one conversation; nothing, for every run. */
export function routineRunsFor(listRuns, query) {
    const time = (name) => {
        const raw = query.get(name);
        const value = raw === null ? Number.NaN : Number(raw);
        return Number.isFinite(value) ? value : undefined;
    };
    const since = time("since"), thread = query.get("thread");
    if (thread)
        return listRuns().filter((run) => run.threadId === thread);
    return since === undefined ? listRuns(time("from"), time("to")) : appRunWindow(listRuns(), since);
}
/** `history` names one routine: its scheduled occurrences from the ledger, newest first, beside the runs. Nothing for a
 * routine the asker may not see, or when no routine is named. */
export function routineHistoryFor(manager, query, visible) {
    const routine = manager.listRoutines().find((candidate) => candidate.id === query.get("history"));
    if (!routine || !visible(routine))
        return {};
    return { occurrences: manager.occurrences(routine.id).map(({ routineId: _routineId, lastStartAt: _lastStartAt, lease: _lease, ...occurrence }) => occurrence) };
}
