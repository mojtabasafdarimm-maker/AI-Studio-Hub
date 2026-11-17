// What of this server a box may reach: only the harness routes under /api/internal/, which every engine helper (the
// agents, browser, computer, connectors and hook proxies) calls with a per-turn capability bearer. A loopback port inside
// the box, at the server's own port number, is bridged to this unix socket, so OMB_HARNESS_URL needs no change; every
// other route of the server answers 403 here before it is ever asked.
import { createServer, request as httpRequest } from "node:http";
export const HARNESS_GATE_PREFIX = "/api/internal/";
/** The path and query to forward for a request target, or null to refuse it. The prefix check runs on the WHATWG-parsed
 * pathname, the form the server routes on (`%2e%2e` is a dot segment there), and only that form is forwarded. */
export function harnessTarget(url, allow = [HARNESS_GATE_PREFIX]) {
    const raw = url.split("?")[0];
    if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("..") || raw.includes("\\"))
        return null;
    let parsed;
    try {
        parsed = new URL(url, "http://127.0.0.1");
    }
    catch {
        return null;
    }
    return allow.some((prefix) => parsed.pathname.startsWith(prefix)) ? parsed.pathname + parsed.search : null;
}
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-connection"]);
export function openHarnessGate(options) {
    const allow = options.allow ?? [HARNESS_GATE_PREFIX];
    const sockets = new Set();
    const gate = { socketPath: options.socketPath, refused: 0 };
    const server = createServer((req, res) => {
        const target = harnessTarget(req.url ?? "", allow);
        if (target === null) {
            gate.refused += 1;
            res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "not_a_harness_route" }));
            req.resume();
            return;
        }
        const headers = {};
        for (const [name, value] of Object.entries(req.headers))
            if (value !== undefined && !HOP_BY_HOP.has(name))
                headers[name] = value;
        headers.host = `127.0.0.1:${options.port}`;
        const upstream = httpRequest({ host: "127.0.0.1", port: options.port, method: req.method, path: target, headers }, (answer) => {
            const out = {};
            for (const [name, value] of Object.entries(answer.headers))
                if (value !== undefined && !HOP_BY_HOP.has(name))
                    out[name] = value;
            res.writeHead(answer.statusCode ?? 502, out);
            answer.pipe(res);
        });
        upstream.on("error", () => {
            if (!res.headersSent)
                res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: "harness_unreachable" }));
            else
                res.destroy();
        });
        req.pipe(upstream);
        res.on("close", () => upstream.destroy());
    });
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
    });
    // Nothing upgrades through the gate: the harness routes are plain requests and event streams.
    // Node removes its own error listener from a socket it hands to `upgrade`.
    server.on("upgrade", (_req, socket) => { gate.refused += 1; socket.on("error", () => socket.destroy()); socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); });
    return new Promise((done, fail) => {
        server.once("error", fail);
        server.listen(options.socketPath, () => {
            server.off("error", fail);
            server.on("error", () => { });
            gate.close = () => new Promise((closed) => {
                for (const socket of sockets)
                    socket.destroy();
                server.close(() => closed());
            });
            done(gate);
        });
    });
}
