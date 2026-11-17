// Noise_NKpsk0_P256_AESGCM_SHA256 (Noise Protocol Framework rev 34, with P-256 as the DH function) and the
// transport records that follow it. Wire spec: companion/src/e2e/README.md, "Handshake" and "Transport messages".
import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { b64u, fromB64u, sha256 } from "./credentials.js";
export const PROTOCOL_NAME = "Noise_NKpsk0_P256_AESGCM_SHA256";
export const PUBLIC_KEY_BYTES = 65;
export const TAG_BYTES = 16;
export const MAX_RECORD_BYTES = 65_535;
export const MAX_RECORD_PLAINTEXT = MAX_RECORD_BYTES - TAG_BYTES;
export const MAX_HANDSHAKE_PAYLOAD = 512;
export const MAX_HANDSHAKE_MESSAGE = PUBLIC_KEY_BYTES + MAX_HANDSHAKE_PAYLOAD + TAG_BYTES;
export const CONN_BYTES = 16;
export const MAX_APP_CHARS = 40;
/** A sender closes the session (1000) before a direction's counter reaches this. */
export const NONCE_LIMIT = 2 ** 32;
export const HANDSHAKE_DEADLINE_MS = 10_000;
export const TRANSPORT_RELAY = 0x01;
export const TRANSPORT_DIRECT = 0x02;
export const CLOSE = {
    normal: 1000,
    goingAway: 1001,
    protocol: 4000,
    rejected: 4001,
    deadline: 4002,
};
/** Every handshake or record failure. The reason is for tests and local logs; it never goes on the wire. */
export class NoiseError extends Error {
    reason;
    constructor(reason) {
        super(`e2e: ${reason}`);
        this.reason = reason;
    }
}
export function prologue(transport) {
    return Buffer.concat([Buffer.from("omb-e2e/1", "utf8"), Buffer.from([0x00, transport])]);
}
const ecdh = (privateKey) => {
    const curve = createECDH("prime256v1");
    if (privateKey)
        curve.setPrivateKey(privateKey);
    else
        curve.generateKeys();
    return curve;
};
/** Throws for a scalar outside [1, n). */
export function keyPairFromPrivate(privateKey) {
    if (privateKey.length !== 32)
        throw new NoiseError("bad_private_key");
    return { privateKey: Buffer.from(privateKey), publicKey: ecdh(privateKey).getPublicKey(null, "uncompressed") };
}
export function generateKeyPair() {
    const curve = ecdh();
    const raw = curve.getPrivateKey();
    return { privateKey: Buffer.concat([Buffer.alloc(32 - raw.length), raw]), publicKey: curve.getPublicKey(null, "uncompressed") };
}
/** The 32-byte X coordinate of the shared point. Only the 65-byte uncompressed form: OpenSSL also accepts
 * compressed and hybrid encodings, which the wire forbids. OpenSSL rejects off-curve points and coordinates at
 * or above p. */
