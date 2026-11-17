// The credential broker: keys stay in this process, boxes get tokens. A box reaches the broker at a loopback port bridged
// to its unix socket and sends `/b/<token>/<grant>/<path>`; the broker checks the token (random, bound to the bot, the
// conversation and an expiry), strips whatever credential header the client sent, adds the real one, and forwards to a
// FIXED upstream the box cannot choose. A model call, an MCP server with a secret header and a plain API key all ride
// the same shape. Tokens die with the process they were minted for, or when their conversation's turn ends, or at TTL.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { MAX_REFUSABLE_CALL_BYTES, refusedCallAnswer } from "./broker-mcp-refusal.js";
export const BROKER_TOKEN_PREFIX = "omb_t0_";
/** A token minted for a process lives this long at most; the process's exit ends it sooner. */
export const BROKER_PROCESS_TTL_MS = 24 * 60 * 60_000;
/** A grant bound to a conversation (an MCP server's headers) slides this long past the last turn that used it. */
export const BROKER_THREAD_TTL_MS = 24 * 60 * 60_000;
const MAX_TOKENS = 10_000;
/** Credential headers a client may send; the broker never forwards them. */
const CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key", "x-goog-api-key", "proxy-authorization", "cookie"]);
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-connection", "host"]);
const TOKEN = /^omb_t0_[a-f0-9]{48}$/;
const GRANT = /^[a-z][a-z0-9_-]{0,63}$/;
export function brokerUrl(port, token, grant) {
    return `http://127.0.0.1:${port}/b/${token}/${grant}`;
}
/** Where a request for `/b/<token>/<grant><path><query>` goes: the grant's upstream exactly as it was given when the
 * client asks for the grant itself (an MCP server at `/mcp` is not one at `/mcp/`: a Cloudflare Worker answers that 404),
 * the client's path below it otherwise, and the client's query beside the upstream's own. */
