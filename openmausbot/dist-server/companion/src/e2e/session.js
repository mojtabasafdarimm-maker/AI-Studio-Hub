// One encrypted session over any message transport: the handshake, then records carrying yamux frames, each stream
// a Node Duplex. The computer pipes every stream to its own origin socket; the phone hands streams to an HTTP stack.
import { Duplex } from "node:stream";
import { CLOSE, computerAccept, encodePayload1, HANDSHAKE_DEADLINE_MS, newConn, NoiseError, NONCE_LIMIT, phoneHello, } from "./noise.js";
import { b64u } from "./credentials.js";
import { decodeFrame, encodeFrame, GO_AWAY, Mux, PING_INTERVAL_MS, PING_TIMEOUT_MS, YamuxError } from "./yamux.js";
/** A sender stops writing records while the socket holds more than this. */
export const SEND_BUFFER_HIGH = 1024 * 1024;
export class SessionClosed extends Error {
    code;
    constructor(code) {
        super(`e2e session closed (${code})`);
        this.code = code;
    }
}
const noop = () => { };
export class MuxStream extends Duplex {
    streamId;
    #session;
    #pending = null;
    #pendingDone = null;
    #ungranted = 0;
    constructor(session, streamId) {
        super({ allowHalfOpen: true, readableHighWaterMark: 256 * 1024 });
        this.#session = session;
        this.streamId = streamId;
        // A reset reaches whoever listens; without a listener it must not take the process down.
        this.on("error", noop);
    }
    _write(chunk, _encoding, done) {
        this.#pending = chunk;
        this.#pendingDone = done;
        this.flush();
    }
    _final(done) {
        this.#session.mux?.finish(this.streamId);
        done();
    }
    _read() {
        if (this.#ungranted === 0)
            return;
        const bytes = this.#ungranted;
        this.#ungranted = 0;
        this.#session.mux?.consumed(this.streamId, bytes);
    }
    _destroy(error, done) {
        const mux = this.#session.mux;
        if (mux?.has(this.streamId))
            mux.reset(this.streamId);
        this.#session.forget(this.streamId);
        const pendingDone = this.#pendingDone;
        this.#pending = null;
        this.#pendingDone = null;
        pendingDone?.(error ?? new Error("stream reset"));
        done(error);
    }
    /** Granted back as the reader takes it, so a slow reader slows the sender. */
    deliver(data) {
        if (this.push(data))
            this.#session.mux?.consumed(this.streamId, data.length);
        else
            this.#ungranted += data.length;
    }
    remoteEnded() {
        this.push(null);
    }
    remoteReset() {
        if (!this.destroyed)
            this.destroy(new Error("stream reset"));
    }
    flush() {
        const mux = this.#session.mux;
        while (this.#pending && this.#pending.length > 0) {
            if (!mux || !mux.has(this.streamId))
                return void this.destroy(new Error("stream reset"));
            if (this.#session.congested)
                return this.#session.whenDrained(() => this.flush());
            const taken = mux.write(this.streamId, this.#pending);
            if (taken === 0)
                return;
            this.#pending = this.#pending.subarray(taken);
        }
        const done = this.#pendingDone;
        this.#pending = null;
        this.#pendingDone = null;
        done?.();
    }
}
export class E2ESession {
    role;
    #transport;
    #streams = new Map();
    #timers;
    #state = "handshake";
    #keys = null;
    #mux = null;
    #accept = null;
    #deadline = null;
    #pingTimer = null;
    #pongTimer = null;
    #awaitingPong = null;
    #pingCounter = 0;
    #drainWaiters = [];
    #settleReady;
    #settleClosed;
    #connectOrigin = null;
    #removed = false;
    /** The computer side: which device (or pairing window) this is. */
    peer = null;
    ready;
    closed;
    constructor(role, transport, timers) {
        this.role = role;
        this.#transport = transport;
        this.#timers = {
            pingIntervalMs: timers.pingIntervalMs ?? PING_INTERVAL_MS,
            pingTimeoutMs: timers.pingTimeoutMs ?? PING_TIMEOUT_MS,
            handshakeDeadlineMs: timers.handshakeDeadlineMs ?? HANDSHAKE_DEADLINE_MS,
        };
        this.ready = new Promise((resolve, reject) => {
            this.#settleReady = (error) => (error ? reject(error) : resolve());
        });
        this.ready.catch(noop);
        this.closed = new Promise((resolve) => {
            this.#settleClosed = resolve;
        });
        this.#deadline = setTimeout(() => this.close(CLOSE.deadline), this.#timers.handshakeDeadlineMs);
        this.#deadline.unref?.();
    }
    /** Waits for message 1. Anything wrong with it closes 4001 and nothing else is sent. */
    static computer(options) {
        const session = new E2ESession("computer", options.transport, options);
        session.#connectOrigin = options.connectOrigin;
        session.#accept = (message) => {
            const accepted = computerAccept({ staticKey: options.staticKey, transport: options.transportByte, candidates: options.candidates() }, message);
            if (!accepted)
                return session.close(CLOSE.rejected);
            options.transport.send(accepted.message2);
            session.peer = accepted.id;
            session.#start(accepted.keys);
            options.opened?.(accepted.id, accepted.payload1);
        };
        return session;
    }
    /** Sends message 1 now. `ready` rejects with a NoiseError when the computer can't be verified: a hard stop. */
    static phone(options) {
        const session = new E2ESession("phone", options.transport, options);
        const conn = newConn();
        const hello = phoneHello({ remoteStatic: options.remoteStatic, psk: options.psk, transport: options.transportByte, ephemeral: options.ephemeral }, encodePayload1(conn, options.app), b64u(conn));
        session.#accept = (message) => {
            let keys;
            try {
                keys = hello.finish(message);
            }
            catch (error) {
                session.#settleReady(error);
                return session.close(CLOSE.protocol);
            }
            session.#start(keys);
        };
        options.transport.send(hello.message1);
        return session;
    }
    get mux() {
        return this.#mux;
    }
    /** The phone side: the computer said, inside the encryption, that this device was removed. Only this, or a 4001 on
     * a direct route, means "pair again"; a bare 4001 through the relay may be the relay's own and means "keep trying". */
    get removed() {
        return this.#removed;
    }
    get state() {
        return this.#state;
    }
    /** Records each way so far, for diagnostics. */
    get records() {
        return { sent: this.#keys?.send.nonce ?? 0, received: this.#keys?.receive.nonce ?? 0 };
    }
    get congested() {
        return this.#transport.bufferedAmount > SEND_BUFFER_HIGH;
    }
    get activeStreams() {
        return this.#streams.size;
    }
    whenDrained(listener) {
        this.#drainWaiters.push(listener);
        if (this.#drainWaiters.length > 1)
            return;
        this.#transport.onceDrained(() => {
            const waiters = this.#drainWaiters;
            this.#drainWaiters = [];
            for (const waiter of waiters)
                waiter();
        });
    }
    forget(streamId) {
        this.#streams.delete(streamId);
    }
    /** Every message the transport receives, in order. */
    receive(message, binary) {
        if (this.#state === "closed")
            return;
        if (this.#state === "handshake") {
            const accept = this.#accept;
            this.#accept = null;
            if (!binary || !accept)
                return this.close(this.role === "computer" ? CLOSE.rejected : CLOSE.protocol);
            return accept(Buffer.from(message));
        }
        if (!binary)
            return this.close(CLOSE.protocol);
        let plaintext;
        try {
            plaintext = this.#keys.receive.open(message);
        }
        catch {
            return this.close(CLOSE.protocol);
        }
        try {
            this.#mux.receive(decodeFrame(plaintext));
        }
        catch (error) {
            if (!(error instanceof YamuxError))
                throw error;
            this.#mux?.protocolError();
            this.close(CLOSE.protocol);
        }
    }
    /** The phone side. */
    openStream() {
        if (this.#state !== "open" || !this.#mux)
            throw new SessionClosed(CLOSE.normal);
        const streamId = this.#mux.open();
        const stream = new MuxStream(this, streamId);
        this.#streams.set(streamId, stream);
        return stream;
    }
    /** The computer side: the device was removed. The phone hears it authenticated, then the 4001 close. */
    remove() {
        if (this.#state === "open")
            this.#mux?.goAway(GO_AWAY.removed);
        this.close(CLOSE.rejected);
    }
    /** A planned close (quit, sleep, restart): GoAway first, so the peer knows it isn't an error. */
    shutdown() {
        if (this.#state === "open")
            this.#mux?.goAway(GO_AWAY.normal);
        this.close(CLOSE.normal);
    }
    close(code, reason) {
        if (this.#state === "closed")
            return;
        this.#transport.close(code, reason);
        this.#end(code);
    }
    /** The transport closed under us. */
    transportClosed(code) {
        this.#end(code);
    }
    #end(code) {
        if (this.#state === "closed")
            return;
        const wasHandshake = this.#state === "handshake";
        this.#state = "closed";
        for (const timer of [this.#deadline, this.#pongTimer])
            if (timer)
                clearTimeout(timer);
        if (this.#pingTimer)
            clearInterval(this.#pingTimer);
        this.#mux?.closeAll();
        for (const stream of this.#streams.values())
            stream.remoteReset();
        this.#streams.clear();
        const waiters = this.#drainWaiters;
        this.#drainWaiters = [];
        for (const waiter of waiters)
            waiter();
        if (wasHandshake)
            this.#settleReady(new SessionClosed(code));
        this.#settleClosed(code);
    }
    #start(keys) {
        if (this.#deadline)
            clearTimeout(this.#deadline);
        this.#keys = keys;
        this.#state = "open";
        this.#mux = new Mux(this.role, {
            send: (frame) => this.#send(frame),
            opened: (streamId) => this.#openOrigin(streamId),
            data: (streamId, data) => this.#streams.get(streamId)?.deliver(Buffer.from(data.buffer, data.byteOffset, data.byteLength)),
            ended: (streamId) => this.#streams.get(streamId)?.remoteEnded(),
            reset: (streamId) => {
                const stream = this.#streams.get(streamId);
                this.#streams.delete(streamId);
                stream?.remoteReset();
            },
            writable: (streamId) => this.#streams.get(streamId)?.flush(),
            goAway: (code) => {
                if (code === GO_AWAY.removed && this.role === "phone")
                    this.#removed = true;
                else if (code !== GO_AWAY.normal)
                    this.close(CLOSE.protocol);
            },
            pong: (value) => {
                if (value !== this.#awaitingPong)
                    return;
                this.#awaitingPong = null;
                if (this.#pongTimer)
                    clearTimeout(this.#pongTimer);
            },
        });
        this.#pingTimer = setInterval(() => this.#ping(), this.#timers.pingIntervalMs);
        this.#pingTimer.unref?.();
        this.#settleReady();
    }
    #ping() {
        if (this.#awaitingPong !== null || !this.#mux)
            return;
        this.#pingCounter = (this.#pingCounter + 1) >>> 0;
        this.#awaitingPong = this.#pingCounter;
        this.#mux.ping(this.#pingCounter);
        this.#pongTimer = setTimeout(() => this.close(CLOSE.goingAway), this.#timers.pingTimeoutMs);
        this.#pongTimer.unref?.();
    }
    #send(frame) {
        if (this.#state !== "open" || !this.#keys)
            return;
        let record;
        try {
            record = this.#keys.send.seal(encodeFrame(frame));
        }
        catch (error) {
            if (error instanceof NoiseError)
                return this.close(CLOSE.normal);
            throw error;
        }
        this.#transport.send(record);
        // Well before the counter could repeat; the phone reconnects.
        if (this.#keys.send.nonce >= NONCE_LIMIT - 1024)
            queueMicrotask(() => this.close(CLOSE.normal));
    }
    #openOrigin(streamId) {
        const stream = new MuxStream(this, streamId);
        this.#streams.set(streamId, stream);
        const connect = this.#connectOrigin;
        if (!connect)
            return void stream.destroy();
        connect().then((socket) => {
            if (stream.destroyed || this.#state !== "open")
                return void socket.destroy();
            this.#mux?.accept(streamId);
            socket.on("error", () => stream.destroy());
            socket.on("close", () => {
                if (!socket.readableEnded)
                    stream.destroy();
            });
            stream.on("close", () => socket.destroy());
            stream.pipe(socket);
            socket.pipe(stream);
        }, () => stream.destroy());
    }
}
