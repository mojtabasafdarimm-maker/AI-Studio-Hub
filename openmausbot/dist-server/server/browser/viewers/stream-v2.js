import { WebSocketServer } from "ws";
import { hostSetupOf } from "../chrome/host-setup.js";
import { FRAME_CAP_LIMITS } from "./core.js";
import { requestedSize } from "./viewport.js";
import { displayUrl } from "./live-v1.js";
/** Close codes the stream client acts on. */
export const STREAM_CLOSE = {
    /** The browser this view showed is gone for good (another profile, the browser turned off): the client stops. */
    gone: 4404,
    /** The host cannot run Chrome until it is set up; the reason says how. */
    hostSetup: 4503,
    /** The browser closed or restarted while the view stays valid: the client reconnects. */
    reconnect: 1012,
    /** Too many views are open; the client tries again later. */
    busy: 1013,
    /** The browser could not start. */
    failed: 1011,
};
const DEFAULT_QUALITY = 70;
const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_UNACKNOWLEDGED_FRAMES = 64;
const MAX_MESSAGE_BYTES = 64 * 1024;
const VIEWERS_PER_PROFILE = 4;
const VIEWERS_TOTAL = 16;
const RECHECK_MS = 5_000;
/** A client that does not answer the server's close frame is cut off this long after it was sent. */
const CLOSE_GRACE_MS = 2_000;
const GONE = "This browser view is no longer available.";
const PING_MS = 15_000;
/** The close code of a connection that broke without a close frame. */
const ABNORMAL_CLOSE = 1006;
/** Input that arrives while the viewer is still attaching (its control state is already on the wire) waits for it. */
const EARLY_INPUT_LIMIT = 64;
const intParam = (params, name, fallback, max) => {
    const value = Number(params.get(name));
    return Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), max) : fallback;
};
const isAck = (message) => typeof message === "object" && message !== null && message.type === "ack";
const parseMessage = (data) => {
    try {
        return JSON.parse(Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data).toString("utf8"));
    }
    catch {
        return null;
    }
};
/** A viewer's output as the client reads it: frames go as bytes, the rest as `{type, ...}`. */
export function wireMessage(output) {
    switch (output.type) {
        case "tabs":
            return { type: "tabs", tabs: output.tabs.map((tab) => ({ ...tab, url: displayUrl(tab.url) })) };
        case "url":
        case "nav":
            return { ...output, url: displayUrl(output.url) };
        case "status":
            return null;
        default:
            return { ...output };
    }
}
class StreamSession {
    request;
    ws;
    unacknowledged = [];
    viewer = null;
    closed = false;
    /** Its connection broke, rather than the panel closing it. */
    lost = false;
    /** The server is closing this view: nothing the client sends reaches the browser any more. */
    closing = false;
    #early = [];
    #restarting = false;
    constructor(request, ws) {
        this.request = request;
        this.ws = ws;
    }
    /** A viewer that stops reading is cut off rather than buffered for. */
    kill() {
        this.request.socket.destroy();
    }
    #fits(bytes) {
        // Include the WebSocket frame header in the budget.
        return this.ws.bufferedAmount + bytes + 14 <= MAX_SOCKET_BUFFER_BYTES;
    }
    push(output) {
        if (this.closed || this.closing) {
            if (output.type === "frame")
                output.ack();
            return;
        }
        if (output.type === "frame") {
            if (this.unacknowledged.length >= MAX_UNACKNOWLEDGED_FRAMES || !this.#fits(output.data.byteLength)) {
                output.ack();
                this.kill();
                return;
            }
            this.unacknowledged.push(output.ack);
            this.ws.send(output.data, { binary: true });
            return;
        }
        if (output.type === "gone") {
            this.close(STREAM_CLOSE.reconnect, "reconnect", { dropped: true });
            return;
        }
        const message = wireMessage(output);
        if (!message)
            return;
        const text = JSON.stringify(message);
        if (!this.#fits(Buffer.byteLength(text))) {
            this.kill();
            return;
        }
        this.ws.send(text);
    }
    /** A notice the person should read, such as why a restart was refused. */
    notice(message) {
        if (!this.closed && !this.closing)
            this.ws.send(JSON.stringify({ type: "notice", message }));
    }
    receive(data, binary, service) {
        if (binary)
            return;
        const message = parseMessage(data);
        if (isAck(message)) {
            // Chromium's acknowledgement is paced by the viewer, and never holds up input.
            this.unacknowledged.shift()?.();
            return;
        }
        // Ownership serializes actions in the service. Keep reading so dialog replies and takeover can unblock an action
        // already waiting on the page.
        if (!this.request.canOperate || this.closing)
            return;
        // Security: every message is checked as every v1 action is, so a person signed out or no longer allowed to see the
        // bot never acts on its browser again.
        if (!this.request.isCurrent()) {
            this.close(STREAM_CLOSE.gone, GONE);
            return;
        }
        if (!this.viewer) {
            if (this.#early.length < EARLY_INPUT_LIMIT)
                this.#early.push(message);
            return;
        }
        this.#input(message, service);
    }
    attached(viewer, service) {
        this.viewer = viewer;
        for (const message of this.#early.splice(0))
            this.#input(message, service);
    }
    #input(message, service) {
        if (message?.type === "restart") {
            void this.#restart(service);
            return;
        }
        void this.viewer?.input(message);
    }
    async #restart(service) {
        const refused = this.request.restartRefusal();
        if (refused) {
            this.notice(refused);
            return;
        }
        if (this.#restarting || !this.viewer || this.closing)
            return;
        this.#restarting = true;
        try {
            await service.restart(this.request.target.session, this.viewer.options.person);
        }
        catch {
            this.notice("The browser could not restart. Wait for active work to finish and try again.");
        }
        finally {
            this.#restarting = false;
        }
    }
    /** Lets the viewer go at once, and its held input, then tells the client why and cuts it off. `dropped`: the client comes
     * straight back, so a hold of its person waits for it. */
    close(code, reason, { dropped = false } = {}) {
        if (this.closed || this.closing)
            return;
        this.closing = true;
        void this.viewer?.close({ dropped }).catch(() => undefined);
        try {
            this.ws.close(code, reason.slice(0, 120));
        }
        catch {
            this.kill();
            return;
        }
        setTimeout(() => this.kill(), CLOSE_GRACE_MS).unref();
    }
    /** Releases Chromium from every frame still in flight and lets the viewer go. `lost`: the connection broke rather
     * than the panel closing it, so a hold of its person waits the grace for their next view. */
    ended(lost) {
        if (this.closed)
            return;
        this.closed = true;
        this.lost = lost;
        for (const ack of this.unacknowledged.splice(0))
            ack();
        void this.viewer?.close({ dropped: lost && this.theirs() }).catch(() => undefined);
    }
    /** Still the view of a person allowed to see this browser: its stream went, not its sign-in. */
    theirs() {
        try {
            return this.request.isCurrent();
        }
        catch {
            return false;
        }
    }
}
/** Every v2 view of the bots' browsers on this server. */
export class StreamV2 {
    #service;
    #sessions = new Set();
    #server = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_MESSAGE_BYTES });
    constructor({ service }) {
        this.#service = service;
    }
    /** Answers the handshake and streams. Frames are JPEGs already, so no deflate, which also keeps every pending write in the socket buffer bounded here. */
    open(request) {
        const perProfile = [...this.#sessions].filter((session) => session.request.target.key === request.target.key).length;
        const busy = this.#sessions.size >= VIEWERS_TOTAL || perProfile >= VIEWERS_PER_PROFILE;
        this.#server.handleUpgrade(request.req, request.socket, request.head, (ws) => {
            const session = new StreamSession(request, ws);
            if (busy) {
                session.closed = true;
                ws.close(STREAM_CLOSE.busy, "Too many browser views are open. Close another browser panel first.");
                return;
            }
            this.#sessions.add(session);
            void this.#serve(session);
        });
    }
    async #serve(session) {
        const { request, ws } = session;
        let alive = true;
        const ping = setInterval(() => {
            if (!alive) {
                session.kill();
                return;
            }
            alive = false;
            try {
                ws.ping();
            }
            catch { }
        }, PING_MS);
        ping.unref();
        const recheck = setInterval(() => {
            if (!request.isCurrent())
                session.close(STREAM_CLOSE.gone, GONE);
        }, RECHECK_MS);
        recheck.unref();
        ws.on("pong", () => { alive = true; });
        ws.on("message", (data, binary) => session.receive(data, binary, this.#service));
        ws.on("error", () => session.kill());
        // 1006: no close frame came, as when a phone goes to the background or the network drops; a panel that closes says so.
        ws.once("close", (code) => {
            clearInterval(ping);
            clearInterval(recheck);
            this.#sessions.delete(session);
            session.ended(code === ABNORMAL_CLOSE);
        });
        const params = request.params;
        const size = requestedSize(Number(params.get("width")), Number(params.get("height")));
        const options = {
            owner: request.owner,
            ...(request.person ? { person: request.person } : {}),
            canOperate: request.canOperate,
            maxWidth: intParam(params, "maxWidth", 1280, FRAME_CAP_LIMITS.maxWidth),
            maxHeight: intParam(params, "maxHeight", 800, FRAME_CAP_LIMITS.maxHeight),
            quality: intParam(params, "quality", DEFAULT_QUALITY, 100),
            pace: "hi",
            authPrompts: true,
            pagePopups: true,
            ...(size && request.canOperate ? { size } : {}),
        };
        try {
            const viewer = await this.#service.attachViewer(request.target, options, (output) => session.push(output));
            if (session.closed || session.closing)
                await viewer.close({ dropped: session.lost && session.theirs() });
            else
                session.attached(viewer, this.#service);
        }
        catch (error) {
            // The viewer knows the fix for each need: a close reason holds at most 123 bytes, too few for the steps link.
            const host = hostSetupOf(error);
            if (host)
                session.close(STREAM_CLOSE.hostSetup, JSON.stringify({ need: host.kind }));
            else
                session.close(STREAM_CLOSE.failed, "The browser could not start.");
        }
    }
    get size() {
        return this.#sessions.size;
    }
    closeForSession(session) { this.#closeWhere((request) => request.target.session === session); }
    closeForOwner(owner) { this.#closeWhere((request) => request.owner === owner); }
    closeForBot(botId) { this.#closeWhere((request) => request.botId === botId); }
    closeAll() { this.#closeWhere(() => true); }
    /** Closes now every view the 5 s recheck would close. */
    recheck() { for (const session of this.#sessions)
        if (!session.request.isCurrent())
            session.close(STREAM_CLOSE.gone, GONE); }
    #closeWhere(match) {
        for (const session of this.#sessions)
            if (match(session.request))
                session.close(STREAM_CLOSE.gone, "This browser view closed.");
    }
}
