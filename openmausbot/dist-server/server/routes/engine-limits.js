import { engineLimitsFor } from "../engine-limits.js";
import { planAccountsFromInstances } from "../plan-usage.js";
import { PASS } from "./table.js";
const LIMITS = "/api/internal/engine-limits";
export const ENGINE_LIMITS_GUEST = "Usage limits belong to the owner of this computer's AI accounts, and this conversation was started by someone else.";
export function createEngineLimitsRoutes(deps) {
    return async (ctx) => {
        if (ctx.method !== "GET" || ctx.path !== LIMITS)
            return PASS;
        if (deps.guestDriven(ctx.threadId))
            return void ctx.json(ctx.res, 403, { error: ENGINE_LIMITS_GUEST });
        const configs = deps.configs();
        const report = await deps.load(planAccountsFromInstances(configs)).catch(() => null);
        const accounts = engineLimitsFor({ instances: deps.instances(), configs, status: deps.status, report, turn: deps.audienceOf(ctx.threadId), dataDir: deps.dataDir });
        return void ctx.json(ctx.res, 200, { text: JSON.stringify({ accounts }) });
    };
}