export function dh(privateKey, publicKey) {
    if (publicKey.length !== PUBLIC_KEY_BYTES || publicKey[0] !== 0x04)
        throw new NoiseError("bad_point");
    try {
        return ecdh(privateKey).computeSecret(publicKey);
    }
    catch {
        throw new NoiseError("bad_point");
    }
}
const CHECK_SCALAR = Buffer.alloc(32, 1);
export function isPublicKey(bytes) {
    try {
        dh(CHECK_SCALAR, bytes);
        return true;
    }
    catch {
        return false;
    }
}
/** Noise's HKDF is RFC 5869 HKDF-SHA256 with the chaining key as salt and empty info. */
export function hkdf(chainingKey, ikm, outputs) {
    const out = Buffer.from(hkdfSync("sha256", ikm, chainingKey, Buffer.alloc(0), 32 * outputs));
    return Array.from({ length: outputs }, (_, index) => out.subarray(index * 32, index * 32 + 32));
}
export function nonceBytes(n) {
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64BE(BigInt(n), 4);
    return nonce;
}
export function aeadSeal(key, n, ad, plaintext) {
    const cipher = createCipheriv("aes-256-gcm", key, nonceBytes(n), { authTagLength: TAG_BYTES });
    cipher.setAAD(ad);
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}
export function aeadOpen(key, n, ad, ciphertext) {
    if (ciphertext.length < TAG_BYTES)
        throw new NoiseError("short_ciphertext");
    const decipher = createDecipheriv("aes-256-gcm", key, nonceBytes(n), { authTagLength: TAG_BYTES });
    decipher.setAAD(ad);
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES));
    try {
        return Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_BYTES)), decipher.final()]);
    }
    catch {
        throw new NoiseError("aead");
    }
}
export class CipherState {
    #key;
    #n;
    /** `n` other than 0 is for tests of the counter limit. */
    constructor(key = null, n = 0) {
        this.#key = key;
        this.#n = n;
    }
    get hasKey() {
        return this.#key !== null;
    }
    get nonce() {
        return this.#n;
    }
    /** Test-only view of the key, for the vectors. */
    get keyBytes() {
        return this.#key;
    }
    encryptWithAd(ad, plaintext) {
        if (!this.#key)
            return Buffer.from(plaintext);
        if (this.#n >= NONCE_LIMIT)
            throw new NoiseError("nonce_exhausted");
        const out = aeadSeal(this.#key, this.#n, ad, plaintext);
        this.#n += 1;
        return out;
    }
    /** The counter moves only on success; any failure ends the session anyway. */
    decryptWithAd(ad, ciphertext) {
        if (!this.#key)
            return Buffer.from(ciphertext);
        if (this.#n >= NONCE_LIMIT)
            throw new NoiseError("nonce_exhausted");
        const out = aeadOpen(this.#key, this.#n, ad, ciphertext);
        this.#n += 1;
        return out;
    }
}
export class SymmetricState {
    ck;
    h;
    cipher = new CipherState();
    trace;
    constructor(h, ck, trace) {
        this.h = h;
        this.ck = ck;
        this.trace = trace;
    }
    static initialize(trace = null) {
        const name = Buffer.from(PROTOCOL_NAME, "utf8");
        const h = name.length <= 32 ? Buffer.concat([name, Buffer.alloc(32 - name.length)]) : sha256(name);
        return new SymmetricState(h, Buffer.from(h), trace);
    }
    clone() {
        const copy = new SymmetricState(Buffer.from(this.h), Buffer.from(this.ck), this.trace ? [...this.trace] : null);
        copy.cipher = this.cipher;
        return copy;
    }
    mark(step) {
        this.trace?.push({ step, h: this.h.toString("hex"), ck: this.ck.toString("hex"), k: this.cipher.keyBytes?.toString("hex") ?? null });
    }
    mixHash(data) {
        this.h = sha256(Buffer.concat([this.h, data]));
    }
    mixKey(ikm) {
        const [ck, key] = hkdf(this.ck, ikm, 2);
        this.ck = ck;
        this.cipher = new CipherState(key);
    }
    mixKeyAndHash(ikm) {
        const [ck, tempH, key] = hkdf(this.ck, ikm, 3);
        this.ck = ck;
        this.mixHash(tempH);
        this.cipher = new CipherState(key);
    }
    encryptAndHash(plaintext) {
        const out = this.cipher.encryptWithAd(this.h, plaintext);
        this.mixHash(out);
        return out;
    }
    decryptAndHash(ciphertext) {
        const out = this.cipher.decryptWithAd(this.h, ciphertext);
        this.mixHash(ciphertext);
        return out;
    }
    /** k_pc then k_cp. */
    split() {
        const [first, second] = hkdf(this.ck, Buffer.alloc(0), 2);
        return [new CipherState(first), new CipherState(second)];
    }
}
/** Both sides, before message 1: the prologue, then the responder's pre-message `s`. */
function initialized(transport, responderStatic, trace) {
    const state = SymmetricState.initialize(trace);
    state.mark("init");
    state.mixHash(prologue(transport));
    state.mark("prologue");
    state.mixHash(responderStatic);
    state.mark("s");
    return state;
}
/** One direction's records. Each binary WebSocket message after the handshake is exactly one. */
export class RecordCipher {
    #state;
    constructor(state) {
        this.#state = state;
    }
    get nonce() {
        return this.#state.nonce;
    }
    seal(plaintext) {
        if (plaintext.length > MAX_RECORD_PLAINTEXT)
            throw new NoiseError("record_too_large");
        return this.#state.encryptWithAd(Buffer.alloc(0), plaintext);
    }
    open(record) {
        if (record.length > MAX_RECORD_BYTES)
            throw new NoiseError("record_too_large");
        return this.#state.decryptWithAd(Buffer.alloc(0), record);
    }
}
function sessionKeys(state, side) {
    const [pc, cp] = state.split();
    const kPc = pc.keyBytes;
    const kCp = cp.keyBytes;
    return side === "phone"
        ? { send: new RecordCipher(pc), receive: new RecordCipher(cp), handshakeHash: state.h, kPc, kCp }
        : { send: new RecordCipher(cp), receive: new RecordCipher(pc), handshakeHash: state.h, kPc, kCp };
}
export function encodePayload1(conn, app) {
    return Buffer.from(JSON.stringify({ v: 1, conn: b64u(conn), app }), "utf8");
}
export function encodePayload2(conn) {
    return Buffer.from(JSON.stringify({ v: 1, conn }), "utf8");
}
function jsonObject(bytes) {
    try {
        const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
        return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    }
    catch {
        return null;
    }
}
const isConn = (value) => typeof value === "string" && fromB64u(value)?.length === CONN_BYTES;
/** Key order and whitespace are free; the fields are not. */
export function parsePayload1(bytes) {
    if (bytes.length > MAX_HANDSHAKE_PAYLOAD)
        return null;
    const value = jsonObject(bytes);
    if (!value || value.v !== 1 || !isConn(value.conn))
        return null;
    if (value.app !== undefined && (typeof value.app !== "string" || value.app.length > MAX_APP_CHARS))
        return null;
    return { v: 1, conn: value.conn, ...(typeof value.app === "string" ? { app: value.app } : {}) };
}
export function checkPayload2(bytes, conn) {
    const value = bytes.length <= MAX_HANDSHAKE_PAYLOAD ? jsonObject(bytes) : null;
    if (!value || value.v !== 1)
        return "version";
    return value.conn === conn ? "ok" : "conn";
}
/** The initiator. `payload1` is exact bytes so vectors can pin them; `conn` is what message 2 must echo. */
export function phoneHello(options, payload1, conn) {
    if (!isPublicKey(options.remoteStatic))
        throw new NoiseError("bad_point");
    if (options.psk.length !== 32)
        throw new NoiseError("bad_psk");
    if (payload1.length > MAX_HANDSHAKE_PAYLOAD)
        throw new NoiseError("payload_too_large");
    const state = initialized(options.transport, options.remoteStatic, options.trace ?? null);
    state.mixKeyAndHash(options.psk);
    state.mark("msg1.psk");
    const e = options.ephemeral ?? generateKeyPair();
    state.mixHash(e.publicKey);
    state.mixKey(e.publicKey);
    state.mark("msg1.e");
    state.mixKey(dh(e.privateKey, options.remoteStatic));
    state.mark("msg1.es");
    const message1 = Buffer.concat([e.publicKey, state.encryptAndHash(payload1)]);
    state.mark("msg1.payload");
    let done = false;
    return {
        message1,
        finish(message2) {
            if (done)
                throw new NoiseError("finished");
            done = true;
            if (message2.length < PUBLIC_KEY_BYTES + TAG_BYTES || message2.length > MAX_HANDSHAKE_MESSAGE)
                throw new NoiseError("message2_size");
            const re = message2.subarray(0, PUBLIC_KEY_BYTES);
            const ee = dh(e.privateKey, re);
            state.mixHash(re);
            state.mixKey(re);
            state.mark("msg2.e");
            state.mixKey(ee);
            state.mark("msg2.ee");
            const payload2 = state.decryptAndHash(message2.subarray(PUBLIC_KEY_BYTES));
            state.mark("msg2.payload");
            const check = checkPayload2(payload2, conn);
            if (check !== "ok")
                throw new NoiseError(`payload2_${check}`);
            return sessionKeys(state, "phone");
        },
    };
}
/** The responder. Null means close with 4001 and send nothing else: no psk matched, a bad point, a bad size or a
 * bad payload1. Every candidate is tried, so time does not depend on which one matched. */
export function computerAccept(options, message1) {
    if (message1.length < PUBLIC_KEY_BYTES + TAG_BYTES || message1.length > MAX_HANDSHAKE_MESSAGE)
        return null;
    const re = message1.subarray(0, PUBLIC_KEY_BYTES);
    let es;
    try {
        es = dh(options.staticKey.privateKey, re);
    }
    catch {
        return null;
    }
    const base = initialized(options.transport, options.staticKey.publicKey, options.trace ?? null);
    let match = null;
    for (const candidate of options.candidates) {
        if (candidate.psk.length !== 32)
            continue;
        const state = base.clone();
        state.mixKeyAndHash(candidate.psk);
        state.mark("msg1.psk");
        state.mixHash(re);
        state.mixKey(re);
        state.mark("msg1.e");
        state.mixKey(es);
        state.mark("msg1.es");
        try {
            const payload = state.decryptAndHash(message1.subarray(PUBLIC_KEY_BYTES));
            state.mark("msg1.payload");
            match ??= { id: candidate.id, state, payload };
        }
        catch {
            // Not this device.
        }
    }
    if (!match)
        return null;
    const payload1 = parsePayload1(match.payload);
    if (!payload1)
        return null;
    const { state } = match;
    const e = options.ephemeral ?? generateKeyPair();
    state.mixHash(e.publicKey);
    state.mixKey(e.publicKey);
    state.mark("msg2.e");
    state.mixKey(dh(e.privateKey, re));
    state.mark("msg2.ee");
    const payload2 = options.payload2 ? options.payload2(payload1) : encodePayload2(payload1.conn);
    const message2 = Buffer.concat([e.publicKey, state.encryptAndHash(payload2)]);
    state.mark("msg2.payload");
    if (options.trace && state.trace)
        options.trace.splice(0, options.trace.length, ...state.trace);
    return { id: match.id, payload1, message2, keys: sessionKeys(state, "computer") };
}
export const newConn = () => randomBytes(CONN_BYTES);
