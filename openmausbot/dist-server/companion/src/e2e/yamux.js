// The yamux profile carried inside the records: one frame per record, phone-opened streams only, 2 MiB windows.
// Wire spec: companion/src/e2e/README.md, "Multiplexing". This module does no I/O, so every rule is testable.
export const VERSION = 0;
export const TYPE = { data: 0, windowUpdate: 1, ping: 2, goAway: 3 };
export const FLAG = { syn: 0x1, ack: 0x2, fin: 0x4, rst: 0x8 };
const KNOWN_FLAGS = 0xf;
/** `removed` goes only from the computer to the phone: this device was removed, and the close that follows is 4001. It
 * is inside the encryption, so unlike a bare 4001 close code a relay can't forge it. */
export const GO_AWAY = { normal: 0, protocol: 1, internal: 2, removed: 3 };
export const HEADER_BYTES = 12;
export const MAX_DATA_PAYLOAD = 65_507;
export const INITIAL_WINDOW = 256 * 1024;
export const STREAM_WINDOW = 2 * 1024 * 1024;
export const OPEN_WINDOW_DELTA = STREAM_WINDOW - INITIAL_WINDOW;
export const WINDOW_UPDATE_AFTER = 1024 * 1024;
export const MAX_STREAMS = 64;
export const MAX_STREAM_ID = 2 ** 31 - 1;
export const PING_INTERVAL_MS = 20_000;
export const PING_TIMEOUT_MS = 10_000;
export class YamuxError extends Error {
    reason;
    constructor(reason) {
        super(`yamux: ${reason}`);
        this.reason = reason;
    }
}
export function encodeFrame(frame) {
    const payload = frame.type === TYPE.data ? frame.data ?? new Uint8Array(0) : new Uint8Array(0);
    if (frame.type === TYPE.data && payload.length !== frame.length)
        throw new YamuxError("data_length");
    if (payload.length > MAX_DATA_PAYLOAD)
        throw new YamuxError("data_too_large");
    const out = Buffer.alloc(HEADER_BYTES + payload.length);
    out.writeUInt8(VERSION, 0);
    out.writeUInt8(frame.type, 1);
    out.writeUInt16BE(frame.flags, 2);
    out.writeUInt32BE(frame.streamId, 4);
    out.writeUInt32BE(frame.length, 8);
    out.set(payload, HEADER_BYTES);
    return out;
}
/** One record's plaintext is exactly one frame. Everything that can be checked without stream state is
 * checked here. */
export function decodeFrame(bytes) {
    if (bytes.length < HEADER_BYTES)
        throw new YamuxError("short_frame");
    const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.readUInt8(0) !== VERSION)
        throw new YamuxError("version");
    const type = view.readUInt8(1);
    if (type > TYPE.goAway)
        throw new YamuxError("type");
    const flags = view.readUInt16BE(2);
    if ((flags & ~KNOWN_FLAGS) !== 0)
        throw new YamuxError("flags");
    const streamId = view.readUInt32BE(4);
    const length = view.readUInt32BE(8);
    if (type === TYPE.data) {
        if (length > MAX_DATA_PAYLOAD)
            throw new YamuxError("data_too_large");
        if (bytes.length !== HEADER_BYTES + length)
            throw new YamuxError("data_length");
        if (streamId === 0)
            throw new YamuxError("stream_zero");
        return { type, flags, streamId, length, data: view.subarray(HEADER_BYTES) };
    }
    if (bytes.length !== HEADER_BYTES)
        throw new YamuxError("trailing_bytes");
    if (type === TYPE.windowUpdate) {
        if (streamId === 0)
            throw new YamuxError("stream_zero");
    }
    else {
        if (streamId !== 0)
            throw new YamuxError("session_frame_stream");
        if (type === TYPE.ping && flags !== FLAG.syn && flags !== FLAG.ack)
            throw new YamuxError("ping_flags");
        if (type === TYPE.goAway && flags !== 0)
            throw new YamuxError("goaway_flags");
    }
    return { type: type, flags, streamId, length };
}
export const openFrame = (streamId) => ({ type: TYPE.windowUpdate, flags: FLAG.syn, streamId, length: OPEN_WINDOW_DELTA });
export const acceptFrame = (streamId) => ({ type: TYPE.windowUpdate, flags: FLAG.ack, streamId, length: OPEN_WINDOW_DELTA });
export const resetFrame = (streamId) => ({ type: TYPE.windowUpdate, flags: FLAG.rst, streamId, length: 0 });
export const finFrame = (streamId) => ({ type: TYPE.windowUpdate, flags: FLAG.fin, streamId, length: 0 });
export const windowFrame = (streamId, delta) => ({ type: TYPE.windowUpdate, flags: 0, streamId, length: delta });
export const dataFrame = (streamId, data, flags = 0) => ({ type: TYPE.data, flags, streamId, length: data.length, data });
export const pingFrame = (value, flags = FLAG.syn) => ({ type: TYPE.ping, flags, streamId: 0, length: value >>> 0 });
export const goAwayFrame = (code) => ({ type: TYPE.goAway, flags: 0, streamId: 0, length: code });
/** A frame that breaks the profile throws YamuxError. The caller then sends GoAway(1) through
 * `protocolError()` and closes the WebSocket with 4000. */
