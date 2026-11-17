import { z } from "zod";
import { guestWorkspaceToHost } from "../bot-attachment.js";
import { VM_WORKSPACE_GUEST } from "../container-computer.js";
import { refusalBody, userError } from "../user-errors.js";
import { PASS } from "./table.js";
const PUBLISH = "/api/internal/pages/publish", UNPUBLISH = "/api/internal/pages/unpublish";
const UNPUBLISH_ROUTE = /^\/api\/published-pages\/([a-z0-9]{20,63})\/unpublish$/;
const APP_PUBLISH_ROUTE = /^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/app\/publish$/;
const appPublishBody = z.object({ rev: z.number().int().min(0).max(1_000_000).optional() }).strict();
const pageId = z.string().max(63).optional();
const publishBody = z.object({ path: z.string().max(4096), title: z.string().max(1000), page_id: pageId, live: z.boolean().optional() });
const unpublishBody = z.object({ page_id: pageId, path: z.string().max(4096).optional() });
/** A path inside the bot's Local VM workspace means the same file on this computer. */
const hostPath = (path, vmWorkspace) => vmWorkspace ? guestWorkspaceToHost(path, VM_WORKSPACE_GUEST, vmWorkspace) ?? path : path;
export function createPagesInternalRoutes(publisher) {
    return async (ctx) => {
        if (ctx.method !== "POST" || (ctx.path !== PUBLISH && ctx.path !== UNPUBLISH))
            return PASS;
        const raw = await ctx.readBody();
        const { roots, vmWorkspace } = await ctx.folders();
        const folders = vmWorkspace ? [vmWorkspace, ...roots] : roots;
        ctx.requireActive();
        const call = { assertActive: ctx.requireActive, signal: ctx.signal };
        let outcome;
        if (ctx.path === PUBLISH) {
            const body = publishBody.safeParse(raw ?? {});
            if (!body.success)
                return void ctx.json(ctx.res, 400, { error: "publish_page takes path, title and optionally page_id (text) and live (true or false)." });
            outcome = await publisher.publish({ botId: ctx.botId, threadId: ctx.threadId, path: hostPath(body.data.path, vmWorkspace), title: body.data.title,
                ...(body.data.page_id ? { pageId: body.data.page_id } : {}), ...(body.data.live !== undefined ? { live: body.data.live } : {}),
                roots: folders, post: ctx.post, call });
        }
        else {
            const body = unpublishBody.safeParse(raw ?? {});
            if (!body.success)
                return void ctx.json(ctx.res, 400, { error: "unpublish_page takes page_id, or the path the page was published from." });
            outcome = await publisher.unpublish({ ...(body.data.page_id ? { pageId: body.data.page_id } : {}),
                ...(body.data.path ? { path: hostPath(body.data.path, vmWorkspace) } : {}), botId: ctx.botId, roots: folders, call });
        }
        ctx.json(ctx.res, outcome.status, outcome.status === 200 ? { ok: true, text: outcome.text } : { error: outcome.text });
    };
}
/** A chat page keeps one link however often it is published again: a folder page shares its folder's with publish_page. */
export const appPageSource = (threadId, messageId) => `app:${threadId}/${messageId}`;
/** POST /api/published-pages/<pageId>/unpublish: the card's Unpublish. POST .../messages/<id>/app/publish: a page card's
 * Share. Both admin-scope routes, so only the owner's own app. */
export function createPublishedPageRoutes(publisher, apps) {
    return async ({ req, res, path, method, json, readBody }) => {
        const match = UNPUBLISH_ROUTE.exec(path);
        if (match && method === "POST") {
            const outcome = await publisher.unpublish({ pageId: match[1] });
            return void json(res, outcome.status, outcome.status === 200 ? { ok: true, card: outcome.card } : { error: outcome.text });
        }
        const page = apps ? APP_PUBLISH_ROUTE.exec(path) : null;
        if (!apps || !page || method !== "POST")
            return PASS;
        const [, threadId, messageId] = page;
        const bot = apps.botOf(threadId);
        if (!bot)
            return void json(res, 404, userError("serverError.page.roomOrClosed"));
        const body = appPublishBody.safeParse(await readBody(req, 4_096) ?? {});
        if (!body.success)
            return void json(res, 400, { error: "Publish takes an optional rev, the version to publish." });
        const built = apps.page(threadId, messageId, body.data.rev);
        if (!built.ok)
            return void json(res, built.status, refusalBody(built));
        const pageId = apps.published(threadId, messageId);
        const outcome = await publisher.publishFiles({
            botId: bot.id, threadId, source: built.folder ?? appPageSource(threadId, messageId), title: built.title, files: built.files,
            ...(pageId ? { pageId } : {}),
            post: (_text, card) => (card.state === "live" ? apps.show(threadId, messageId, card) : null),
        });
        json(res, outcome.status, outcome.status === 200 ? { ok: true, card: outcome.card } : { error: outcome.text, ...(outcome.card ? { card: outcome.card } : {}) });
    };
}
