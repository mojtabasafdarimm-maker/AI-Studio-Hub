import { validZone } from "../host/check-plan.js";
import { PASS } from "./table.js";
const IANA_ZONE = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+)$/;
const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/i;
const THREAD_ID = /^[\w-]{1,100}$/;
/** POST /api/presence/active {source, timeZone, language, threadId}: the person opened or used the app, with that
 * conversation open. Only the owner's counts. */
export function createPresenceRoutes(deps) {
    return async ({ req, res, path, method, auth, json, readBody }) => {
        if (method !== "POST" || path !== "/api/presence/active")
            return PASS;
        const body = await readBody(req, 4096);
        const given = body && typeof body === "object" && !Array.isArray(body) ? body : {};
        const source = given.source === "phone" ? "phone" : "desktop";
        const timeZone = typeof given.timeZone === "string" && given.timeZone.length <= 128 && IANA_ZONE.test(given.timeZone) ? validZone(given.timeZone) : undefined;
        const language = typeof given.language === "string" && LANGUAGE_TAG.test(given.language) ? given.language.toLowerCase() : undefined;
        const counts = Boolean(deps.member) || deps.isOwner(auth);
        if (language && counts)
            deps.heard?.(auth, language);
        if (counts && typeof given.threadId === "string" && THREAD_ID.test(given.threadId))
            deps.sawChat?.(auth, given.threadId);
        if (deps.member)
            return json(res, 200, { ok: true, ...deps.member(auth, language) });
        // A guest's activation is not the person's: answered, never recorded.
        if (!deps.isOwner(auth))
            return json(res, 200, { ok: true, returned: false });
        return json(res, 200, { ok: true, ...(await deps.active(source, timeZone, language)) });
    };
}
