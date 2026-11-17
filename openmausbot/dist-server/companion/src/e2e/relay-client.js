// The computer's side of MausBot Relay: one outbound control socket, and one data socket per phone session. The relay
// splices sealed bytes and can't open them; everything here is outside the encryption. Wire spec: README section 9.
import { webSocketTransport } from "./phone.js";
export const RELAY_PROTOCOL = "omb-relay.v1";
/** README section 10: 4429 means back off at least this long. */
const LIMITED_MIN_MS = 30_000;
const DEFAULT_TIMING = {
    /** Reconnect delays by failure count (± a fifth); the last repeats. */
    backoffMs: [0, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000],
    /** While on a later node, how often to try the first one again (± a fifth). */
    firstNodeRetryMs: 10 * 60_000,
    sleepCheckMs: 2_000,
    sleepJumpMs: 5_000,
    /** The pairing window expires on its own; the admission set is rechecked this often. */
    admissionCheckMs: 5_000,
    /** The backoff count resets only once a control socket has stayed connected this long. */
    stableAfterMs: 30_000,
    /** A dialled control socket with no `hello` by then is dropped and dialled again with backoff. */
    helloTimeoutMs: 15_000,
    /** A connected socket is asked to answer (a token refresh, which the relay acknowledges with `hello`) this often
     * (± a fifth), and on every `checkAlive()`. */
    livenessEveryMs: 2 * 60_000,
    /** A liveness check unanswered this long means the socket is dead: it is dropped and dialled again with backoff. */
    livenessTimeoutMs: 10_000,
    /** That redial waits a random part of this at least, so the hosts a stalled node drops at once don't all redial at
     * once. */
    redialSpreadMs: 5_000,
};
const jitter = (ms, random) => Math.round(ms * (0.8 + 0.4 * random()));
export class RelayClient {
    #options;
    #timing;
    #random;
    #nodes;
    #token;
    #control = null;
    #controlNode = 0;
    #probe = null;
    #status = "off";
    #problem = null;
    #attempt = 0;
    #stopped = true;
    #awaitingToken = false;
    #lastAdmit = "";
    #retryTimer = null;
    #retryIndex = 0;
    #firstNodeTimer = null;
    #stableTimer = null;
    #ackTimer = null;
    #livenessTimer = null;
    #intervals = [];
    constructor(options) {
        this.#options = options;
        this.#timing = { ...DEFAULT_TIMING, ...options.timing };
        this.#random = options.random ?? Math.random;
        this.#nodes = [...options.nodes];
        this.#token = options.token;
    }
    get status() {
        return this.#status;
    }
    get node() {
        return this.#status === "connected" ? this.#nodes[this.#controlNode] ?? null : null;
    }
    /** The last reason the control socket dropped or failed to connect; null once the relay acknowledged it. */
    get problem() {
        return this.#status === "off" && this.#problem !== "replaced" ? null : this.#problem;
    }
    start() {
        if (!this.#stopped)
            return;
        this.#stopped = false;
        this.#problem = null;
        this.#setStatus("connecting");
        this.#connect(0);
        let wall = Date.now();
        let mono = performance.now();
        this.#intervals.push(setInterval(() => {
            const nowWall = Date.now();
            const nowMono = performance.now();
            // A wall-clock jump the monotonic clock didn't see: the computer slept.
            const jumped = Math.abs(nowWall - wall - (nowMono - mono)) > this.#timing.sleepJumpMs;
            wall = nowWall;
            mono = nowMono;
            if (jumped)
                this.redial();
        }, this.#timing.sleepCheckMs), setInterval(() => this.refreshAdmission(), this.#timing.admissionCheckMs));
        for (const interval of this.#intervals)
            interval.unref?.();
    }
    /** Data sockets already spliced keep running; their sessions end on their own. */
    stop() {
        this.#stopped = true;
        this.#clearTimers();
        for (const interval of this.#intervals)
            clearInterval(interval);
        this.#intervals = [];
        for (const socket of [this.#control, this.#probe])
            socket?.close(1000);
        this.#control = null;
        this.#probe = null;
        this.#setStatus("off");
    }
    /** A refreshed token goes to the relay on the same socket; a refused one reconnects. */
    setToken(token, nodes) {
        this.#token = token;
        if (nodes && nodes.join(",") !== this.#nodes.join(",")) {
            this.#nodes = [...nodes];
            return this.redial();
        }
        if (this.#awaitingToken) {
            this.#awaitingToken = false;
            return this.#connect(this.#controlNode);
        }
        if (this.#status === "connected")
            this.#control?.send(JSON.stringify({ t: "auth", v: 1, token }));
    }
    /** After sleep or a resume: drop the control socket and dial the first node now. */
    redial() {
        if (this.#stopped)
            return;
        this.#clearTimers();
        const old = this.#control;
        this.#control = null;
        old?.close(1000);
        this.#attempt = 0;
        this.#setStatus("connecting");
        this.#connect(0);
    }
    /** The network changed. A connected socket must answer a liveness check or it is dialled again; a socket waiting out
     * its backoff after a failed or silent dial dials now, keeping its backoff count. A wait the relay asked for (4429,
     * 4503, `restarting`) and one for a token are kept. */
    checkAlive() {
        if (this.#stopped || this.#awaitingToken)
            return;
        if (this.#status === "connected")
            return this.#probeLiveness();
        if (!this.#retryTimer || (this.#problem !== "unreachable" && this.#problem !== "no_answer"))
            return;
        clearTimeout(this.#retryTimer);
        this.#retryTimer = null;
        this.#connect(this.#retryIndex);
    }
    /** Sends the full set whenever it differs from the last one sent. */
    refreshAdmission(force = false) {
        if (this.#status !== "connected" || !this.#control)
            return;
        const set = this.#options.admissionSet();
        const text = JSON.stringify(set);
        if (!force && text === this.#lastAdmit)
            return;
        this.#lastAdmit = text;
        this.#control.send(JSON.stringify({ t: "admit", set }));
    }
    #url(node, path) {
        return `${this.#options.baseUrl ? this.#options.baseUrl(node) : `wss://${node}`}${path}`;
    }
    #setStatus(status) {
        if (status === this.#status && status !== "connected")
            return;
        this.#status = status;
        this.#options.statusChanged?.(status, this.node);
    }
    #clearTimers() {
        for (const timer of [this.#retryTimer, this.#firstNodeTimer])
            if (timer)
                clearTimeout(timer);
        this.#retryTimer = null;
        this.#firstNodeTimer = null;
        this.#clearSocketTimers();
    }
    #clearSocketTimers() {
        for (const timer of [this.#stableTimer, this.#ackTimer, this.#livenessTimer])
            if (timer)
                clearTimeout(timer);
        this.#stableTimer = null;
        this.#ackTimer = null;
        this.#livenessTimer = null;
    }
    #timer(callback, ms) {
        const timer = setTimeout(callback, ms);
        timer.unref?.();
        return timer;
    }
    /** The relay acknowledges a token refresh on a live socket with `hello`; silence means the socket is dead. */
    #probeLiveness() {
        const socket = this.#control;
        if (!socket || this.#ackTimer || socket.readyState !== WebSocket.OPEN)
            return;
        socket.send(JSON.stringify({ t: "auth", v: 1, token: this.#token }));
        this.#ackTimer = this.#timer(() => this.#unanswered(socket), this.#timing.livenessTimeoutMs);
    }
    #scheduleLiveness() {
        if (this.#livenessTimer)
            clearTimeout(this.#livenessTimer);
        this.#livenessTimer = this.#timer(() => {
            this.#livenessTimer = null;
            this.#probeLiveness();
        }, jitter(this.#timing.livenessEveryMs, this.#random));
    }
    /** A control socket that never said `hello`, or stopped answering: dropped without waiting for its close, and
     * dialled again once, with backoff. */
    #unanswered(socket) {
        this.#ackTimer = null;
        if (socket !== this.#control || this.#stopped)
            return;
        const wasConnected = this.#status === "connected";
        this.#control = null;
        this.#clearSocketTimers();
        socket.close(1000);
        this.#problem = "no_answer";
        this.#setStatus("connecting");
        if (wasConnected)
            this.#backOff(this.#controlNode, this.#random() * this.#timing.redialSpreadMs);
        else
            this.#backOff(this.#controlNode + 1);
    }
    #backOff(index, atLeastMs = 0) {
        const ladder = this.#timing.backoffMs;
        const delay = jitter(ladder[Math.min(this.#attempt, ladder.length - 1)], this.#random);
        this.#attempt += 1;
        this.#retry(index, Math.max(atLeastMs, delay));
    }
    #connect(index, probe = false) {
        if (this.#stopped || this.#nodes.length === 0)
            return;
        const nodeIndex = index % this.#nodes.length;
        const socket = new WebSocket(this.#url(this.#nodes[nodeIndex], "/v1/host"), [RELAY_PROTOCOL]);
        if (probe)
            this.#probe = socket;
        else {
            this.#control = socket;
            this.#controlNode = nodeIndex;
            this.#clearSocketTimers();
            this.#ackTimer = this.#timer(() => this.#unanswered(socket), this.#timing.helloTimeoutMs);
        }
        socket.onopen = () => socket.send(JSON.stringify({ t: "auth", v: 1, token: this.#token }));
        socket.onmessage = (event) => {
            if (typeof event.data !== "string")
                return;
            let message;
            try {
                message = JSON.parse(event.data);
            }
            catch {
                return;
            }
            this.#onControlMessage(socket, nodeIndex, message);
        };
        socket.onclose = (event) => this.#onControlClose(socket, nodeIndex, event.code, event.reason);
        socket.onerror = () => { };
    }
    #onControlMessage(socket, nodeIndex, message) {
        if (message.t === "hello") {
            if (socket === this.#control && this.#status === "connected") {
                if (this.#ackTimer)
                    clearTimeout(this.#ackTimer);
                this.#ackTimer = null;
                return this.#scheduleLiveness();
            }
            if (socket === this.#probe) {
                // Back on the first node: the new socket first, then the old one goes.
                this.#probe = null;
                const old = this.#control;
                this.#control = socket;
                old?.close(1000);
            }
            if (socket !== this.#control)
                return;
            this.#controlNode = nodeIndex;
            this.#clearSocketTimers();
            this.#stableTimer = this.#timer(() => {
                this.#stableTimer = null;
                this.#attempt = 0;
            }, this.#timing.stableAfterMs);
            this.#problem = null;
            this.#lastAdmit = "";
            this.#setStatus("connected");
            this.refreshAdmission(true);
            this.#scheduleFirstNode();
            this.#scheduleLiveness();
            return;
        }
        if (socket !== this.#control)
            return;
        if (message.t === "open" && typeof message.sid === "string" && /^[A-Za-z0-9_-]{22}$/.test(message.sid)) {
            return this.#openData(nodeIndex, message.sid);
        }
        if (message.t === "restarting") {
            const wait = (Number(message.reconnectInMs) || 0) + this.#random() * (Number(message.tryForMs) || 15_000);
            this.#control = null;
            this.#clearSocketTimers();
            socket.close(1000);
            this.#problem = "busy";
            this.#setStatus("connecting");
            this.#retry(nodeIndex + 1, Math.min(wait, 60_000));
        }
    }
    #onControlClose(socket, nodeIndex, code, reason) {
        if (socket === this.#probe) {
            this.#probe = null;
            return this.#scheduleFirstNode();
        }
        if (socket !== this.#control || this.#stopped)
            return;
        this.#control = null;
        this.#clearSocketTimers();
        if (code === 4409) {
            this.stop();
            this.#problem = "replaced";
            return;
        }
        const wasConnected = this.#status === "connected";
        this.#problem = code === 4401 ? "token_refused" : code === 4503 || code === 4429 ? "busy" : "unreachable";
        this.#setStatus("connecting");
        if (code === 4401) {
            this.#awaitingToken = true;
            this.#controlNode = nodeIndex;
            return this.#options.tokenRejected();
        }
        if (code === 4503) {
            let retryInMs = 5_000;
            try {
                retryInMs = Number(JSON.parse(reason).retryInMs) || retryInMs;
            }
            catch {
                // The default stands.
            }
            return this.#retry(nodeIndex + 1, Math.min(retryInMs, 60_000) + this.#random() * 1_000);
        }
        this.#backOff(wasConnected ? nodeIndex : nodeIndex + 1, code === 4429 ? LIMITED_MIN_MS : 0);
    }
    #retry(index, delayMs) {
        if (this.#stopped)
            return;
        if (this.#retryTimer)
            clearTimeout(this.#retryTimer);
        this.#retryIndex = index;
        this.#retryTimer = setTimeout(() => {
            this.#retryTimer = null;
            this.#connect(index);
        }, delayMs);
        this.#retryTimer.unref?.();
    }
    #scheduleFirstNode() {
        if (this.#firstNodeTimer)
            clearTimeout(this.#firstNodeTimer);
        this.#firstNodeTimer = null;
        if (this.#controlNode === 0 || this.#stopped)
            return;
        this.#firstNodeTimer = setTimeout(() => {
            this.#firstNodeTimer = null;
            if (!this.#probe && this.#controlNode !== 0)
                this.#connect(0, true);
        }, jitter(this.#timing.firstNodeRetryMs, this.#random));
        this.#firstNodeTimer.unref?.();
    }
    #openData(nodeIndex, sid) {
        const socket = new WebSocket(this.#url(this.#nodes[nodeIndex], "/v1/host/data"), [RELAY_PROTOCOL]);
        socket.binaryType = "arraybuffer";
        let sink = null;
        socket.onopen = () => {
            socket.send(JSON.stringify({ t: "data", v: 1, sid, token: this.#token }));
            sink = this.#options.accept(webSocketTransport(socket));
        };
        socket.onmessage = (event) => {
            const binary = typeof event.data !== "string";
            sink?.receive(binary ? new Uint8Array(event.data) : Buffer.from(event.data, "utf8"), binary);
        };
        socket.onclose = (event) => sink?.transportClosed(event.code);
        socket.onerror = () => { };
    }
}
