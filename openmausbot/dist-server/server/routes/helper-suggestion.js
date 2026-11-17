import { userError } from "../user-errors.js";
import { PASS } from "./table.js";
const ID = /^[\w-]{1,128}$/;
export function createHelperSuggestionRoutes(deps) {
    return async ({ req, res, path, method, auth, json, readBody }) => {
        if (path !== "/api/helpers/suggestion/not-now" || method !== "POST")
            return PASS;
        const body = await readBody(req, 2048);
        const threadId = typeof body?.threadId === "string" ? body.threadId : "";
        const messageId = typeof body?.messageId === "string" ? body.messageId : "";
        if (!ID.test(threadId) || !ID.test(messageId))
            return json(res, 400, { error: "threadId and messageId are required" });
        const outcome = deps.notNow(threadId, messageId, auth);
        if (outcome === "refused")
            return json(res, 403, userError("serverError.helper.ownerOnly"));
        if (outcome === "unknown")
            return json(res, 404, userError("serverError.helper.missing"));
        return json(res, 200, { ok: true });
    };
}
