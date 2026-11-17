import { inBoxSocket } from "./plan.js";
/** The command the box runs: the bridges first, then the engine. `$0` is the engine so its argv passes through unchanged.
 * `relay` is the in-box path of a relay socket; socat cannot learn its target port per connection, so it takes the Node bridge. */
export function bridgedCommand(tools, bridges, command, args, relay) {
    if (!bridges.length && !relay)
        return { command, args: [...args] };
    if (tools.socat && !relay) {
        // Each bridge keeps none of the engine's stdio: its own messages never reach the driver's stderr, and a bridge that
        // outlives the engine (only without a PID namespace) holds no pipe open.
        const lines = bridges.map((bridge) => `${shellWord(tools.socat)} TCP4-LISTEN:${bridge.port},bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:${shellWord(inBoxSocket(bridge.name))} </dev/null >/dev/null 2>&1 &`);
        // The first bridge must answer before the engine starts: its MCP proxies connect at once.
        const first = bridges[0];
        const wait = `n=0; until ${shellWord(tools.socat)} -u OPEN:/dev/null TCP4:127.0.0.1:${first.port},connect-timeout=0.2 2>/dev/null || [ "$n" -ge 100 ]; do n=$((n+1)); sleep 0.01; done`;
        const script = [...lines, wait, 'exec "$0" "$@"'].join("\n");
        return { command: "/bin/sh", args: ["-c", script, command, ...args] };
    }
    return { command: tools.node, args: [tools.bridgeScript, ...bridges.map((bridge) => `--bridge=${bridge.port}=${inBoxSocket(bridge.name)}`), ...(relay ? [`--relay=${relay}`] : []), "--", command, ...args] };
}
/** A word for /bin/sh, single-quoted. */
export function shellWord(value) {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
