import { BOX_NO_PROXY_ENV, BOX_PROXY_ENV, botBox } from "../bot-box/box.js";
import { tomlInlineTable } from "./codex-process.js";
import { ownMcpHttpEnabled, withLoopbackNoProxy } from "./own-mcp-http.js";
import { ownMcpOverHttp } from "./turn-mcp.js";
export function mountMcpServer(appServerArgs, env, name, server, approval = "auto", 
/** Written into the mount's own `env` table: its process gets them, Codex's command shell does not. */
literalEnv = {}, written = new Set(), 
/** More names Codex hands the server from its own environment; a name it does not have is skipped. */
forward = []) {
    const prefix = `mcp_servers.${name}`;
    if (mountOwnOverHttp(appServerArgs, env, prefix, server, approval, written))
        return;
    Object.assign(env, server.env);
    for (const name of Object.keys(server.env))
        written.add(name);
    appServerArgs.push("-c", `${prefix}.command=${JSON.stringify(server.command)}`, "-c", `${prefix}.args=${JSON.stringify(server.args)}`, 
    // argv carries names only, so credentials never appear in process listings.
    "-c", `${prefix}.env_vars=${JSON.stringify([...new Set([...Object.keys(server.env), ...forward])])}`);
    if (Object.keys(literalEnv).length)
        appServerArgs.push("-c", `${prefix}.env=${tomlInlineTable(literalEnv)}`);
    if (approval !== "prompt")
        appServerArgs.push("-c", `${prefix}.default_tools_approval_mode="${approval}"`);
}
/** In the bot box the network is reached only through the box's proxy (bot-box/box.ts), and Codex starts an MCP server with
 * just a few env names plus env_vars: a person's own stdio server would otherwise look hosts up itself and fail. */
export function boxProxyEnvNames(boxed = botBox.enabled()) {
    return boxed ? [...BOX_PROXY_ENV, ...BOX_NO_PROXY_ENV] : [];
}
/** A person's own stdio server mounted as configured gets its env only through Codex's own environment (env_vars),
 * which the bot box would otherwise cut down to its allow-list: the app-server spawn lets those names through. */
export function customServerEnvBox(custom, mounted) {
    const configured = new Set(Object.values(custom ?? {}));
    const names = [...new Set([...mounted.values()].filter((server) => configured.has(server)).flatMap((server) => Object.keys(server.env)))];
    return names.length ? { box: { allowEnv: names } } : {};
}
/** The custom env names the box admits into Codex: none with the box off, where its shell keeps what it inherited anyway. */
export function boxAdmittedEnv(custom) {
    return new Set(botBox.enabled() ? custom.box?.allowEnv : []);
}
/** One of OpenMausBot's own stdio proxies as Codex's streamable HTTP server, where that setting is on (own-mcp-http.ts):
 * no proxy process. The token stays in Codex's environment under the name the proxy read it from, and argv names it only
 * (`bearer_token_env_var`); the other headers (the agents server's settings, a tool limit) go as `http_headers`. Checked
 * on codex-cli 0.50.0, 0.80.0, 0.117.0, 0.146.0 and 0.169.0. */
function mountOwnOverHttp(appServerArgs, env, prefix, server, approval, written) {
    const http = ownMcpHttpEnabled() ? ownMcpOverHttp({ name: prefix, command: server.command, args: server.args, env: server.env }) : null;
    const tokenName = http && Object.keys(server.env).find((key) => http.headers.authorization === `Bearer ${server.env[key]}`);
    if (!http || !tokenName)
        return false;
    env[tokenName] = server.env[tokenName];
    withLoopbackNoProxy(env);
    written.add(tokenName);
    const { authorization: _token, ...headers } = http.headers;
    appServerArgs.push("-c", `${prefix}.url=${JSON.stringify(http.url)}`, "-c", `${prefix}.bearer_token_env_var=${JSON.stringify(tokenName)}`);
    if (Object.keys(headers).length)
        appServerArgs.push("-c", `${prefix}.http_headers=${tomlInlineTable(headers)}`);
    if (approval !== "prompt")
        appServerArgs.push("-c", `${prefix}.default_tools_approval_mode="${approval}"`);
    return true;
}
