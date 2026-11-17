import { userError } from "../user-errors.js";
import { PASS } from "./table.js";
/** GET /api/inbox: this viewer's inbox as its panel lists it. GET /api/inbox/count: how many of its lines wait on them. POST /api/inbox/read-all: all of its lines read, and POST /api/inbox/<line>/read and /done: one of its
 * lines read, or news they need nothing more from; each answers with the inbox as it lists them now. */
export function createInboxRoutes(deps) {
    return async ({ res, path, method, auth, json }) => {
        if (path === "/api/inbox") {
            if (method !== "GET")
                return json(res, 405, { error: "method not allowed" });
            const view = deps.view(auth);
            return view ? json(res, 200, view) : json(res, 404, { ...userError("serverError.inbox.missing") });
        }
        if (path === "/api/inbox/count") {
            if (method !== "GET")
                return json(res, 405, { error: "method not allowed" });
            const count = deps.count(auth);
            return count === null ? json(res, 404, { error: "There is no inbox here." }) : json(res, 200, { count });
        }
        if (path === "/api/inbox/read-all") {
            if (method !== "POST")
                return json(res, 405, { error: "method not allowed" });
            if (deps.markAllRead(auth) === null)
                return json(res, 404, { ...userError("serverError.inbox.missing") });
            const view = deps.view(auth);
            return view ? json(res, 200, view) : json(res, 404, { ...userError("serverError.inbox.missing") });
        }
        const m = /^\/api\/inbox\/([\w-]+)\/(read|done)$/.exec(path);
        if (!m)
            return PASS;
        if (method !== "POST")
            return json(res, 405, { error: "method not allowed" });
        const marked = m[2] === "read" ? (deps.markRead(auth, m[1]) ? "done" : "unknown") : deps.markDone(auth, m[1]);
        if (marked === "unknown")
            return json(res, 404, { ...userError("serverError.inbox.lineMissing") });
        if (marked === "an ask")
            return json(res, 409, { ...userError("serverError.inbox.answerRequired") });
        const view = deps.view(auth);
        return view ? json(res, 200, view) : json(res, 404, { ...userError("serverError.inbox.missing") });
    };
}
