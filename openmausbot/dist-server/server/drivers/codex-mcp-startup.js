/** The `mcpServer/startupStatus/updated` states that end a server's startup. */
const SETTLED_STATES = new Set(["ready", "failed", "cancelled"]);
/** Codex's own limit for one MCP server's startup (codex-rs `DEFAULT_STARTUP_TIMEOUT`), after which it reports it failed. */
export const MCP_STARTUP_WAIT_MS = 30_000;
/** Older app servers have no startup notifications. Unknown versions retain the bounded wait. */
export function supportsMcpStartup(userAgent) {
    const match = typeof userAgent === "string" ? userAgent.match(/\/(\d+)\.(\d+)\.(\d+)/) : null;
    if (!match)
        return true;
    return Number(match[1]) > 0 || Number(match[2]) >= 117;
}
/** Thread-scoped mounts override the process config; otherwise honor disabled effective entries. */
export function enabledMcpMounts(names, config, scoped) {
    if (scoped)
        return [...names];
    const servers = config?.mcp_servers;
    return names.filter((name) => servers?.[name]?.enabled !== false);
}
/**
 * Codex starts MCP servers alongside `thread/start` and `thread/resume` and does not wait for them
 * before sampling (codex-cli 0.166.0): a model request built while a server is still starting has
 * none of its tools, and the model reports them as unavailable. Codex reports every configured
 * server's startup since codex-cli 0.117.0, after its reply to the thread request.
 */
export function mcpStartupTracker(appServer) {
    const states = new Map();
    const waiters = new Set();
    const exited = new AbortController();
    appServer.once("exit", () => exited.abort());
    return {
        record(update) {
            const record = update && typeof update === "object" ? update : null;
            if (typeof record?.name !== "string" || typeof record.status !== "string")
                return;
            states.set(record.name, record.status);
            for (const wake of waiters)
                wake();
        },
        async settled(names, signal, timeoutMs = MCP_STARTUP_WAIT_MS) {
            const stop = AbortSignal.any([signal, exited.signal]);
            const done = () => names.every((name) => SETTLED_STATES.has(states.get(name) ?? ""));
            if (!stop.aborted && !done()) {
                await new Promise((resolve) => {
                    const finish = () => {
                        clearTimeout(timer);
                        waiters.delete(check);
                        stop.removeEventListener("abort", finish);
                        resolve();
                    };
                    const check = () => {
                        if (done())
                            finish();
                    };
                    const timer = setTimeout(finish, timeoutMs);
                    timer.unref?.();
                    waiters.add(check);
                    stop.addEventListener("abort", finish, { once: true });
                });
            }
            return !stop.aborted;
        },
    };
}
