import { announcementRoutes } from "./announcements.js";
import { cloudSyncRoutes } from "./cloud-sync.js";
import { ownMcpHttpRoutes } from "./own-mcp-http.js";
import { webPanelRoutes } from "./web-panels.js";
export const PASS = Symbol("route.pass");
/** Modules with no wiring from index.ts are listed here; index.ts pushes the rest. */
export const ROUTES = [cloudSyncRoutes, ownMcpHttpRoutes, webPanelRoutes, announcementRoutes];
/** True means stop routing. A handler that wrote a response but returned PASS still counts as answered. */
export async function dispatchRoutes(routes, ctx) {
    for (const route of routes) {
        const out = await route(ctx);
        if (out !== PASS || ctx.res.headersSent || ctx.res.writableEnded)
            return true;
    }
    return false;
}
