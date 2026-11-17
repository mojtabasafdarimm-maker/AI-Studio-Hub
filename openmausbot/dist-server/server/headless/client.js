// Server: --url, --port, OPENMAUSBOT_URL or OMB_PORT, else the desktop ports. A credential never travels while a server
// is being looked for; it comes from OPENMAUSBOT_TOKEN or --token-file only (a command line leaks).
import { readFileSync } from "node:fs";
import { EXIT, flag, HeadlessError, usageError } from "./args.js";
const DISCOVERY_PORTS = [8799, 18799, 28799];
let mcpModule;
export async function loadMcp() {
    mcpModule ??= import("../../scripts/mcp-server.js");
    try {
        return await mcpModule;
    }
    catch (error) {
        mcpModule = undefined;
        throw usageError(`OPENMAUSBOT_URL is not usable: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/** Never printed. */
export function readToken(flags, env) {
    const file = flag(flags, "token-file");
    if (file !== undefined) {
        let token;
        try {
            token = readFileSync(file, "utf8").trim();
        }
        catch (error) {
            throw usageError(`--token-file ${file} could not be read (${error.code ?? "error"})`);
        }
        if (!token)
            throw usageError(`--token-file ${file} is empty`);
        return token;
    }
    return env.OPENMAUSBOT_TOKEN?.trim() || undefined;
}
export function namedServer(flags, env) {
    const url = flag(flags, "url")?.trim();
    if (url)
        return { url };
    const port = flag(flags, "port")?.trim();
    if (port)
        return { port };
    if (env.OPENMAUSBOT_URL?.trim())
        return { url: env.OPENMAUSBOT_URL.trim() };
    return env.OMB_PORT?.trim() ? { port: env.OMB_PORT.trim() } : undefined;
}
export async function openClient(flags, deps, mutating) {
    const mcp = await loadMcp();
    const token = readToken(flags, deps.env);
    const named = namedServer(flags, deps.env);
    let baseUrl;
    if (named && "url" in named) {
        try {
            baseUrl = mcp.validateBaseUrl(named.url);
        }
        catch (error) {
            throw usageError(error instanceof Error ? error.message : String(error));
        }
    }
    else if (named) {
        const port = Number(named.port);
        if (!Number.isInteger(port) || port < 1 || port > 65_535)
            throw usageError("--port must be 1-65535");
        baseUrl = `http://127.0.0.1:${port}`;
    }
    else {
        if (mutating && deps.requireExplicitForMutations) {
            throw usageError("mutating commands require an explicit OpenMausBot instance", "start `control-omb launch`, then pass its URL with --url");
        }
        if (token) {
            throw usageError("a token needs a named server, so it is never sent while looking for one", "pass --url (or --port), or set OPENMAUSBOT_URL or OMB_PORT");
        }
        try {
            baseUrl = await mcp.probeBaseUrls(DISCOVERY_PORTS.map((port) => `http://127.0.0.1:${port}`));
        }
        catch {
            throw new HeadlessError(`no OpenMausBot server answered on 127.0.0.1 ports ${DISCOVERY_PORTS.join(", ")}`, EXIT.unreachable, "start one with `openmausbot serve`, or name one with --url or OPENMAUSBOT_URL");
        }
    }
    const request = deps.request ?? mcp.request;
    const callTool = deps.callTool ?? mcp.handleToolCall;
    const withAuth = (init = {}) => {
        if (!token)
            return init;
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${token}`);
        return { ...init, headers };
    };
    const fetcher = (path, init = {}) => request(path, withAuth(init), baseUrl);
    return {
        baseUrl,
        explicit: named !== undefined,
        json: (path, init) => fetcher(path, init),
        async raw(path, init = {}) {
            const { stream, ...rest } = init;
            const timeout = stream ? undefined : AbortSignal.timeout(60_000);
            const signal = rest.signal && timeout ? AbortSignal.any([rest.signal, timeout]) : rest.signal ?? timeout;
            return fetch(`${baseUrl}${path}`, { ...withAuth(rest), ...(signal ? { signal } : {}) });
        },
        tool: (name, args, hooks, signal) => callTool(name, args, fetcher, signal, hooks),
    };
}
export function serverWords(message) {
    const body = /^OpenMausBot API error \(\d+\): ([\s\S]*)$/.exec(message)?.[1];
    if (body === undefined)
        return message;
    try {
        const said = JSON.parse(body).error;
        return typeof said === "string" && said.trim() ? said.trim() : message;
    }
    catch {
        return message;
    }
}
export async function explain(error, baseUrl) {
    if (error instanceof HeadlessError)
        return error;
    const mcp = await loadMcp().catch(() => undefined);
    const message = serverWords(error instanceof Error ? error.message : String(error));
    if (mcp && error instanceof mcp.ToolInputError)
        return usageError(message);
    const status = typeof error?.status === "number" ? error.status : undefined;
    if (status === 401) {
        return new HeadlessError("this server needs a credential and did not accept the one given", EXIT.unreachable, "get one with `openmausbot connect URL --out FILE`, then pass --token-file FILE or set OPENMAUSBOT_TOKEN");
    }
    if (status === 403) {
        return new HeadlessError(`not allowed: ${message}`, EXIT.unreachable, "this needs a paired session with the right scope: `openmausbot connect` mints one on this computer");
    }
    if (status === 404 && /^no such (bot|channel|conversation|task|message)\b/i.test(message)) {
        return usageError(message, "openmausbot bots and openmausbot channels list the ids");
    }
    if (/cannot report a conversation's job/.test(message))
        return new HeadlessError(message, EXIT.unreachable, "update OpenMausBot on the server");
    const cause = error?.cause?.code;
    if ((error instanceof TypeError && /fetch failed/i.test(message)) || cause === "ECONNREFUSED" || cause === "ENOTFOUND"
        || (error instanceof Error && (error.name === "TimeoutError" || /timed out|aborted due to timeout/i.test(message)))) {
        return new HeadlessError(`cannot reach OpenMausBot${baseUrl ? ` at ${baseUrl}` : ""}`, EXIT.unreachable, "check the server is running and the address is right (openmausbot doctor)");
    }
    if (error instanceof Error && error.name === "AbortError")
        return new HeadlessError("stopped", EXIT.interrupted);
    return new HeadlessError(message, EXIT.failed);
}
export async function readJob(client, threadId, query = {}) {
    try {
        return await client.json(`/api/threads/${encodeURIComponent(threadId)}/job?${new URLSearchParams(query).toString()}`);
    }
    catch (error) {
        const status = error.status;
        const message = error instanceof Error ? error.message : String(error);
        if (status === 404 && !/no such conversation/.test(message)) {
            throw new HeadlessError("this OpenMausBot server cannot report a conversation's job", EXIT.unreachable, "update OpenMausBot on the server");
        }
        throw error;
    }
}
