import { pagesAuthHeaders } from "./access.js";
export const SIGN_IN_MESSAGE = "Publishing a page needs a MausBot account. Sign in to MausBot in the app's Settings, then ask again.";
const UNAVAILABLE = "Publishing isn't available right now. Try again in a few minutes.";
const NOT_TURNED_ON = "Publishing pages isn't turned on for this account yet.";
/** A server with no desktop app to sign in through and no Cloud home (`openmausbot serve`): no Settings sign-in can help. */
export const SELF_HOSTED_MESSAGE = "Publishing pages isn't available on self-hosted servers yet.";
const TOKEN_TIMEOUT_MS = 15_000, UPLOAD_TIMEOUT_MS = 60_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const fail = (reason, message, extra = {}) => ({ ok: false, reason, message, ...extra });
const usageOf = (value) => {
    const usage = value;
    return usage && Number.isInteger(usage.pages) && Number.isInteger(usage.limit) ? { pages: Number(usage.pages), limit: Number(usage.limit) } : undefined;
};
/** Security: an upload token goes only to an https Worker, or to a loopback stand-in in development and tests. */
const safeUrl = (value) => {
    if (typeof value !== "string")
        return null;
    try {
        const url = new URL(value);
        return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname)) ? url : null;
    }
    catch {
        return null;
    }
};
const readJson = async (response) => {
    try {
        const body = await response.json();
        return body && typeof body === "object" && !Array.isArray(body) ? body : {};
    }
    catch {
        return {};
    }
};
const callSignal = (call, ms) => call.signal ? AbortSignal.any([call.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
const said = (body, fallback) => typeof body.message === "string" && body.message.trim() ? body.message.trim().slice(0, 500) : fallback;
export function createPagesClient(options) {
    const http = options.fetch ?? fetch, now = options.now ?? Date.now;
    const mint = async (action, call, pageId) => {
        const access = options.access();
        if (!access) {
            if (options.notOffered?.())
                return fail("unavailable", NOT_TURNED_ON);
            return options.selfHosted ? fail("unavailable", SELF_HOSTED_MESSAGE) : fail("sign_in", SIGN_IN_MESSAGE);
        }
        const body = JSON.stringify(pageId ? { action, pageId } : { action });
        let response;
        call.assertActive?.();
        try {
            response = await http(access.url, { method: "POST", redirect: "error", signal: callSignal(call, TOKEN_TIMEOUT_MS), body,
                headers: { "content-type": "application/json", accept: "application/json", ...pagesAuthHeaders(access, body, now()) } });
        }
        catch {
            return fail("unavailable", UNAVAILABLE);
        }
        const answer = await readJson(response);
        if (response.status === 401)
            return fail("sign_in", access.kind === "desktop" ? "Your MausBot sign-in has ended. Sign in to MausBot again in the app's Settings, then ask again." : UNAVAILABLE);
        if (response.status === 402) {
            const usage = usageOf(answer.usage);
            return fail("limit", said(answer, "This account's pages are used up."), { ...(usage ? { usage } : {}), upgrade: answer.upgrade === true,
                ...(typeof answer.plan === "string" && /^[a-z][a-z0-9-]{0,23}$/.test(answer.plan) ? { plan: answer.plan } : {}) });
        }
        if (response.status === 429)
            return fail("rate_limited", said(answer, "You've published a lot this hour. Try again in a few minutes."));
        const uploadUrl = safeUrl(answer.uploadUrl)?.href.replace(/\/+$/, ""), pageUrl = safeUrl(answer.pageUrl)?.href;
        if (!response.ok || typeof answer.token !== "string" || typeof answer.pageId !== "string" || !uploadUrl || !pageUrl || !answer.limits) {
            return fail("unavailable", response.status === 404 ? NOT_TURNED_ON : UNAVAILABLE);
        }
        const limit = answer.limit;
        return { token: answer.token, pageId: answer.pageId, uploadUrl, pageUrl, limits: answer.limits, ...(typeof answer.plan === "string" ? { plan: answer.plan } : {}),
            ...(limit && typeof limit.message === "string" ? { limit: { message: limit.message, upgrade: limit.upgrade === true } } : {}) };
    };
    const workerFailure = (status, body, minted) => {
        if (status === 402) {
            const usage = usageOf(body.usage);
            return fail("limit", minted.limit?.message ?? said(body, "This account's pages are used up."), { ...(usage ? { usage } : {}), upgrade: minted.limit?.upgrade ?? false,
                ...(minted.plan ? { plan: minted.plan } : {}) });
        }
        if (status === 404 || status === 410)
            return fail("gone", said(body, "That page no longer exists."));
        if (status === 429)
            return fail("rate_limited", said(body, "You've published a lot this hour. Try again in a few minutes."));
        if (status === 400 || status === 413 || status === 415)
            return fail("refused", said(body, "The pages service couldn't take this page."));
        return fail("unavailable", UNAVAILABLE);
    };
    return {
        /** A new page (no `pageId`), or new files at an existing page's same link. */
        async publish(input, call = {}) {
            const minted = await mint(input.pageId ? "update" : "create", call, input.pageId);
            if ("ok" in minted)
                return minted;
            const bytes = input.files.reduce((sum, file) => sum + file.data.byteLength, 0);
            if (input.files.length > minted.limits.files)
                return fail("refused", `A page can have at most ${minted.limits.files} files.`);
            if (bytes > minted.limits.bytes)
                return fail("refused", `A page can be at most ${minted.limits.bytes} bytes.`);
            const form = new FormData();
            form.set("manifest", JSON.stringify({ title: input.title, files: input.files.map((file) => ({ path: file.path, size: file.data.byteLength })) }));
            input.files.forEach((file, index) => form.set(`f${index}`, new Blob([new Uint8Array(file.data)])));
            let response;
            call.assertActive?.();
            const signal = callSignal(call, UPLOAD_TIMEOUT_MS);
            if (signal.aborted)
                return fail("unavailable", UNAVAILABLE);
            const page = { pageId: minted.pageId, url: minted.pageUrl };
            input.beforeUpload(page);
            const uncertain = () => fail("unavailable", UNAVAILABLE, { uncertain: page });
            try {
                response = await http(`${minted.uploadUrl}/v1/pages/${minted.pageId}`, { method: "PUT", redirect: "error", signal,
                    headers: { authorization: `Bearer ${minted.token}`, accept: "application/json" }, body: form });
            }
            catch {
                return uncertain();
            }
            const body = await readJson(response);
            if (signal.aborted)
                return uncertain();
            if (!response.ok) {
                const failure = workerFailure(response.status, body, minted);
                return failure.reason === "unavailable" ? uncertain() : failure;
            }
            const usage = usageOf(body.usage);
            return { ok: true, pageId: minted.pageId, url: minted.pageUrl, usage: usage ?? { pages: 0, limit: minted.limits.pages }, badge: body.badge === true };
        },
        async unpublish(pageId, call = {}) {
            const minted = await mint("delete", call, pageId);
            if ("ok" in minted)
                return minted;
            let response;
            call.assertActive?.();
            try {
                response = await http(`${minted.uploadUrl}/v1/pages/${pageId}`, { method: "DELETE", redirect: "error", signal: callSignal(call, TOKEN_TIMEOUT_MS),
                    headers: { authorization: `Bearer ${minted.token}`, accept: "application/json" } });
            }
            catch {
                return fail("unavailable", UNAVAILABLE);
            }
            const body = await readJson(response);
            if (!response.ok)
                return workerFailure(response.status, body, minted);
            return { ok: true, pageId, usage: usageOf(body.usage) ?? null };
        },
    };
}
