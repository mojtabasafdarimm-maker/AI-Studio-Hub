// Custom MCP servers reach codex as `-c mcp_servers.<name>.…` overrides, which codex merges into a
// same-named config.toml table; a stdio command over a remote `url` is "invalid configuration" and kills
// the turn, so a colliding server mounts under a name of its own.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseToml } from "../toml-lite.js";
const HEADER = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))[ \t]*[.\]]/gm;
/** Best-effort table-header names when config.toml cannot be parsed. */
export function mcpServerNamesInToml(toml) {
    const names = new Set();
    for (const match of toml.matchAll(HEADER)) {
        const name = match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2] ?? match[3];
        if (name)
            names.add(name);
    }
    return names;
}
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
export function codexConfigMcp(env) {
    const codexHome = env.CODEX_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".codex");
    let text = "";
    try {
        text = readFileSync(join(codexHome, "config.toml"), "utf8");
    }
    catch { }
    let tables = {};
    try {
        const servers = parseToml(text).mcp_servers;
        if (isRecord(servers))
            tables = servers;
        return { names: new Set(Object.keys(tables)), tables };
    }
    catch { }
    return { names: mcpServerNamesInToml(text), tables };
}
/** Disable literal config keys before mounting per-turn servers. Codex splits CLI paths at every dot, so a whole-table override preserves literal names; it must precede the per-mount CLI overrides. */
export function codexMcpDisableArgs(names) {
    if ([...names].some((name) => !/^[A-Za-z0-9_-]+$/.test(name))) {
        const tables = [...names].map((name) => `${JSON.stringify(name)} = { enabled = false }`).join(", ");
        return ["-c", `mcp_servers={ ${tables} }`];
    }
    return [...names].flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]);
}
export function codexConfigMcpServerNames(env) {
    return codexConfigMcp(env).names;
}
const texts = (value) => isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)])) : {};
const address = (url) => {
    try {
        return new URL(url).href;
    }
    catch {
        return url.trim();
    }
};
/** Whether codex already starts `server` itself from config.toml under `name`, as a server brought in from there: the
 * same command, arguments and environment, or the same address and headers. A turn without a tool selection runs
 * config.toml's servers, so mounting it as well would run it twice; one with a selection switches them off. */
export function codexConfigRunsServer(config, name, server) {
    const table = config.tables[name];
    if (!isRecord(table) || table.enabled === false)
        return false;
    if ("url" in server) {
        return typeof table.url === "string" && address(table.url) === address(server.url) && isDeepStrictEqual(texts(table.http_headers), server.headers);
    }
    const args = Array.isArray(table.args) ? table.args.map(String) : [];
    return table.command === server.command && isDeepStrictEqual(args, server.args) && isDeepStrictEqual(texts(table.env), server.env);
}
export function mountedMcpServerName(name, taken) {
    if (!taken.has(name))
        return name;
    let candidate = `${name}_openmausbot`;
    for (let i = 2; taken.has(candidate); i++)
        candidate = `${name}_openmausbot${i}`;
    return candidate;
}
