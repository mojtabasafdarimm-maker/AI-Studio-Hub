export const TERMINAL = ["completed", "failed", "cancelled"];
export const DEFAULT_LIMITS = {
    depth: 4,
    requests: 24,
    executions: 48,
    wakes: 48,
    totalExecutions: 300,
    failedInARow: 5,
    queueMs: 24 * 60 * 60_000,
    stallMs: 4 * 60 * 60_000,
    turnStallMs: 20 * 60_000,
    inputWaitMs: Number.POSITIVE_INFINITY,
    inputRemindMs: Number.POSITIVE_INFINITY,
};
export const terminal = (status) => TERMINAL.includes(status);
