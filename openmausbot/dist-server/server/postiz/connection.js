import { userError } from "../user-errors.js";
// The `postiz` MCP server entry the Apps card manages: Postiz Cloud's OAuth endpoint for a sign-in, or a Postiz server's
// key endpoint for an organisation API key. A saved key is sent only to the entry at the address it was saved for.
import { POSTIZ_CLOUD, POSTIZ_SERVER } from "../../shared/postiz.js";
/** Postiz's MCP endpoint for clients that register themselves (RFC 7591) and sign in (Postiz 2.25: start.mcp.ts). */
const SIGN_IN_PATH = "/mcp-oauth-dynamic";
/** Postiz's MCP endpoint for an organisation API key sent as a bearer token. */
const KEY_PATH = "/mcp";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** https anywhere, plain http only to this computer (and never on a Cloud, whose own loopback is not the person's).
 * A pasted MCP address is accepted for its server; one with the key in it is refused, so the key never sits in config. */
export function postizAddress(input, options) {
    const raw = (input ?? "").trim();
    if (!raw)
        return { ok: true, address: postizCloud() };
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        return { ok: false, ...userError("serverError.postiz.addressHttps") };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
        return { ok: false, ...userError("serverError.postiz.addressHttps") };
    if (url.username || url.password)
        return { ok: false, ...userError("serverError.postiz.addressNoCredentials") };
    if (url.search || url.hash)
        return { ok: false, ...userError("serverError.postiz.addressNoQuery") };
    if (url.protocol === "http:" && !(options.loopback && LOOPBACK.has(url.hostname))) {
        return { ok: false, ...userError(options.loopback ? "serverError.postiz.addressLocalHttp" : "serverError.postiz.addressUseHttps") };
    }
    const path = url.pathname.replace(/\/+$/u, "");
    if (/\/(?:mcp|sse)\/[^/]+$/u.test(path)) {
        return { ok: false, ...userError("serverError.postiz.addressContainsKey") };
    }
    return { ok: true, address: `${url.origin}${path.replace(/\/mcp(?:-oauth(?:-[a-z]+)?)?$/u, "")}` };
}
/** Postiz Cloud, or the stand-in a test server was started with (https, or http on this computer). */
export function postizCloud(env = process.env) {
    const override = env.OMB_POSTIZ_CLOUD_URL?.trim();
    if (!override)
        return POSTIZ_CLOUD;
    try {
        const url = new URL(override);
        const allowed = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
        return allowed && !url.username && !url.password && !url.search && !url.hash ? `${url.origin}${url.pathname.replace(/\/+$/u, "")}` : POSTIZ_CLOUD;
    }
    catch {
        return POSTIZ_CLOUD;
    }
}
export const postizSignInUrl = () => `${postizCloud()}${SIGN_IN_PATH}`;
export const postizKeyUrl = (address) => `${address}${KEY_PATH}`;
/** The address a saved key belongs to. */
export function savedPostizAddress(postiz) {
    const saved = postizAddress(postiz?.url, { loopback: true });
    return saved.ok ? saved.address : postizCloud();
}
/** How the card set the entry up: Postiz Cloud's sign-in, the key endpoint at the saved address, or a key endpoint at
 * another address (the address changed and no key was saved for it yet). Null: a server named postiz it did not set up. */
export function postizEntryMethod(server, postiz) {
    if (server.type !== "http" || Object.values(server.headers).some((value) => value !== "") || server.oauth)
        return null;
    if (server.url === postizSignInUrl())
        return "sign-in";
    if (server.url === postizKeyUrl(savedPostizAddress(postiz)))
        return "key";
    try {
        const url = new URL(server.url);
        return url.pathname.endsWith(KEY_PATH) && !url.search && !url.hash && !url.username && !url.password ? "old-key" : null;
    }
    catch {
        return null;
    }
}
/** The API key header for a turn's `postiz` server: only when it is the key endpoint the key was saved for. */
export function postizKeyHeaders(postiz, name, server) {
    const key = postiz?.key?.trim();
    if (name !== POSTIZ_SERVER || !key || server.url !== postizKeyUrl(savedPostizAddress(postiz)))
        return {};
    return { Authorization: `Bearer ${key}` };
}
