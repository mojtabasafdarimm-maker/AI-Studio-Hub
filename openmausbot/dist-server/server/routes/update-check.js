import { serverVersion } from "../environment.js";
import { SERVER_ROOT } from "../proxy-paths.js";
import { createServerUpdater, SERVER_UPDATE_DIR, SERVER_UPDATE_DIR_ENV } from "../server-update.js";
import { createUpdateChecker, installKind, updateChannel } from "../update-check.js";
import { PASS } from "./table.js";
/** SECURITY: a person's admin session, never loopback: on a server, loopback is a bot's shell or a process beside it. This
 * guards the button only. The request file it leaves is in a folder of the server's user, so until the bots' sandbox is
 * on for self-hosted servers anything running as that user, a bot included, can leave it too; what that can cause is
 * only the standard update (server/server-update.ts). */
export function mayUpdateServer(auth) {
    return auth.kind === "session" && auth.scopes.includes("admin");
}
export function createUpdateCheckRoutes(deps) {
    return async ({ req, res, path, method, json, auth }) => {
        if (path === "/api/updates/server" && deps.server && (method === "GET" || method === "POST")) {
            if (!mayUpdateServer(auth))
                return json(res, 403, { error: "Only an admin of this server, signed in, can update it.", code: "admin_only" });
            if (method === "GET")
                return json(res, 200, await deps.server.status());
            const done = await deps.server.request(deps.actor?.(auth, req) ?? { kind: "loopback" });
            return json(res, done.status, done.body);
        }
        if (path !== "/api/updates/check" || method !== "GET")
            return PASS;
        try {
            return json(res, 200, await deps.check());
        }
        catch (error) {
            return json(res, 502, { error: `Could not check for updates: ${error instanceof Error ? error.message : String(error)}` });
        }
    };
}
export function serverUpdateChecker(where) {
    return createUpdateChecker({ current: serverVersion(), install: installKind({ ...where, serverRoot: SERVER_ROOT }), channel: updateChannel() });
}
/** Both routes' parts for this server: one shared check, and the button where the install has one. */
export function updateRouteDeps(where) {
    const install = installKind({ ...where, serverRoot: SERVER_ROOT });
    const channel = updateChannel();
    const check = createUpdateChecker({ current: serverVersion(), install, channel });
    const dir = process.env[SERVER_UPDATE_DIR_ENV]?.trim() || (install === "docker" ? SERVER_UPDATE_DIR : undefined);
    const server = createServerUpdater({ dir, dataDir: where.dataDir, install, version: serverVersion(), check, activeTurns: where.activeTurns, followsStable: channel === "stable" });
    return { check, server, actor: where.actor };
}
