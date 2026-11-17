import { routineVisible } from "../bot-visibility.js";
import { needsYouNow, todayReport } from "../today.js";
import { PASS } from "./table.js";
/** GET /api/today?since=<epoch ms>: `since` is the viewer's local midnight, or the start of a longer window.
 * GET /api/needs-you: only what needs this person now. */
export function createTodayRoutes(deps) {
    const viewerFor = (auth) => {
        const visible = deps.visibleFor(auth);
        const asks = deps.asks;
        return {
            admin: auth.scopes.includes("admin"),
            thread: (threadId) => visible.thread(threadId),
            routine: (run) => routineVisible(run, visible),
            ...(asks ? { asks: (botId, threadId) => asks(auth, botId, threadId) } : {}),
        };
    };
    return async ({ res, path, method, url, auth, json }) => {
        if (path === "/api/needs-you") {
            if (method !== "GET")
                return json(res, 405, { error: "method not allowed" });
            return json(res, 200, { items: [...needsYouNow(deps.sources(), viewerFor(auth), deps.now?.() ?? Date.now()), ...(deps.messages?.(auth) ?? [])] });
        }
        if (path !== "/api/today")
            return PASS;
        if (method !== "GET")
            return json(res, 405, { error: "method not allowed" });
        const since = Number(url.searchParams.get("since") ?? Number.NaN);
        if (!Number.isFinite(since))
            return json(res, 400, { error: "since must be a time in milliseconds" });
        const report = todayReport(deps.sources(), viewerFor(auth), since, deps.now?.() ?? Date.now());
        return json(res, 200, { ...report, needsYou: [...report.needsYou, ...(deps.messages?.(auth) ?? [])] });
    };
}