export function upstreamUrl(upstream, path, query) {
    let url;
    try {
        url = new URL(upstream);
    }
    catch {
        return null;
    }
    if (path)
        url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
    if (query.length > 1)
        url.search = url.search ? `${url.search}&${query.slice(1)}` : query;
    return url;
}
const hashToken = (token) => createHash("sha256").update(token).digest();
export function openCredentialBroker(options) {
    const now = options.now ?? Date.now;
    const tokens = new Map();
    const stats = { tokens: 0, forwarded: 0, refused: 0 };
    const sockets = new Set();
    const sweep = () => {
        const at = now();
        for (const [key, stored] of tokens)
            if (stored.expiresAt <= at)
                tokens.delete(key);
    };
    const mint = (bound, input) => {
        sweep();
        if (tokens.size >= MAX_TOKENS)
            throw new Error("The credential broker holds too many tokens.");
        for (const name of Object.keys(input.grants))
            if (!GRANT.test(name))
                throw new Error(`Not a grant name: ${name.slice(0, 40)}`);
        const token = `${BROKER_TOKEN_PREFIX}${randomBytes(24).toString("hex")}`;
        const expiresAt = now() + (input.ttlMs ?? (bound === "process" ? BROKER_PROCESS_TTL_MS : BROKER_THREAD_TTL_MS));
        const grants = Object.fromEntries(Object.entries(input.grants).map(([name, grant]) => [name, { upstream: grant.upstream, headers: { ...grant.headers }, ...(grant.mcpServer ? { mcpServer: grant.mcpServer } : {}), ...(grant.mcpApp ? { mcpApp: { ...grant.mcpApp } } : {}) }]));
        tokens.set(hashToken(token).toString("hex"), { hash: hashToken(token), botId: input.botId ?? null, threadId: input.threadId ?? null, expiresAt, grants, bound });
        return { token, botId: input.botId ?? null, threadId: input.threadId ?? null, expiresAt, grants };
    };
    const lookup = (token, grant) => {
        if (!TOKEN.test(token)) {
            stats.refused += 1;
            return { ok: false, status: 401, error: "unknown_token" };
        }
        const hash = hashToken(token);
        const stored = tokens.get(hash.toString("hex"));
        if (!stored || !timingSafeEqual(stored.hash, hash)) {
            stats.refused += 1;
            return { ok: false, status: 401, error: "unknown_token" };
        }
        if (stored.expiresAt <= now()) {
            tokens.delete(hash.toString("hex"));
            stats.refused += 1;
            return { ok: false, status: 401, error: "expired_token" };
        }
        const found = Object.hasOwn(stored.grants, grant) ? stored.grants[grant] : undefined;
        if (!found) {
            stats.refused += 1;
            return { ok: false, status: 403, error: "not_granted" };
        }
        return { ok: true, grant: found, botId: stored.botId, threadId: stored.threadId };
    };
    const requestFn = options.request;
    const server = createServer((req, res) => {
        const refuse = (status, error) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ error })); req.resume(); };
        const match = /^\/b\/([^/]+)\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(req.url ?? "");
        if (!match)
            return refuse(404, "not_found");
        const [, token = "", grant = "", path = "", query = ""] = match;
        const verdict = lookup(token, grant);
        if (!verdict.ok)
            return refuse(verdict.status, verdict.error);
        const upstream = upstreamUrl(verdict.grant.upstream, path, query);
        if (!upstream)
            return refuse(502, "bad_upstream");
        const headers = {};
        for (const [name, value] of Object.entries(req.headers))
            if (value !== undefined && !HOP_BY_HOP.has(name) && !CREDENTIAL_HEADERS.has(name))
                headers[name] = value;
        for (const [name, value] of Object.entries(verdict.grant.headers))
            headers[name.toLowerCase()] = value;
        headers.host = upstream.host;
        const send = requestFn ?? (upstream.protocol === "https:" ? httpsRequest : httpRequest);
        const relay = (answer) => {
            const out = {};
            for (const [name, value] of Object.entries(answer.headers))
                if (value !== undefined && !HOP_BY_HOP.has(name))
                    out[name] = value;
            res.writeHead(answer.statusCode ?? 502, out);
            answer.pipe(res);
        };
        const mcpServer = req.method === "POST" ? verdict.grant.mcpServer : undefined;
        const sent = [];
        let sentBytes = 0;
        if (mcpServer)
            req.on("data", (chunk) => { sentBytes += chunk.length; if (sentBytes <= MAX_REFUSABLE_CALL_BYTES)
                sent.push(chunk); });
        const forwarded = send({ protocol: upstream.protocol, host: upstream.hostname, port: upstream.port || (upstream.protocol === "https:" ? 443 : 80), method: req.method, path: `${upstream.pathname}${upstream.search}`, headers }, (answer) => {
            if (!mcpServer || answer.statusCode !== 401)
                return relay(answer);
            const decide = () => {
                const sentCredentials = Object.values(verdict.grant.headers).some((value) => value !== "");
                const refusal = sentBytes <= MAX_REFUSABLE_CALL_BYTES ? refusedCallAnswer(mcpServer, sentCredentials, Buffer.concat(sent).toString("utf8"), verdict.grant.mcpApp) : null;
                if (refusal === null)
                    return relay(answer);
                answer.resume();
                res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(refusal);
            };
            if (req.readableEnded)
                decide();
            else
                req.once("end", decide);
        });
        stats.forwarded += 1;
        forwarded.on("error", () => { if (!res.headersSent)
            res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: "upstream_unreachable" }));
        else
            res.destroy(); });
        req.pipe(forwarded);
        res.on("close", () => forwarded.destroy());
    });
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
    });
    // Node removes its own error listener from a socket it hands to `upgrade`.
    server.on("upgrade", (_req, socket) => { stats.refused += 1; socket.on("error", () => socket.destroy()); socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); });
    return new Promise((done, fail) => {
        server.once("error", fail);
        server.listen(options.socketPath, () => {
            server.off("error", fail);
            server.on("error", () => { });
            done({
                socketPath: options.socketPath,
                mintForProcess: (input) => { const minted = mint("process", input); stats.tokens = tokens.size; return minted; },
                mintForThread: (input) => { const minted = mint("thread", input); stats.tokens = tokens.size; return minted; },
                touchThread(threadId) {
                    const at = now();
                    for (const stored of tokens.values())
                        if (stored.bound === "thread" && stored.threadId === threadId)
                            stored.expiresAt = Math.max(stored.expiresAt, at + BROKER_THREAD_TTL_MS);
                },
                revoke(token) { tokens.delete(hashToken(token).toString("hex")); stats.tokens = tokens.size; },
                revokeThread(threadId) {
                    for (const [key, stored] of tokens)
                        if (stored.bound === "thread" && stored.threadId === threadId)
                            tokens.delete(key);
                    stats.tokens = tokens.size;
                },
                lookup,
                stats: () => { sweep(); stats.tokens = tokens.size; return { ...stats }; },
                close: () => new Promise((closed) => { for (const socket of sockets)
                    socket.destroy(); server.close(() => closed()); }),
            });
        });
    });
}
