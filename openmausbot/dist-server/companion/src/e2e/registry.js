import { admission, admissionHash, credentialHash, credentialHashFromHex, keyId, psk } from "./credentials.js";
import { descriptorFor } from "./descriptor.js";
import { CLOSE, TRANSPORT_RELAY } from "./noise.js";
import { E2ESession } from "./session.js";
const windowHash = (window) => "token" in window ? credentialHash(window.token) : credentialHashFromHex(window.tokenHash);
const ROUTE_RANK = { wifi: 0, tailscale: 1, relay: 2 };
/** A session keyed by the pairing token may only pair; one that hasn't by then is closed. */
export const PAIRING_SESSION_MS = 150_000;
/** Handshakes in progress at once; more are refused until one finishes. */
export const MAX_PENDING_HANDSHAKES = 16;
export class E2ERegistry {
    #devices;
    #live = new Set();
    #key = null;
    #relay = null;
    #pending = 0;
    #admissionListeners = new Set();
    /** Admission hashes kept a moment after their device lost the relay, so what the computer says inside the session
     * reaches the phone before the relay closes it. */
    #held = new Map();
    constructor(devices) {
        this.#devices = devices;
    }
    /** The admission set may have changed for a reason the device registry doesn't see. */
    onAdmissionChange(listener) {
        this.#admissionListeners.add(listener);
    }
    get enabled() {
        return this.#key !== null;
    }
    get relay() {
        return this.#relay;
    }
    setKey(key) {
        this.#key = key;
        if (!key)
            this.closeAll(CLOSE.normal);
    }
    setRelay(relay) {
        this.#relay = relay && relay.nodes.length > 0 ? relay : null;
    }
    /** Every device allowed on this transport, plus each open pairing window (at most 22). */
    candidates(transport) {
        if (!this.#key)
            return [];
        const id = keyId(this.#key.publicKey);
        const out = [];
        for (const device of this.#devices.records()) {
            if (transport === TRANSPORT_RELAY && device.routes === "local")
                continue;
            const hash = credentialHashFromHex(device.tokenHash);
            if (hash)
                out.push({ id: { kind: "device", id: device.id }, psk: psk(hash, id) });
        }
        for (const window of this.#devices.pairingWindows()) {
            const hash = windowHash(window);
            if (!hash)
                continue;
            const admHash = this.#relay ? admissionHash(admission(hash, this.#relay.hostId)) : null;
            out.push({ id: { kind: "pairing", admHash }, psk: psk(hash, id) });
        }
        return out;
    }
    /** What the relay may admit: every device not restricted to Wi-Fi and Tailscale, and each open pairing window. */
    admissionSet() {
        if (!this.#relay)
            return [];
        const hostId = this.#relay.hostId;
        const out = [];
        for (const device of this.#devices.records()) {
            if (device.routes === "local")
                continue;
            const hash = credentialHashFromHex(device.tokenHash);
            if (hash)
                out.push(admissionHash(admission(hash, hostId)));
        }
        for (const window of this.#devices.pairingWindows()) {
            const hash = windowHash(window);
            if (hash)
                out.push(admissionHash(admission(hash, hostId)));
        }
        for (const live of this.#live)
            if (live.pairingAdmission)
                out.push(live.pairingAdmission);
        out.push(...this.#held.keys());
        return [...new Set(out)].sort();
    }
    /** Keeps this device admitted at the relay for `ms` whatever its routes now say, then lets the set shrink. */
    holdAdmission(deviceId, ms) {
        const device = this.#devices.records().find((candidate) => candidate.id === deviceId);
        const hash = device && this.#relay ? credentialHashFromHex(device.tokenHash) : null;
        if (!hash || !this.#relay)
            return Promise.resolve();
        const held = admissionHash(admission(hash, this.#relay.hostId));
        this.#held.set(held, (this.#held.get(held) ?? 0) + 1);
        return new Promise((resolve) => {
            setTimeout(() => {
                const count = (this.#held.get(held) ?? 1) - 1;
                if (count > 0)
                    this.#held.set(held, count);
                else
                    this.#held.delete(held);
                for (const listener of this.#admissionListeners)
                    listener();
                resolve();
            }, ms).unref?.();
        });
    }
    /** For one device (null: a phone that is pairing now). A restricted device is told so, with the relay identity, which
     * admits nothing by itself: the relay refuses it until the device is allowed again. */
    descriptor(deviceId) {
        if (!this.#key)
            return null;
        const device = deviceId ? this.#devices.records().find((candidate) => candidate.id === deviceId) : null;
        return descriptorFor(this.#key.publicKey, this.#relay ?? undefined, device?.routes === "local" ? "local" : undefined);
    }
    /** One WebSocket that just opened, on a direct route or a relay data socket. Null when refused. */
    accept(transport, transportByte, route, connectOrigin) {
        const key = this.#key;
        if (!key || this.#pending >= MAX_PENDING_HANDSHAKES) {
            transport.close(CLOSE.rejected);
            return null;
        }
        this.#pending += 1;
        const live = { context: { peer: { kind: "pairing", admHash: null }, route }, session: null, pairingAdmission: null };
        live.session = E2ESession.computer({
            transport,
            transportByte,
            staticKey: key,
            candidates: () => this.candidates(transportByte),
            connectOrigin: () => connectOrigin(live.context),
            opened: (peer) => {
                live.context.peer = peer;
                this.#live.add(live);
                if (peer.kind === "device") {
                    this.#devices.confirm(peer.id);
                    return this.#devices.markE2E(peer.id);
                }
                if (transportByte === TRANSPORT_RELAY)
                    live.pairingAdmission = peer.admHash;
                const timer = setTimeout(() => {
                    if (live.context.peer.kind === "pairing")
                        live.session.close(CLOSE.rejected);
                }, PAIRING_SESSION_MS);
                timer.unref?.();
                void live.session.closed.then(() => clearTimeout(timer));
            },
        });
        let counted = true;
        const settle = () => {
            if (!counted)
                return;
            counted = false;
            this.#pending -= 1;
        };
        live.session.ready.then(settle, settle);
        void live.session.closed.then(() => {
            settle();
            this.#live.delete(live);
            if (live.pairingAdmission)
                for (const listener of this.#admissionListeners)
                    listener();
        });
        return live.session;
    }
    /** A pairing session that redeemed the window now speaks for the new device. */
    paired(context, deviceId) {
        context.peer = { kind: "device", id: deviceId };
        this.#devices.markE2E(deviceId);
    }
    /** Removal: the phone hears 4001 ("removed from your computer"). A narrowed route closes only relay sessions. */
    closeDevice(deviceId, code = CLOSE.rejected, onlyRoute) {
        for (const live of this.#live) {
            if (live.context.peer.kind !== "device" || live.context.peer.id !== deviceId)
                continue;
            if (onlyRoute && live.context.route !== onlyRoute)
                continue;
            if (code === CLOSE.rejected)
                live.session.remove();
            else
                live.session.close(code);
        }
    }
    /** The best live route per device, for "Connected · Wi-Fi". */
    routes() {
        const out = {};
        for (const live of this.#live) {
            if (live.context.peer.kind !== "device" || live.session.state !== "open")
                continue;
            const current = out[live.context.peer.id];
            if (!current || ROUTE_RANK[live.context.route] < ROUTE_RANK[current])
                out[live.context.peer.id] = live.context.route;
        }
        return out;
    }
    closeAll(code = CLOSE.normal) {
        for (const live of this.#live) {
            if (code === CLOSE.normal)
                live.session.shutdown();
            else
                live.session.close(code);
        }
    }
}
