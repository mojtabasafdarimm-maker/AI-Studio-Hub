import { createAppHostingInternalRoutes } from "./app-hosting.js";
import { createEngineLimitsRoutes } from "./engine-limits.js";
import { createHelperToolRoutes } from "./helper-tools.js";
import { createMausBotNotificationRoutes } from "./mausbot-notifications.js";
import { PASS } from "./table.js";
import { createXResearchInternalRoutes } from "./x-research.js";
export function createInternalToolRoutes(deps) {
    const routes = [createXResearchInternalRoutes(deps.xResearch), createHelperToolRoutes(deps.helpers), createMausBotNotificationRoutes(deps.notifications), createEngineLimitsRoutes(deps.engineLimits), createAppHostingInternalRoutes(deps.appPublisher)];
    return async (ctx) => {
        for (const route of routes)
            if (await route(ctx) !== PASS)
                return;
        return PASS;
    };
}
