/** Starter and Personal share one machine size (2 GB, shared CPU), so past a few turns at once it slows until nothing answers. */
const SMALL_PLAN = { parallel: 2, maxTasks: 10, smallPlan: true };
const MAX_TASKS = 200;
export const BURST_PLAN_LIMITS = {
    starter: SMALL_PLAN,
    personal: SMALL_PLAN,
    pro: { parallel: 10, maxTasks: MAX_TASKS, smallPlan: false },
    max: { parallel: 25, maxTasks: MAX_TASKS, smallPlan: false },
    team: { parallel: 25, maxTasks: MAX_TASKS, smallPlan: false },
    business: { parallel: 25, maxTasks: MAX_TASKS, smallPlan: false },
    enterprise: { parallel: 25, maxTasks: MAX_TASKS, smallPlan: false },
};
/** Open-source installs (desktop, self-hosted) run on their own compute, with no plan. `config.json` `burst.maxParallel` changes it. */
export const OPEN_SOURCE_PARALLEL = 10;
export function burstLimits(host) {
    if (!host.cloudHome)
        return { parallel: host.maxParallel ?? OPEN_SOURCE_PARALLEL, maxTasks: MAX_TASKS, smallPlan: false };
    // A tier this build doesn't know, or none yet, gets the smallest row: the machine may be small, and a burst only queues longer.
    return (host.tier !== undefined && Object.hasOwn(BURST_PLAN_LIMITS, host.tier) ? BURST_PLAN_LIMITS[host.tier] : undefined) ?? SMALL_PLAN;
}
