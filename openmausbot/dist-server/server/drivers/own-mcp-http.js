// OpenMausBot's own MCP servers (agents, browser, computer, data, email, device) reached by URL instead of a stdio proxy
// process each: every engine process otherwise starts one Node helper per server, about 7 threads each, all counted
// against a container's pids limit. The URL form is the endpoint those proxies forward to (routes/own-mcp-http.ts), with
// the same capability token, so identity and permissions are the stdio form's. The permission prompt server (ogb, over the
// turn's broker socket), the Android phone tools (which run adb themselves) and the person's own servers stay as they are.
import { botBox } from "../bot-box/box.js";
import { ownMcpOverHttp } from "./turn-mcp.js";
/** "1" turns the URL form on; off unless set, on every kind of server. */
export const OWN_MCP_HTTP_ENV = "OMB_OWN_MCP_HTTP";
/** Whether engines get OpenMausBot's own servers by URL: only with OMB_OWN_MCP_HTTP=1, and never while the bot box is on
 * (a boxed engine reaches this server only through the box's relays, which carry the stdio proxies' requests, not an
 * engine's own). */
export function ownMcpHttpEnabled(env = process.env, boxed = botBox.enabled()) {
    return !boxed && env[OWN_MCP_HTTP_ENV] === "1";
}
const LOOPBACK = ["127.0.0.1", "localhost", "::1"];
/** An engine set up to use a proxy for HTTP (HTTPS_PROXY, ALL_PROXY) would send its calls to this server's loopback URL
 * there too: the loopback names join NO_PROXY and no_proxy, both spellings, keeping whatever either held. */
export function withLoopbackNoProxy(env) {
    const hosts = [env.NO_PROXY, env.no_proxy].flatMap((value) => (value ?? "").split(",")).map((host) => host.trim()).filter(Boolean);
    env.NO_PROXY = env.no_proxy = [...new Set([...hosts, ...LOOPBACK])].join(",");
}
/** `http` as given; an engine that will reach this server by URL gets the loopback names in its NO_PROXY first. */
export function loopbackUnproxied(env, http) {
    if (http)
        withLoopbackNoProxy(env);
    return http;
}
/** One --mcp-config entry as Claude Code's HTTP form when it is one of OpenMausBot's own stdio proxies (Claude Code 1.0.60,
 * 2.0.0, 2.1.257 and 2.1.325 checked: `type: "http"` with headers connects and lists tools), else null. `alwaysLoad` stays. */
export function claudeOwnHttpMount(server) {
    const mount = server;
    if (!mount || typeof mount.command !== "string" || !Array.isArray(mount.args) || !mount.env || typeof mount.env !== "object")
        return null;
    const http = ownMcpOverHttp({ name: "", command: mount.command, args: mount.args.map(String), env: mount.env });
    return http ? { type: "http", url: http.url, headers: http.headers, ...(mount.alwaysLoad === true ? { alwaysLoad: true } : {}) } : null;
}
/** Turns every one of OpenMausBot's own proxies in a Claude --mcp-config into its HTTP form, when the setting is on;
 * true when any was. */
export function claudeOwnMcpOverHttp(servers, enabled = ownMcpHttpEnabled()) {
    if (!enabled)
        return false;
    let converted = false;
    for (const [name, server] of Object.entries(servers)) {
        const http = claudeOwnHttpMount(server);
        if (http) {
            servers[name] = http;
            converted = true;
        }
    }
    return converted;
}
/** ACP engine instances whose agent said, in its `initialize` answer, that it reaches MCP servers by URL
 * (`agentCapabilities.mcpCapabilities.http`). The ACP spec lets a client send an `http` server only to such an agent. */
const acpHttpAgents = new Set();
export function noteAcpMcpHttp(instanceId, init) {
    const http = init?.agentCapabilities?.mcpCapabilities?.http;
    if (http === true)
        acpHttpAgents.add(instanceId);
    else
        acpHttpAgents.delete(instanceId);
}
/** An ACP engine gets OpenMausBot's own servers by URL once its agent has said it can take them (its first session starts
 * with the stdio form), unless its servers come from the launcher's own configuration. */
export function acpOwnMcpOverHttp(instanceId, fromLaunch, enabled = ownMcpHttpEnabled()) {
    return enabled && !fromLaunch && acpHttpAgents.has(instanceId);
}
