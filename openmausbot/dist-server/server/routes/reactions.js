import { normalizeReaction, REACTIONS } from "../../shared/reactions.js";
import { PASS } from "./table.js";
export function createReactionRoutes(deps) {
    return async ({ req, res, path, method, auth, json, readBody }) => {
        const m = path.match(/^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/reactions$/);
        if (!m || method !== "POST")
            return PASS;
        const body = await readBody(req);
        const emoji = normalizeReaction(body?.emoji);
        if (!emoji)
            return json(res, 400, { error: `emoji must be one of ${REACTIONS.join(" ")}` });
        if (body.on !== undefined && typeof body.on !== "boolean")
            return json(res, 400, { error: "on must be true or false" });
        const notYours = deps.cloudGuestSendRefusal(auth, m[1]);
        if (notYours)
            return json(res, 403, { error: notYours });
        try {
            return json(res, 200, await deps.react({ auth, threadId: m[1], messageId: m[2], emoji, reactor: deps.reactorFor(auth), on: body.on }));
        }
        catch (error) {
            const { status, code } = error;
            if (typeof status !== "number")
                throw error;
            return json(res, status, { error: error instanceof Error ? error.message : String(error), ...(typeof code === "string" ? { code } : {}) });
        }
    };
}
