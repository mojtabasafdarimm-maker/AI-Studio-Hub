import { PASS } from "./table.js";
export function createUndoRoutes(deps) {
    return async ({ req, res, path, method, auth, json, readBody }) => {
        const m = path.match(/^\/api\/threads\/([\w-]+)\/undo$/);
        if (!m || method !== "POST")
            return PASS;
        const threadId = m[1];
        const body = await readBody(req);
        const requestId = typeof body?.requestId === "string" ? body.requestId : "";
        if (!requestId)
            return json(res, 400, { error: "requestId is required" });
        const refusal = deps.refusal(auth, threadId, requestId);
        if (refusal)
            return json(res, 403, { error: refusal });
        await deps.undo(auth, res, threadId, requestId);
    };
}
