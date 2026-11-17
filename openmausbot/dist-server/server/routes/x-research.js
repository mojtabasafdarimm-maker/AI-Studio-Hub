import { z } from "zod";
import { costLine, createResearchClient, RESEARCH_ID, RESEARCH_SEARCH_MAX } from "../research.js";
import { createXClient, DEFAULT_POSTS, MAX_POSTS, normalizeHandle, parsePostRef, X_MESSAGES, XResearchError, } from "../x-research.js";
import { PASS } from "./table.js";
const X_PREFIX = "/api/internal/x/";
const X_ACTIONS = new Set(["search", "user-posts", "post", "profile"]);
const RESEARCH_PREFIX = "/api/internal/research/";
const RESEARCH_ACTIONS = new Set(["search", "endpoint", "call"]);
/** 401 is never used: on internal routes it means the capability expired. */
function statusFor(code) {
    return code === "bad_input" ? 400 : code === "not_found" ? 404 : 502;
}
const limit = z.number().int().min(1).max(MAX_POSTS).optional();
const sinceId = z.string().regex(/^\d{1,25}$/, "sinceId must be the digits of an X post id, such as a newestId from an earlier call").optional();
const searchBody = z.object({ query: z.string().trim().min(1).max(512), sort: z.enum(["latest", "top"]).optional(), limit, sinceId });
const userPostsBody = z.object({ handle: z.string(), limit, sinceId, includeReplies: z.boolean().optional() });
const postBody = z.object({ post: z.string(), replies: z.boolean().optional() });
const profileBody = z.object({ handle: z.string() });
const researchId = z.string().regex(RESEARCH_ID, "id must be a research endpoint id from research_search, such as apollo.people.search");
const researchSearchBody = z.object({ job: z.string().trim().min(1).max(300), limit: z.number().int().min(1).max(RESEARCH_SEARCH_MAX).optional() });
const researchCallBody = z.object({
    id: researchId,
    params: z.union([z.record(z.string().max(200), z.unknown()), z.array(z.unknown()).max(1000)]).optional(),
    query: z.record(z.string().min(1).max(200), z.unknown()).optional(),
});
function parse(schema, body) {
    const parsed = schema.safeParse(body ?? {});
    if (parsed.success)
        return parsed.data;
    const issue = parsed.error.issues[0];
    throw new XResearchError("bad_input", `${issue?.path.join(".") || "input"}: ${issue?.message ?? "invalid"}`);
}
function handleFrom(raw) {
    const handle = normalizeHandle(raw);
    if (!handle)
        throw new XResearchError("bad_input", "handle must be an X handle such as @openmausbot, or an x.com profile link.");
    return handle;
}
async function run(action, body, client) {
    if (action === "search") {
        const input = parse(searchBody, body);
        return client.search({ query: input.query, sort: input.sort ?? "latest", limit: input.limit ?? DEFAULT_POSTS, ...(input.sinceId ? { sinceId: input.sinceId } : {}) });
    }
    if (action === "user-posts") {
        const input = parse(userPostsBody, body);
        return client.userPosts({
            handle: handleFrom(input.handle),
            limit: input.limit ?? DEFAULT_POSTS,
            includeReplies: input.includeReplies ?? false,
            ...(input.sinceId ? { sinceId: input.sinceId } : {}),
        });
    }
    if (action === "post") {
        const input = parse(postBody, body);
        const ref = parsePostRef(input.post);
        if (!ref)
            throw new XResearchError("bad_input", "post must be an x.com or twitter.com post link, or a post id.");
        return client.post({ ...ref, replies: input.replies ?? false });
    }
    const input = parse(profileBody, body);
    return client.profile(handleFrom(input.handle));
}
async function research(action, body, client) {
    if (action === "search") {
        const input = parse(researchSearchBody, body);
        return client.search({ job: input.job, limit: input.limit ?? 5 });
    }
    if (action === "endpoint")
        return client.endpoint(parse(z.object({ id: researchId }), body).id);
    const input = parse(researchCallBody, body);
    const answer = await client.call({ id: input.id, ...(input.params === undefined ? {} : { params: input.params }), ...(input.query ? { query: input.query } : {}) });
    const cost = costLine(answer);
    return { result: answer.result, ...(cost ? { cost } : {}), ...(answer.callId ? { callId: answer.callId } : {}), ...(answer.upstreamFailed ? { upstreamFailed: answer.upstreamFailed } : {}) };
}
export function createXResearchInternalRoutes(deps) {
    const xClientFor = deps.client ?? ((credential) => createXClient(credential));
    const researchClientFor = deps.research ?? ((credential) => createResearchClient(credential));
    return async (ctx) => {
        if (ctx.method !== "POST")
            return PASS;
        const prefix = ctx.path.startsWith(X_PREFIX) ? X_PREFIX : ctx.path.startsWith(RESEARCH_PREFIX) ? RESEARCH_PREFIX : null;
        const action = prefix ? ctx.path.slice(prefix.length) : "";
        if (!prefix || !(prefix === X_PREFIX ? X_ACTIONS : RESEARCH_ACTIONS).has(action))
            return PASS;
        const credential = deps.credential();
        if (!credential)
            return void ctx.json(ctx.res, 403, { error: X_MESSAGES.noKey });
        if (!deps.botEnabled(ctx.botId))
            return void ctx.json(ctx.res, 403, { error: X_MESSAGES.botOff });
        const body = await ctx.readBody();
        try {
            ctx.json(ctx.res, 200, prefix === X_PREFIX ? await run(action, body, xClientFor(credential)) : await research(action, body, researchClientFor(credential)));
        }
        catch (error) {
            if (!(error instanceof XResearchError))
                throw error;
            if (error.code === "off" && prefix === RESEARCH_PREFIX)
                deps.researchOff?.();
            const message = error.code === "bad_key" && deps.cloudHome && credential.included ? X_MESSAGES.homeBadKey : error.message;
            ctx.json(ctx.res, statusFor(error.code), { error: message, code: error.code });
        }
    };
}
