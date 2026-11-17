// Engines never see this, only an Authorization header. Callbacks: one pending sign-in per server, state
// compared in constant time, single-valued parameters, and a listener that lives only until its last sign-in settles.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { discoverMcpAuth } from "./mcp-oauth-discovery.js";
import { McpOAuthStore } from "./mcp-oauth-store.js";
export class McpOAuthError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "McpOAuthError";
        this.code = code;
    }
}
/** The owner of a sign-in started from a chat's Sign in card: any device that can see the card may follow it. */
export const cardOwner = (threadId, messageId) => `card:${threadId}:${messageId}`;
const DEFAULT_LIFETIME_MS = 5 * 60_000;
const REFRESH_MARGIN_MS = 2 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** A token a server refused is renewed at most this often: one refused right after a renewal is not an expired one. */
const REFUSED_RENEW_MS = 60_000;
export const MCP_OAUTH_CALLBACK_PATH = "/mcp-oauth/callback";
const CALLBACK_PATH = MCP_OAUTH_CALLBACK_PATH;
const DISCARDED = "discarded";
export class McpSignInError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = "McpSignInError";
    }
}
function preferredPort(url) {
    let hash = 0x811c9dc5;
    for (const char of url) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return 20_000 + (hash % 20_000);
}
export function mcpOAuthRedirectUri(url) {
    return `http://127.0.0.1:${preferredPort(url)}${CALLBACK_PATH}`;
}
function httpsOrigin(value) {
    if (!value)
        return null;
    try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password && value.replace(/\/+$/, "") === url.origin ? url.origin : null;
    }
    catch {
        return null;
    }
}
/** The browser's proven origin wins when it is configured or none is; never a Host header nobody vouched for. */
export function mcpCallbackOrigin(browserOrigin, configured) {
    const known = configured.map(httpsOrigin).filter((origin) => origin !== null);
    const proven = httpsOrigin(browserOrigin);
    if (proven && (known.length === 0 || known.includes(proven)))
        return proven;
    return known[0] ?? null;
}
/** RFC 8414 §2: an absent list means client_secret_basic. */
function tokenAuthMethod(meta, secret) {
    if (!secret)
        return "none";
    const supported = meta.tokenEndpointAuthMethods;
    return !supported || supported.includes("client_secret_basic") || !supported.includes("client_secret_post")
        ? "client_secret_basic"
        : "client_secret_post";
}
/** RFC 6749 §2.3.1: Basic credentials are form-encoded first. */
const formEncoded = (value) => new URLSearchParams({ v: value }).toString().slice(2);
function listen(server, port) {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
}
function sameSecret(actual, expected) {
    return Buffer.byteLength(actual) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
async function postForm(url, form, client) {
    const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    const fields = { ...form };
    if (client?.method === "client_secret_basic" && client.secret) {
        headers.authorization = `Basic ${Buffer.from(`${formEncoded(client.id)}:${formEncoded(client.secret)}`).toString("base64")}`;
    }
    else if (client) {
        fields.client_id = client.id;
        if (client.method === "client_secret_post" && client.secret)
            fields.client_secret = client.secret;
    }
    const response = await fetch(url, {
        method: "POST",
        headers,
        body: new URLSearchParams(fields).toString(),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let body = {};
    try {
        const parsed = await response.json();
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            body = parsed;
    }
    catch {
    }
    return { status: response.status, body };
}
function tokensFrom(body, previous) {
    if (typeof body.access_token !== "string" || !body.access_token)
        return null;
    const refresh = typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : previous?.refresh;
    return {
        access: body.access_token,
        ...(refresh ? { refresh } : {}),
        ...(typeof body.expires_in === "number" && body.expires_in > 0 ? { expiresAt: Date.now() + body.expires_in * 1000 } : {}),
        ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
    };
}
class RegistrationRefused extends Error {
}
export class McpOAuthManager {
    store;
    lifetimeMs;
    isOwnerLive;
    flows = new Map();
    listeners = new Map();
    starting = new Map();
    refreshing = new Map();
    renewedAfterRefusal = new Map();
    clients;
    onSettled;
    onRefresh;
    disposed = false;
    /** `clients` is read when needed: an app's secret is never copied into this store. `onSettled` hears each sign-in end
     * once, except when the server shuts down. `onRefresh` hears how each refresh ended. */
    constructor(options) {
        this.store = new McpOAuthStore(options.file);
        this.isOwnerLive = options.isOwnerLive ?? (() => true);
        this.onSettled = options.onSettled ?? (() => { });
        this.onRefresh = options.onRefresh ?? (() => { });
        this.lifetimeMs = options.lifetimeMs ?? DEFAULT_LIFETIME_MS;
        this.clients = options.clients ?? (() => undefined);
    }
    recordClient(name, record) {
        if (!record.clientId)
            return null;
        if (!record.tokenAuth)
            return { id: record.clientId, method: "none" };
        const configured = this.clients(name, record.url);
        return configured?.clientId === record.clientId && configured.clientSecret
            ? { id: record.clientId, secret: configured.clientSecret, method: record.tokenAuth }
            : null;
    }
    authState(name, url) {
        const record = this.store.get(name, url);
        if (!record)
            return "none";
        return record.state === "signed-in" && record.tokens ? "signed-in" : "needs-sign-in";
    }
    /** The sign-in kept for an entry, with its tokens: only for moving it to the person's own Cloud, never for a route. */
    signInRecord(name, url) {
        return this.store.get(name, url);
    }
    /** A sign-in moved here from the person's own computer, for the entry at this address. A sign-in this server already
     * has is kept, unless `replaces` says it is the one that computer moved here before (it refreshed there since). The
     * app's secret, when it has one, came with the entry itself. */
    adopt(name, url, record, replaces) {
        const current = this.store.get(name, url);
        if (current && this.authState(name, url) === "signed-in" && !replaces?.(current))
            return "kept";
        this.cancel(name);
        this.store.put(name, { ...record, url, state: record.tokens ? "signed-in" : "needs-sign-in" });
        return "adopted";
    }
    markNeedsSignIn(name, url) {
        const { tokens: _dropped, ...rest } = this.store.get(name, url) ?? { url };
        this.store.put(name, { ...rest, url, state: "needs-sign-in" });
    }
    /** A probe that sent no credentials found that the server wants a sign-in this entry doesn't hold. Never touches a
     * sign-in (one may have landed while the probe ran), so unlike markNeedsSignIn it has no tokens to drop. Idempotent. */
    requireSignIn(name, url) {
        if (this.authState(name, url) === "signed-in")
            return;
        const current = this.store.get(name, url);
        if (current?.state === "needs-sign-in")
            return;
        this.store.put(name, { ...current, url, state: "needs-sign-in" });
    }
    start(name, url, wwwAuthenticate, owner = "loopback", browser = { remote: false }) {
        const current = this.flows.get(name);
        if (current?.status.phase === "waiting" && !this.isOwnerLive(current.owner)) {
            this.finish(current, "cancelled", "Your session ended. Start again.");
        }
        if (current?.status.phase === "waiting") {
            if (current.owner !== owner)
                return Promise.reject(new McpSignInError("A sign-in is already in progress in another browser.", 409));
            if (current.url === url)
                return Promise.resolve({ ...current.status });
        }
        const pending = this.starting.get(name);
        if (pending) {
            if (pending.owner !== owner || pending.url !== url || pending.cancelled) {
                return Promise.reject(new McpSignInError("A sign-in is still starting. Try again shortly.", 409));
            }
            return pending.promise;
        }
        const starting = { owner, url, browser, cancelled: false, promise: undefined };
        starting.promise = this.begin(name, url, starting, wwwAuthenticate).finally(() => this.starting.delete(name));
        this.starting.set(name, starting);
        return starting.promise;
    }
    /** The sign-in this owner is waiting on for a server, and whether it comes back to this computer's loopback listener. */
    waiting(name, owner) {
        const flow = this.flows.get(name);
        return flow?.owner === owner && flow.status.phase === "waiting" ? { loopback: flow.listener !== null } : null;
    }
    status(name, flowId, owner = "loopback") {
        const flow = this.flows.get(name);
        return flow && flow.owner === owner && flow.status.flowId === flowId ? { ...flow.status } : undefined;
    }
    cancelFlow(name, owner, flowId) {
        const flow = this.flows.get(name);
        if (!flow || flow.owner !== owner || (flowId && flow.status.flowId !== flowId)) {
            throw new McpSignInError("This sign-in is no longer available in this browser. Start again.", 404);
        }
        this.finish(flow, "cancelled", "Sign-in cancelled.");
    }
    cancel(name) {
        const pending = this.starting.get(name);
        if (pending)
            pending.cancelled = true;
        const flow = this.flows.get(name);
        if (flow)
            this.finish(flow, "cancelled", "Sign-in cancelled.");
    }
    revokeOwner(owner) {
        for (const pending of this.starting.values())
            if (pending.owner === owner)
                pending.cancelled = true;
        for (const flow of this.flows.values()) {
            if (flow.owner === owner)
                this.finish(flow, "cancelled", "Sign-in cancelled because your session ended.");
        }
    }
    /** Parse the pasted URL locally; never request a user-supplied address. */
    async completeCallback(name, flowId, callbackUrl, owner = "loopback") {
        const flow = this.flows.get(name);
        if (!flow || flow.owner !== owner || flow.status.flowId !== flowId) {
            throw new McpSignInError("This sign-in is no longer available in this browser. Start again.", 404);
        }
        let callback;
        try {
            if (callbackUrl.length > 16_384)
                throw new Error("length");
            callback = new URL(callbackUrl);
        }
        catch {
            throw new McpSignInError("Paste the complete redirect URL from your browser's address bar.", 400);
        }
        await this.acceptCallback(flow, callback);
        return { ...flow.status };
    }
    /** The scheme is the redirect URI's: a proxy in front of this server may end TLS. */
    async publicCallback(host, search) {
        const state = new URLSearchParams(search).get("state") ?? "";
        let match;
        for (const flow of this.flows.values()) {
            const expected = new URL(flow.redirectUri);
            if (!flow.listener && expected.host === host?.trim().toLowerCase() && sameSecret(state, flow.state))
                match = flow;
        }
        if (!match)
            return { status: 400, text: "Invalid sign-in callback. Return to OpenMausBot and try again." };
        return this.answer(match, new URL(`${new URL(match.redirectUri).origin}${CALLBACK_PATH}${search.startsWith("?") ? search : ""}`));
    }
    async signOut(name, url) {
        this.cancel(name);
        const record = this.store.get(name, url);
        const token = record?.tokens?.refresh ?? record?.tokens?.access;
        if (record?.revocationEndpoint && token) {
            await postForm(record.revocationEndpoint, { token }, this.recordClient(name, record) ?? undefined).catch(() => undefined);
        }
        this.store.delete(name);
    }
    forget(name) {
        this.cancel(name);
        this.flows.delete(name);
        this.store.delete(name);
    }
    accessToken(name, url) {
        const record = this.store.get(name, url);
        if (!record || record.state !== "signed-in" || !record.tokens)
            return Promise.resolve(null);
        const { tokens } = record;
        if (!tokens.expiresAt || tokens.expiresAt > Date.now() + REFRESH_MARGIN_MS)
            return Promise.resolve(tokens.access);
        return this.renew(name, record, false).then((renewed) => renewed.token);
    }
    /** When this sign-in ends for good: its token's expiry, when nothing can refresh it; null otherwise. */
    endsAt(name, url) {
        const record = this.store.get(name, url);
        if (!record || record.state !== "signed-in" || !record.tokens?.expiresAt)
            return null;
        return this.renewable(name, record) ? null : record.tokens.expiresAt;
    }
    /** The server refused this sign-in's token on a real call (HTTP 401): it is refreshed now, or, when nothing can refresh
     * it, the sign-in has ended. A token refused again right after a refresh is left as it is. */
    async tokenRefused(name, url) {
        const record = this.store.get(name, url);
        if (!record || record.state !== "signed-in" || !record.tokens)
            return record?.state === "needs-sign-in" ? "ended" : "unknown";
        const renewed = this.renewedAfterRefusal.get(name);
        if (renewed !== undefined && Date.now() - renewed < REFUSED_RENEW_MS)
            return "again";
        this.renewedAfterRefusal.set(name, Date.now());
        const { outcome } = await this.renew(name, record, true);
        return outcome === "refreshed" ? "refreshed" : outcome === "rejected" || outcome === "expired" ? "ended" : "unknown";
    }
    dispose() {
        this.disposed = true;
        for (const pending of this.starting.values())
            pending.cancelled = true;
        for (const flow of this.flows.values())
            this.finish(flow, "cancelled", "Sign-in cancelled.");
        this.flows.clear();
        for (const opening of this.listeners.values()) {
            void opening.then((listener) => {
                listener.server.close();
                listener.server.closeIdleConnections();
            }).catch(() => undefined);
        }
        this.listeners.clear();
    }
    renewable(name, record) {
        return Boolean(record.tokens?.refresh && record.tokenEndpoint && this.recordClient(name, record));
    }
    /** One refresh at a time per server. `forced`: a server refused the token, so it is renewed whatever its expiry says, and
     * a token nothing can renew has ended. */
    renew(name, record, forced) {
        const pending = this.refreshing.get(name);
        if (pending)
            return pending;
        const renewed = this.refresh(name, record, forced).then((result) => {
            if (result.outcome) {
                try {
                    this.onRefresh(name, result.outcome);
                }
                catch (error) {
                    console.error("mcp sign-in: onRefresh failed", error);
                }
            }
            return result;
        }).finally(() => this.refreshing.delete(name));
        this.refreshing.set(name, renewed);
        return renewed;
    }
    async refresh(name, record, forced) {
        const tokens = record.tokens;
        const stillValid = !forced && tokens.expiresAt !== undefined && tokens.expiresAt > Date.now();
        const client = this.recordClient(name, record);
        if (!tokens.refresh || !record.tokenEndpoint || !client) {
            if (stillValid)
                return { token: tokens.access, outcome: null };
            this.markNeedsSignIn(name, record.url);
            return { token: null, outcome: "expired" };
        }
        let answer;
        try {
            answer = await postForm(record.tokenEndpoint, {
                grant_type: "refresh_token",
                refresh_token: tokens.refresh,
                resource: record.url,
            }, client);
        }
        catch {
            return { token: stillValid ? tokens.access : null, outcome: "unreachable" };
        }
        const next = answer.status >= 200 && answer.status < 300 ? tokensFrom(answer.body, tokens) : null;
        if (!next) {
            const dead = (answer.status === 400 || answer.status === 401)
                && (answer.body.error === "invalid_grant" || answer.body.error === "invalid_client");
            if (!dead)
                return { token: stillValid ? tokens.access : null, outcome: "unreachable" };
            this.markNeedsSignIn(name, record.url);
            return { token: null, outcome: "rejected" };
        }
        // the entry may have been removed or re-pointed while this was in flight
        if (!this.store.get(name, record.url))
            return { token: null, outcome: null };
        this.store.put(name, { ...record, state: "signed-in", tokens: next });
        return { token: next.access, outcome: "refreshed" };
    }
    async challenge(url) {
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "OpenMausBot", version: "1" } } }),
                redirect: "error",
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            void response.body?.cancel().catch(() => { });
            return response.status === 401 ? response.headers.get("www-authenticate") : null;
        }
        catch {
            return null;
        }
    }
    /** A fresh public client per sign-in: authorization servers prune idle clients, so a cached id goes stale. */
    async register(meta, redirectUri) {
        if (!meta.registrationEndpoint) {
            throw new McpOAuthError("no-registration", "This server only signs in apps registered with it in advance. Edit the server and add that app's client ID under Sign-in app.");
        }
        const response = await fetch(meta.registrationEndpoint, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({
                client_name: "OpenMausBot",
                redirect_uris: [redirectUri],
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                token_endpoint_auth_method: "none",
            }),
            redirect: "error",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || typeof body.client_id !== "string" || !body.client_id) {
            throw new RegistrationRefused("This server would not register OpenMausBot for sign-in. Try again later.");
        }
        return body.client_id;
    }
    async begin(name, url, starting, wwwAuthenticate) {
        const previous = this.flows.get(name);
        if (previous)
            this.finish(previous, "cancelled", "Sign-in cancelled.");
        const meta = await discoverMcpAuth(url, wwwAuthenticate ?? await this.challenge(url));
        if (!meta)
            throw new McpOAuthError("not-oauth", "This server does not offer an OAuth sign-in. Add its token as a header instead.");
        const registered = this.clients(name, url);
        if (!registered && starting.browser.remote && starting.browser.origin) {
            const redirectUri = `${starting.browser.origin}${CALLBACK_PATH}`;
            let clientId = null;
            try {
                clientId = await this.register(meta, redirectUri);
            }
            catch (error) {
                if (!(error instanceof RegistrationRefused))
                    throw error;
            }
            if (clientId)
                return { ...this.open(name, url, starting, meta, redirectUri, { id: clientId, method: "none" }, null, meta.scopes).status };
        }
        const listener = await this.listener(preferredPort(url), registered !== undefined);
        try {
            const redirectUri = `http://127.0.0.1:${listener.port}${CALLBACK_PATH}`;
            const client = registered
                ? { id: registered.clientId, ...(registered.clientSecret ? { secret: registered.clientSecret } : {}), method: tokenAuthMethod(meta, registered.clientSecret) }
                : { id: await this.register(meta, redirectUri), method: "none" };
            const scopes = registered?.scopes?.length ? registered.scopes : meta.scopes;
            const flow = this.open(name, url, starting, meta, redirectUri, client, listener, scopes);
            listener.reserved -= 1;
            listener.flows.add(flow);
            return { ...flow.status };
        }
        catch (error) {
            listener.reserved -= 1;
            this.closeListener(listener);
            throw error;
        }
    }
    /** The address a sign-in returns to. The connections to one server share it: every callback carries its own state. */
    async listener(port, registered) {
        const pending = this.listeners.get(port);
        if (pending) {
            const listener = await pending;
            listener.reserved += 1;
            return listener;
        }
        const opening = this.openListener(port);
        this.listeners.set(port, opening);
        let listener;
        try {
            listener = await opening;
        }
        catch {
            this.listeners.delete(port);
            if (registered) {
                throw new McpOAuthError("port-busy", `Port ${port} on this computer is in use, and sign-ins for this server's app return there. Close what is using it and try again.`);
            }
            listener = await this.openListener(0);
            this.listeners.set(listener.port, Promise.resolve(listener));
        }
        listener.reserved += 1;
        return listener;
    }
    async openListener(port) {
        const server = createServer();
        try {
            await listen(server, port);
            const address = server.address();
            if (!address || typeof address === "string")
                throw new Error("The sign-in listener could not start.");
            const listener = { server, port: address.port, flows: new Set(), reserved: 0 };
            server.on("request", (request, response) => void this.dispatch(listener, request, response));
            return listener;
        }
        catch (error) {
            server.close();
            throw error;
        }
    }
    /** The callback belongs to the sign-in whose state it carries. */
    dispatch(listener, request, response) {
        const state = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("state") ?? "";
        let match;
        for (const flow of listener.flows)
            if (sameSecret(state, flow.state))
                match = flow;
        if (!match) {
            response.setHeader("Cache-Control", "no-store");
            response.setHeader("Content-Type", "text/plain; charset=utf-8");
            response.writeHead(400).end("Invalid sign-in callback. Return to OpenMausBot and try again.");
            return;
        }
        void this.callback(match, request, response);
    }
    /** A listener lives while a sign-in waits on it. */
    release(flow) {
        const listener = flow.listener;
        if (!listener)
            return;
        listener.flows.delete(flow);
        this.closeListener(listener);
    }
    closeListener(listener) {
        if (listener.flows.size || listener.reserved)
            return;
        this.listeners.delete(listener.port);
        listener.server.close();
        listener.server.closeIdleConnections();
    }
    open(name, url, starting, meta, redirectUri, client, listener, scopes) {
        if (starting.cancelled || !this.isOwnerLive(starting.owner))
            throw new McpSignInError("Sign-in cancelled because the session or server changed.", 409);
        const state = randomBytes(32).toString("base64url");
        const verifier = randomBytes(32).toString("base64url");
        const authorize = new URL(meta.authorizationEndpoint);
        authorize.searchParams.set("response_type", "code");
        authorize.searchParams.set("client_id", client.id);
        authorize.searchParams.set("redirect_uri", redirectUri);
        authorize.searchParams.set("state", state);
        authorize.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
        authorize.searchParams.set("code_challenge_method", "S256");
        authorize.searchParams.set("resource", meta.resource);
        if (scopes?.length)
            authorize.searchParams.set("scope", scopes.join(" "));
        const status = {
            phase: "waiting",
            flowId: randomUUID(),
            authorizationUrl: authorize.toString(),
            expiresAt: new Date(Date.now() + this.lifetimeMs).toISOString(),
            ...(listener && starting.browser.remote ? { pasteBack: true } : {}),
        };
        const flow = {
            owner: starting.owner, name, url, status, state, verifier, redirectUri, client, meta, listener, consumed: false,
            expiry: setTimeout(() => this.finish(flow, "expired", "Sign-in expired. Start again."), this.lifetimeMs),
        };
        flow.expiry.unref();
        this.flows.set(name, flow);
        return flow;
    }
    async callback(flow, request, response) {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.setHeader("Referrer-Policy", "no-referrer");
        // A kept-alive connection would carry the next sign-in's callback here after the listener stopped accepting.
        response.setHeader("Connection", "close");
        let callback;
        try {
            const expected = new URL(flow.redirectUri);
            if (request.headers.host !== expected.host || !request.url?.startsWith("/"))
                throw new Error("host");
            callback = new URL(request.url, flow.redirectUri);
        }
        catch {
            response.writeHead(400).end("Invalid sign-in callback. Return to OpenMausBot and try again.");
            return;
        }
        const answer = request.method === "GET"
            ? await this.answer(flow, callback)
            : { status: 400, text: "Invalid or expired sign-in. Return to OpenMausBot and try again." };
        response.writeHead(answer.status).end(answer.text);
    }
    /** Words fit for a plain page: never the code or the server's own text. */
    async answer(flow, callback) {
        try {
            await this.acceptCallback(flow, callback);
            return flow.status.phase === "failed"
                ? { status: 400, text: `${flow.status.message} You can close this tab.` }
                : { status: 200, text: "Signed in. You can close this tab and return to OpenMausBot." };
        }
        catch (error) {
            return { status: error instanceof McpSignInError ? error.status : 400, text: "Invalid or expired sign-in. Return to OpenMausBot and try again." };
        }
    }
    async acceptCallback(flow, callback) {
        if (!this.isOwnerLive(flow.owner))
            this.finish(flow, "cancelled", "Your session ended. Start again.");
        if (flow.status.phase === "waiting" && !flow.consumed && Date.now() >= Date.parse(flow.status.expiresAt)) {
            this.finish(flow, "expired", "Sign-in expired. Start again.");
        }
        if (flow.consumed || flow.status.phase !== "waiting" || this.flows.get(flow.name) !== flow) {
            throw new McpSignInError("This sign-in has ended or is already being completed. Start again if needed.", 409);
        }
        const expected = new URL(flow.redirectUri);
        const params = callback.searchParams;
        if (callback.origin !== expected.origin || callback.pathname !== expected.pathname
            || callback.username || callback.password || callback.hash
            || [...params.keys()].some((key) => params.getAll(key).length !== 1)
            || !sameSecret(params.get("state") ?? "", flow.state)
            || (params.has("iss") && params.get("iss") !== flow.meta.issuer)
            || !((params.get("code") && !params.has("error") && params.get("code").length <= 4096)
                || (params.get("error") && !params.has("code")))) {
            throw new McpSignInError("This redirect URL does not belong to the current sign-in. Copy the complete URL and try again.", 400);
        }
        flow.consumed = true;
        clearTimeout(flow.expiry);
        const failure = await this.complete(flow, params);
        if (failure === DISCARDED)
            throw new McpSignInError("This sign-in was cancelled. Start again.", 409);
        this.finish(flow, failure ? "failed" : "succeeded", failure ?? undefined);
    }
    async complete(flow, params) {
        if (params.has("error"))
            return "Sign-in was not approved.";
        const code = params.get("code");
        if (!code || code.length > 4096)
            return "The sign-in did not return a code. Start again.";
        try {
            const answer = await postForm(flow.meta.tokenEndpoint, {
                grant_type: "authorization_code",
                code,
                redirect_uri: flow.redirectUri,
                code_verifier: flow.verifier,
                resource: flow.meta.resource,
            }, flow.client);
            const tokens = answer.status >= 200 && answer.status < 300 ? tokensFrom(answer.body) : null;
            if (!tokens)
                return "The server did not accept this sign-in. Start again.";
            // Ended while the code was being spent: hand the tokens back rather than resurrect a sign-in.
            if (!this.isOwnerLive(flow.owner))
                this.finish(flow, "cancelled", "Your session ended. Start again.");
            if (this.flows.get(flow.name) !== flow || flow.status.phase !== "waiting") {
                if (flow.meta.revocationEndpoint) {
                    void postForm(flow.meta.revocationEndpoint, { token: tokens.refresh ?? tokens.access }, flow.client).catch(() => undefined);
                }
                return DISCARDED;
            }
            this.store.put(flow.name, {
                url: flow.url,
                state: "signed-in",
                issuer: flow.meta.issuer,
                clientId: flow.client.id,
                ...(flow.client.method !== "none" ? { tokenAuth: flow.client.method } : {}),
                redirectUri: flow.redirectUri,
                tokenEndpoint: flow.meta.tokenEndpoint,
                ...(flow.meta.revocationEndpoint ? { revocationEndpoint: flow.meta.revocationEndpoint } : {}),
                tokens,
            });
            return null;
        }
        catch {
            return "Could not reach the sign-in server. Start again.";
        }
    }
    finish(flow, phase, message) {
        if (flow.status.phase !== "waiting")
            return;
        clearTimeout(flow.expiry);
        this.release(flow);
        flow.status = { ...flow.status, phase, authorizationUrl: null, ...(message ? { message } : {}) };
        if (this.disposed)
            return;
        // A listener's fault must neither escape the expiry timer nor turn a sign-in already stored into a failed callback.
        try {
            this.onSettled(flow.name, phase, flow.owner);
        }
        catch (error) {
            console.error("mcp sign-in: onSettled failed", error);
        }
    }
}
const isUrlServer = (server) => "url" in server;
export function withoutPendingSignIn(servers, manager) {
    return Object.fromEntries(Object.entries(servers).filter(([name, server]) => !isUrlServer(server) || manager.authState(name, server.url) !== "needs-sign-in"));
}
export async function withMcpSignIn(servers, manager) {
    const entries = await Promise.all(Object.entries(withoutPendingSignIn(servers, manager)).map(async ([name, server]) => {
        if (!isUrlServer(server) || manager.authState(name, server.url) !== "signed-in")
            return [name, server];
        const token = await manager.accessToken(name, server.url);
        if (!token)
            return null;
        const headers = Object.fromEntries(Object.entries(server.headers).filter(([key]) => key.toLowerCase() !== "authorization"));
        return [name, { ...server, headers: { ...headers, Authorization: `Bearer ${token}` } }];
    }));
    const out = {};
    for (const entry of entries)
        if (entry)
            out[entry[0]] = entry[1];
    return out;
}
