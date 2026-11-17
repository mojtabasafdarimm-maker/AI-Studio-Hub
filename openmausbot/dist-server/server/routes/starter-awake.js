import { PASS } from "./table.js";
export const STARTER_AWAKE_PATH = "/api/starter/awake";
export function createStarterAwakeRoutes({ awake }) {
    return async ({ req, res, method, path, json, readBody }) => {
        if (path !== STARTER_AWAKE_PATH)
            return PASS;
        if (method !== "POST")
            return json(res, 405, { error: "Use POST." });
        const body = await readBody(req);
        const ids = body?.awake;
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
            return json(res, 400, { error: "awake must be a list of bot ids" });
        const chosen = awake.choose(ids);
        if (!chosen.ok)
            return json(res, 400, { error: chosen.error });
        return json(res, 200, { paused: awake.paused() });
    };
}
