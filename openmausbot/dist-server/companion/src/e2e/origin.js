// Where each encrypted stream lands: the same proxy handler as every other listener (allowlist, device-token auth,
// gzip, WebSocket upgrades), reached in memory. Nothing listens on a port or a path, so nothing else can connect.
import { createServer } from "node:http";
import { duplexPair } from "node:stream";
import { gzipTunnelReplies } from "../tunnel-gzip.js";
const contexts = new WeakMap();
/** The session a request arrived through, or null for any other listener. */
export const e2eContextOf = (socket) => (socket ? contexts.get(socket) ?? null : null);
/** The parts of net.Socket an http.Server and the proxy call. Idle time counts reads, which is what the server's
 * keep-alive timeout waits on. */
function socketLike(socket) {
    let idleMs = 0;
    let timer = null;
    const arm = () => {
        if (timer)
            clearTimeout(timer);
        timer = idleMs > 0 ? setTimeout(() => socket.emit("timeout"), idleMs) : null;
        timer?.unref?.();
    };
    socket.on("data", arm);
    socket.on("close", () => {
        if (timer)
            clearTimeout(timer);
    });
    return Object.assign(socket, {
        setTimeout(ms, listener) {
            idleMs = ms;
            if (listener)
                socket.once("timeout", listener);
            arm();
            return socket;
        },
        setNoDelay: () => socket,
        setKeepAlive: () => socket,
    });
}
/** Each stream must send complete request headers within `headersMs` of opening or of its last response, and a request's
 * whole body within `requestMs`; otherwise the stream is destroyed. */
function enforceDeadlines(server, deadlines) {
    const timers = new WeakMap();
    const onRequest = (req, res) => {
        const guard = timers.get(req.socket);
        if (!guard)
            return;
        guard.clear();
        // Only an unfinished request: a handler that never reads a GET (an event stream, a download) leaves it unconsumed.
        const body = setTimeout(() => {
            if (!req.complete)
                req.socket.destroy();
        }, deadlines.requestMs);
        body.unref?.();
        const done = () => clearTimeout(body);
        req.once("end", done);
        req.once("close", done);
        res?.once("finish", () => guard.arm());
    };
    server.on("request", onRequest);
    server.on("upgrade", (req) => {
        timers.get(req.socket)?.clear();
    });
    return (socket) => {
        let timer = null;
        const clear = () => {
            if (timer)
                clearTimeout(timer);
            timer = null;
        };
        const arm = () => {
            clear();
            timer = setTimeout(() => socket.destroy(), deadlines.headersMs);
            timer.unref?.();
        };
        socket.once("close", clear);
        timers.set(socket, { arm, clear });
        arm();
    };
}
export function createE2EOrigin(handle, upgrade, deadlines) {
    // Gzipped like the tunnel listener: the relay hop is the person's home upload too.
    const server = createServer(gzipTunnelReplies(handle));
    server.on("upgrade", upgrade);
    const guard = deadlines ? enforceDeadlines(server, deadlines) : null;
    return {
        connect(context) {
            const [near, far] = duplexPair();
            const serverSide = socketLike(far);
            contexts.set(serverSide, context);
            guard?.(serverSide);
            server.emit("connection", serverSide);
            return Promise.resolve(near);
        },
        close() {
            server.closeAllConnections();
        },
    };
}
