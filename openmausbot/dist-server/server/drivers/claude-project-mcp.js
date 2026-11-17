import { readFileSync } from "node:fs";
import { join } from "node:path";
/** `<cwd>/.mcp.json`, forwarded verbatim because --strict-mcp-config stops the CLI reading it.
 * A malformed file is ignored. */
export function projectMcpServers(cwd) {
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
    }
    catch {
        return {};
    }
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers))
        return {};
    const out = {};
    for (const [name, server] of Object.entries(servers)) {
        if (server && typeof server === "object" && !Array.isArray(server))
            out[name] = server;
    }
    return out;
}
