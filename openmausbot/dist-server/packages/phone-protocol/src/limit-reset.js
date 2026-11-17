/** Wire shapes for automations that run when an engine's usage limit resets, and for the engines' limit state
 * the Automations page, the chat and the calendar show. */
/** How long after a reset the run starts, so the provider has rolled its window over. */
export const AFTER_RESET_MS = 60_000;
/** From this share of a window used, an engine is shown as near its limit. */
export const NEAR_LIMIT_PERCENT = 90;
export function isLimitResetSchedule(schedule) {
    return schedule?.type === "limit_reset";
}
/** A one-time automation: a fixed time, or the next reset only. */
export function runsOnce(schedule) {
    return schedule.type === "once" || (schedule.type === "limit_reset" && schedule.repeat !== "every_reset");
}
export function nearLimit(limit) {
    return limit.blocked || (limit.usedPercent ?? 0) >= NEAR_LIMIT_PERCENT;
}
