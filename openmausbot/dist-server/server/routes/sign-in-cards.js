import { PASS } from "./table.js";
const HIDDEN = { status: 404, body: { error: "no such sign-in request" } };
const CARD = /^\/api\/bots\/([\w-]+)\/sign-in-cards\/([\w-]+)\/(done|cancel|save-login|saved-logins|use-login)$/u;
export function createSignInCardRoutes(deps) {
    return async ({ req, res, url, path, method, auth, json, readBody }) => {
        const m = CARD.exec(path);
        if (!m)
            return PASS;
        if (m[3] === "save-login" && method === "GET") {
            const threadId = url.searchParams.get("threadId") ?? "";
            const result = deps.threadVisible(auth, threadId) ? await deps.saveTarget(m[1], threadId, m[2]) : HIDDEN;
            return json(res, result.status, result.body);
        }
        if (m[3] === "saved-logins" && method === "GET") {
            const threadId = url.searchParams.get("threadId") ?? "";
            res.setHeader("cache-control", "no-store");
            const result = deps.vault && deps.threadVisible(auth, threadId) ? deps.vault.list(m[1], threadId, m[2]) : { status: 200, body: { choices: [] } };
            return json(res, result.status, result.body);
        }
        if (method !== "POST" || m[3] === "saved-logins")
            return PASS;
        if (m[3] === "save-login" || m[3] === "use-login") {
            // JSON only, so a form posted from another local page cannot save one.
            const mediaType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
            if (mediaType !== "application/json")
                return json(res, 415, { error: "content-type must be application/json" });
            const body = await readBody(req, 16_384);
            const fields = body && typeof body === "object" && !Array.isArray(body) ? body : {};
            const threadId = String(fields.threadId ?? "");
            if (m[3] === "use-login") {
                const used = deps.vault && deps.threadVisible(auth, threadId) ? deps.vault.use(m[1], threadId, m[2], fields.loginId) : HIDDEN;
                return json(res, used.status, used.body);
            }
            const result = deps.threadVisible(auth, threadId) ? await deps.saveLogin(m[1], threadId, m[2], fields, auth) : HIDDEN;
            return json(res, result.status, result.body);
        }
        const body = await readBody(req);
        const threadId = String(body.threadId ?? "");
        const result = deps.threadVisible(auth, threadId) ? deps.settle(m[1], threadId, m[2], m[3] === "done" ? "done" : "cancelled") : HIDDEN;
        return json(res, result.status, result.body);
    };
}
