// GET  /api/connectors/suggestions[?botId=&for=&limit=]  what to offer connecting next; never asks a model
// POST /api/connectors/suggestions/pick                  the person asked: the decision model orders them, once per change
// POST /api/internal/connectors/find { query }           a bot's search of the catalog, for COMPOSIO_MANAGE_CONNECTIONS
import { SUGGESTED_SECTION_SIZE } from "../../shared/app-suggestions.js";
import { PASS } from "./table.js";
const MAX_LIMIT = 20;
const MAX_QUERY = 200;
export function createAppSuggestionRoutes(host) {
    return async ({ res, url, path, method, json }) => {
        if (method === "GET" && path === "/api/connectors/suggestions") {
            const limit = Number(url.searchParams.get("limit"));
            const botId = url.searchParams.get("botId") ?? undefined, about = url.searchParams.get("for")?.trim().toLowerCase() || undefined;
            return json(res, 200, await host.suggest({ limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : SUGGESTED_SECTION_SIZE, ...(botId ? { botId } : {}), ...(about ? { about } : {}) }));
        }
        if (method === "POST" && path === "/api/connectors/suggestions/pick")
            return json(res, 200, await host.pick(SUGGESTED_SECTION_SIZE));
        return PASS;
    };
}
export function createAppFindRoute(deps) {
    return async ({ res, path, method, json }) => {
        if (method !== "POST" || path !== "/api/internal/connectors/find")
            return PASS;
        const body = await deps.readBody();
        const query = typeof body?.query === "string" ? body.query.trim().slice(0, MAX_QUERY) : "";
        if (!query)
            return json(res, 400, { error: "find must say what the app is for." });
        const bot = deps.bot(deps.botId);
        if (!bot)
            return json(res, 409, { error: "connected apps are not enabled for this bot" });
        return json(res, 200, { text: await deps.host.find({ query, bot, refusal: deps.refusal }) });
    };
}
