export const ROUTINE_CHECKS = ["calendar", "mail", "runs"];
export const ROUTINE_HOLD_CAUSES = ["plan_cancelled", "no_engine", "no_connections"];
/** The statuses both failure indicators count: a run that went wrong and has
 * not been acknowledged. */
export const ROUTINE_PROBLEM_STATUSES = ["failed", "missed"];
/** Minutes of work a run may do when its routine sets no limit of its own: a bot's run, and a room goal's run, which
 * stays running across every member's turn. */
export const ROUTINE_RUN_LIMIT_MINUTES = 180;
export const ROUTINE_GOAL_RUN_LIMIT_MINUTES = 720;
/** The longest limit a routine may set for itself (`timeoutMinutes`), and the shortest. */
export const ROUTINE_RUN_LIMIT_MAX_MINUTES = 1_440;
export const ROUTINE_RUN_LIMIT_MIN_MINUTES = 5;
/** A run's `attention` while it waits only on work it handed to teammates: nothing is asked of the person. */
export const ROUTINE_HANDOFF_WAIT = "Waiting for work it handed on to finish";
export function isRoutineProblemRun(run) {
    return ROUTINE_PROBLEM_STATUSES.includes(run.status);
}
/** A missed row that only counts occurrences skipped while the routine was otherwise at work, or while its tries are
 * spaced out, and that the owner was not told about: it belongs in the history, and is never the routine's latest result. */
export function isCountedSkip(run) {
    return run.skipped !== undefined && run.skipped.told !== true;
}
/** On a Team Cloud, "Just me": the routine reports into the person's own private chat with the bot, theirs alone. */
export const RESULTS_JUST_ME = "just-me";
