import { APP_LIMITS, ROOM_VIEW_ONLY } from "../../shared/app.js";
import { APP_RPC_METHODS } from "../../shared/app-frame/bridge.js";
import { webOrigin } from "../../shared/app-frame/csp.js";
import { appRow, createChatApps, rowRate } from "../chat-apps.js";
import { messageFileDisposition } from "../message-file.js";
import { refusalBody, userError } from "../user-errors.js";
import { PASS } from "./table.js";
export { createChatApps };
export { createChatAppsMcp } from "../chat-apps-mcp.js";
const DOCUMENT = /^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/app(\/download)?$/;
const APP_ACTION = /^\/api\/bots\/([\w-]+)\/apps\/([\w-]+)\/(rpc|context)$/;
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export function createChatAppRoutes(deps) {
    const { store, apps } = deps;
    const contextRate = rowRate(120, 60_000);
    return async ({ req, res, url, path, method, auth, json, readBody }) => {
        let m = DOCUMENT.exec(path);
        if (m && method === "GET") {
            const threadId = m[1];
            // An unknown thread answers before the store materialises it.
            if (!store.botByThread(threadId) && !store.groupByThread(threadId))
                return json(res, 404, { error: "no such conversation" });
            const visible = deps.threadVisible;
            if (visible && !visible(auth, threadId))
                return json(res, 404, { error: "no such conversation" });
            if (!appRow(store, threadId, m[2]))
                return json(res, 404, { error: "no app on that message" });
            const asked = url.searchParams.get("rev");
            if (asked !== null && !/^\d{1,6}$/.test(asked))
                return json(res, 400, { error: "rev must be a version number" });
            if (m[3]) {
                const page = apps.publishablePage(threadId, m[2], asked === null ? undefined : Number(asked));
                if (!page.ok)
                    return json(res, page.status, refusalBody(page));
                if (page.files.length > 1)
                    return json(res, 409, userError("serverError.page.downloadHasFiles"));
                const body = page.files[0].data;
                // Security: a bot's page is untrusted HTML; it leaves only as opaque bytes to save, never to render.
                res.writeHead(200, {
                    "content-type": "application/octet-stream",
                    "content-length": String(body.byteLength),
                    "content-disposition": messageFileDisposition(`${page.title || "page"}.html`),
                    "content-security-policy": "sandbox",
                    "x-content-type-options": "nosniff",
                    "cache-control": "private, no-store",
                });
                res.end(body);
                return;
            }
            // A folder page's files load from wherever this client reaches the app; it names that origin itself.
            const origin = webOrigin(url.searchParams.get("origin")) ?? webOrigin(url.origin) ?? undefined;
            const viewer = { key: auth.kind === "session" ? `session:${auth.session.id}` : auth.kind, allowed: () => !visible || visible(auth, threadId) };
            const doc = apps.appDocument(threadId, m[2], asked === null ? undefined : Number(asked), origin, viewer);
            if (!doc)
                return json(res, 404, userError(asked === null ? "serverError.page.notStored" : "serverError.page.versionGone"));
            // `can` and `blocked` change with sign-in and settings: never cached.
            res.setHeader("cache-control", "private, no-store");
            return json(res, 200, doc);
        }
        m = APP_ACTION.exec(path);
        if (!m || method !== "POST")
            return PASS;
        const [, botId, messageId, action] = m;
        const body = await readBody(req, action === "rpc" ? APP_LIMITS.rpcArgumentsBytes + 16_384 : 64_000);
        if (!isRecord(body) || typeof body.threadId !== "string" || !/^[\w-]+$/.test(body.threadId)) {
            return json(res, 400, { error: "threadId is required" });
        }
        const threadId = body.threadId;
        const bot = store.bot(botId);
        if (!bot)
            return json(res, 404, { error: "no such bot" });
        if (store.groupByThread(threadId))
            return json(res, 409, { error: ROOM_VIEW_ONLY });
        if (!store.taskByThread(bot.id, threadId))
            return json(res, 404, { error: "no such conversation" });
        const refused = deps.threadRefusal?.(auth, threadId);
        if (refused)
            return json(res, 403, { error: refused });
        const row = appRow(store, threadId, messageId);
        if (!row || (row.from && row.from.botId !== bot.id))
            return json(res, 404, { error: "That app is not in this conversation." });
        if (action === "context") {
            if (!contextRate.take(`${threadId}:${row.id}`))
                return json(res, 429, { error: "Too many context updates from this app." });
            const result = apps.setAppContext({ threadId, messageId: row.id, content: body.content, structuredContent: body.structuredContent });
            return result.ok ? json(res, 200, { ok: true }) : json(res, result.status, { error: result.error });
        }
        if (row.app.source !== "mcp")
            return json(res, 404, { error: "That app has no server to call." });
        if (typeof body.method !== "string" || !APP_RPC_METHODS.includes(body.method)) {
            return json(res, 400, { error: `method must be one of ${APP_RPC_METHODS.join(", ")}` });
        }
        if (body.params !== undefined && !isRecord(body.params))
            return json(res, 400, { error: "params must be an object" });
        if (!deps.mcpRpc)
            return json(res, 404, { error: "This app cannot reach its server on this computer yet." });
        const answer = await deps.mcpRpc({
            auth, bot, threadId, row,
            method: body.method,
            params: isRecord(body.params) ? body.params : {},
        });
        return json(res, answer.status, answer.body);
    };
}