export class Mux {
    role;
    #events;
    #streams = new Map();
    /** The highest ID the phone has opened. */
    #highestId = 0;
    #peerGoneAway = false;
    #localGoneAway = false;
    constructor(role, events) {
        this.role = role;
        this.#events = events;
    }
    get activeStreams() {
        return this.#streams.size;
    }
    get peerGoneAway() {
        return this.#peerGoneAway;
    }
    has(streamId) {
        return this.#streams.has(streamId);
    }
    sendWindow(streamId) {
        return this.#streams.get(streamId)?.sendWindow ?? 0;
    }
    /** The phone side. Data may follow at once, within the first 256 KiB. */
    open() {
        if (this.role !== "phone")
            throw new YamuxError("computer_open");
        if (this.#localGoneAway || this.#peerGoneAway)
            throw new YamuxError("gone_away");
        if (this.#streams.size >= MAX_STREAMS)
            throw new YamuxError("too_many_streams");
        const streamId = this.#highestId === 0 ? 1 : this.#highestId + 2;
        if (streamId > MAX_STREAM_ID)
            throw new YamuxError("ids_exhausted");
        this.#highestId = streamId;
        this.#streams.set(streamId, {
            established: false,
            receiveWindow: INITIAL_WINDOW + OPEN_WINDOW_DELTA,
            sendWindow: INITIAL_WINDOW,
            uncredited: 0,
            localFin: false,
            remoteFin: false,
        });
        this.#events.send(openFrame(streamId));
        return streamId;
    }
    /** The computer side, once the origin socket is connected. */
    accept(streamId) {
        const stream = this.#streams.get(streamId);
        if (!stream || stream.established || this.role !== "computer")
            return;
        stream.established = true;
        stream.receiveWindow += OPEN_WINDOW_DELTA;
        this.#events.send(acceptFrame(streamId));
    }
    /** Sends up to the window and the frame cap; returns the bytes taken. */
    write(streamId, data) {
        const stream = this.#streams.get(streamId);
        if (!stream || stream.localFin || (this.role === "computer" && !stream.established))
            return 0;
        const size = Math.min(data.length, stream.sendWindow, MAX_DATA_PAYLOAD);
        if (size === 0)
            return 0;
        stream.sendWindow -= size;
        this.#events.send(dataFrame(streamId, data.subarray(0, size)));
        return size;
    }
    finish(streamId) {
        const stream = this.#streams.get(streamId);
        if (!stream || stream.localFin)
            return;
        stream.localFin = true;
        this.#events.send(finFrame(streamId));
        this.#closeIfDone(streamId, stream);
    }
    reset(streamId) {
        if (!this.#streams.delete(streamId))
            return;
        this.#events.send(resetFrame(streamId));
        this.#events.reset(streamId);
    }
    /** The receiver handed `bytes` on (to the origin socket, or the HTTP stack). Grants them back in 1 MiB steps. */
    consumed(streamId, bytes) {
        const stream = this.#streams.get(streamId);
        if (!stream || stream.remoteFin)
            return;
        stream.uncredited += bytes;
        if (stream.uncredited < WINDOW_UPDATE_AFTER)
            return;
        const delta = stream.uncredited;
        stream.uncredited = 0;
        stream.receiveWindow += delta;
        this.#events.send(windowFrame(streamId, delta));
    }
    ping(value) {
        this.#events.send(pingFrame(value));
    }
    goAway(code = GO_AWAY.normal) {
        this.#localGoneAway = true;
        this.#events.send(goAwayFrame(code));
    }
    /** Sends GoAway(1); the caller closes with 4000. */
    protocolError() {
        this.goAway(GO_AWAY.protocol);
        this.closeAll();
    }
    closeAll() {
        const ids = [...this.#streams.keys()];
        this.#streams.clear();
        for (const id of ids)
            this.#events.reset(id);
    }
    receive(frame) {
        if (frame.type === TYPE.ping) {
            if (frame.flags === FLAG.syn)
                this.#events.send(pingFrame(frame.length, FLAG.ack));
            else
                this.#events.pong?.(frame.length);
            return;
        }
        if (frame.type === TYPE.goAway) {
            this.#peerGoneAway = true;
            this.#events.goAway?.(frame.length);
            return;
        }
        if (frame.flags & FLAG.syn) {
            this.#receiveOpen(frame);
            return;
        }
        if (frame.flags & FLAG.ack) {
            this.#receiveAck(frame);
            return;
        }
        const stream = this.#known(frame.streamId);
        if (!stream)
            return;
        this.#receiveOnStream(frame.streamId, stream, frame);
    }
    /** A stream that ended is ignored: an RST and the peer's last frames cross. An ID never opened is an error. */
    #known(streamId) {
        if (streamId % 2 === 0 || streamId > this.#highestId)
            throw new YamuxError("unknown_stream");
        return this.#streams.get(streamId) ?? null;
    }
    #receiveOpen(frame) {
        if (this.role === "phone")
            throw new YamuxError("computer_opened_stream");
        if (frame.type !== TYPE.windowUpdate || frame.flags !== FLAG.syn)
            throw new YamuxError("open_flags");
        if (frame.streamId % 2 === 0)
            throw new YamuxError("even_stream");
        if (frame.streamId <= this.#highestId)
            throw new YamuxError("stream_reused");
        this.#highestId = frame.streamId;
        if (this.#localGoneAway || this.#streams.size >= MAX_STREAMS) {
            this.#events.send(resetFrame(frame.streamId));
            return;
        }
        this.#streams.set(frame.streamId, {
            established: false,
            receiveWindow: INITIAL_WINDOW,
            sendWindow: INITIAL_WINDOW + frame.length,
            uncredited: 0,
            localFin: false,
            remoteFin: false,
        });
        this.#events.opened?.(frame.streamId);
    }
    #receiveAck(frame) {
        if (this.role === "computer")
            throw new YamuxError("phone_ack");
        if (frame.type !== TYPE.windowUpdate || (frame.flags & ~(FLAG.ack | FLAG.fin | FLAG.rst)) !== 0)
            throw new YamuxError("ack_flags");
        const stream = this.#known(frame.streamId);
        if (!stream)
            return;
        if (stream.established)
            throw new YamuxError("duplicate_ack");
        stream.established = true;
        this.#events.accepted?.(frame.streamId);
        this.#receiveOnStream(frame.streamId, stream, { ...frame, flags: frame.flags & ~FLAG.ack });
    }
    #receiveOnStream(streamId, stream, frame) {
        if (frame.flags & FLAG.rst) {
            this.#streams.delete(streamId);
            this.#events.reset(streamId);
            return;
        }
        if (frame.type === TYPE.data) {
            if (stream.remoteFin && (frame.length > 0 || frame.flags & FLAG.fin))
                throw new YamuxError("data_after_fin");
            if (frame.length > stream.receiveWindow)
                throw new YamuxError("window_exceeded");
            stream.receiveWindow -= frame.length;
            if (frame.length > 0)
                this.#events.data(streamId, frame.data);
        }
        else if (frame.length > 0) {
            stream.sendWindow += frame.length;
            this.#events.writable(streamId);
        }
        if (frame.flags & FLAG.fin) {
            if (stream.remoteFin)
                throw new YamuxError("data_after_fin");
            stream.remoteFin = true;
            this.#events.ended(streamId);
            this.#closeIfDone(streamId, stream);
        }
    }
    #closeIfDone(streamId, stream) {
        if (stream.localFin && stream.remoteFin)
            this.#streams.delete(streamId);
    }
}
