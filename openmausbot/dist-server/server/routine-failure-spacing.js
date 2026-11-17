// A routine whose runs keep failing is never turned off for it. Each failed run spent the bot's AI, so after a few in a
// row its scheduled runs are spaced out as for a cloud computer that does not start, and every occurrence held back is
// counted on one `missed` row. The first run that completes, turning the routine on again, or any change to it ends the
// spacing, and so does a run only the owner's AI account stopped (signed out, out of credit, a usage limit). A run that
// never started work counts for nothing here.
import { envWhole } from "./env-limits.js";
import { afterSpacing, noStartSpacing } from "./routine-no-start.js";
import { outcomesNewestFirst } from "./routine-outcomes.js";
export const FAILED_RUNS_BEFORE_SPACING = 3;
export const FAILURE_FIRST_SPACING_MS = 60 * 60_000;
export const FAILURE_SPACING_MS = 4 * 60 * 60_000;
/** OMB_ROUTINE_FAILURES_BEFORE_SPACING (from 1), OMB_ROUTINE_FAILURE_SPACING_MS and OMB_ROUTINE_FAILURE_SPACING_MAX_MS
 * (whole milliseconds from 60000, the second never below the first); anything else leaves the default. */
export function failureSpacingLimits(env = process.env) {
    const firstMs = envWhole(env.OMB_ROUTINE_FAILURE_SPACING_MS, FAILURE_FIRST_SPACING_MS, 60_000);
    return { runs: envWhole(env.OMB_ROUTINE_FAILURES_BEFORE_SPACING, FAILED_RUNS_BEFORE_SPACING), firstMs,
        laterMs: Math.max(firstMs, envWhole(env.OMB_ROUTINE_FAILURE_SPACING_MAX_MS, FAILURE_SPACING_MS, 60_000)) };
}
/** The routine's newest failed runs that started work, since it last completed a run, was turned on or was changed, or
 * a run failed only on the owner's AI account (signed out, out of credit, a usage limit): that ends a streak and any
 * spacing it began, since the cause changed. */
export function failedRuns(routine, runs) {
    const outcomes = outcomesNewestFirst(runs, routine.id);
    const end = outcomes.findIndex((run) => run.status !== "failed" || run.createdAt < routine.updatedAt || run.ownerCause !== undefined);
    return (end < 0 ? outcomes : outcomes.slice(0, end)).filter((run) => run.startedAt != null);
}
/** Until when the routine's scheduled runs are held back for failing, and the failure the spacing counts from; null when they are not. */
export function failureSpacing(routine, runs, limits = failureSpacingLimits()) {
    const failed = failedRuns(routine, runs), last = failed[0];
    if (!last || failed.length < limits.runs)
        return null;
    return { until: (last.finishedAt ?? last.createdAt) + (failed.length === limits.runs ? limits.firstMs : limits.laterMs), last, streak: failed.length };
}
/** The spacing that holds the routine's scheduled runs back longest: for a cloud computer that did not start, or for failed runs. */
export function runSpacing(routine, runs, limits = failureSpacingLimits()) {
    const noStart = noStartSpacing(routine, runs), failed = failureSpacing(routine, runs, limits);
    if (noStart && (!failed || noStart.until >= failed.until))
        return { ...noStart, behind: `no-start:${noStart.last.id}`, why: "routines.server.part.computerNoStart" };
    return failed && { ...failed, behind: `failed:${failed.last.id}`, why: "routines.server.part.runsFailed" };
}
/** What the owner is told, once, by the failure that begins the spacing; nothing for a routine that is off, whose schedule starts no run to space. */
export function failureSpacingAlert(routine, runs, run, limits = failureSpacingLimits()) {
    const failed = routine && routine.enabled !== false ? failedRuns(routine, runs) : [];
    if (failed.length !== limits.runs || failed[0]?.id !== run.id)
        return undefined;
    return { detail: `${run.error} ${limits.runs} runs in a row failed. It stays on, and tries again less often until a run completes.` };
}
/** The routine as wake and sleep planning should see it: its next run is the first occurrence a spacing does not skip. */
export function afterRunSpacing(routine, runs, now, next) {
    return afterSpacing(routine, runs, now, next, runSpacing);
}
