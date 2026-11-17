import { PASS } from "./table.js";
export function createSkillShareRoutes(deps) {
    return async ({ req, res, path, method, auth, json, readBody }) => {
        if (method !== "POST")
            return PASS;
        let m = path.match(/^\/api\/threads\/([\w-]+)\/share-skill$/);
        if (m) {
            if (!deps.enabled())
                return json(res, 404, { error: "sharing learned skills is not enabled" });
            const body = await readBody(req);
            const requestId = typeof body?.requestId === "string" ? body.requestId : "";
            if (!requestId)
                return json(res, 400, { error: "requestId is required" });
            const refusal = deps.cardRefusal(auth, m[1], requestId);
            if (refusal)
                return json(res, 403, { error: refusal });
            const result = deps.shareFromReceipt(m[1], requestId);
            if (!result.ok)
                return json(res, result.status, { error: result.error });
            return json(res, 200, { ok: true, shared: result.shared });
        }
        m = path.match(/^\/api\/bots\/([\w-]+)\/skills\/([a-z0-9-]+)\/share$/);
        if (m) {
            if (!deps.enabled())
                return json(res, 404, { error: "sharing learned skills is not enabled" });
            if (!deps.botExists(m[1]))
                return json(res, 404, { error: "no such bot" });
            const shared = deps.shareFromBot(m[1], m[2]);
            if ("error" in shared)
                return json(res, 422, { error: shared.error });
            return json(res, 200, { ok: true, shared });
        }
        return PASS;
    };
}
