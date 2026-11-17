// The `e2e` pairing descriptor: in the QR link's `e2e` parameter, in the pair response and in the endpoint list.
// Wire spec: companion/src/e2e/README.md, "Pairing payload and descriptors".
import { b64u, fromB64u, HOST_ID_BYTES } from "./credentials.js";
import { isPublicKey, PUBLIC_KEY_BYTES } from "./noise.js";
export const DESCRIPTOR_VERSION = 1;
export const MAX_DESCRIPTOR_CHARS = 1024;
export const MAX_RELAY_NODES = 4;
export const RELAY_HOST = /^relay[1-9][0-9]?\.openmausbot\.com$/;
export function encodeDescriptor(descriptor) {
    const relay = descriptor.h && descriptor.r ? { h: descriptor.h, r: descriptor.r } : {};
    const json = JSON.stringify({ v: 1, k: descriptor.k, ...relay, ...(descriptor.routes ? { routes: descriptor.routes } : {}) });
    return b64u(Buffer.from(json, "utf8"));
}
/** A restricted device's descriptor says so; it keeps the relay identity, which admits nothing by itself. */
export function descriptorFor(transportPublicKey, relay, routes) {
    const base = relay && relay.nodes.length > 0
        ? { v: 1, k: b64u(transportPublicKey), h: b64u(relay.hostId), r: [...relay.nodes] }
        : { v: 1, k: b64u(transportPublicKey) };
    return routes === "local" ? { ...base, routes: "local" } : base;
}
/** Accepts either the b64u text (the QR parameter) or the already-decoded object (a JSON response field). */
export function parseDescriptor(input) {
    const reject = (reason) => ({ outcome: "reject", reason });
    let value = input;
    if (typeof input === "string") {
        if (input.length > MAX_DESCRIPTOR_CHARS)
            return reject("too_long");
        const bytes = fromB64u(input);
        if (!bytes)
            return reject("base64");
        try {
            value = JSON.parse(bytes.toString("utf8"));
        }
        catch {
            return reject("json");
        }
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
        return reject("json");
    const fields = value;
    if (!Number.isSafeInteger(fields.v) || fields.v < 1)
        return reject("version");
    if (fields.v > DESCRIPTOR_VERSION)
        return { outcome: "update" };
    const transportKey = typeof fields.k === "string" ? fromB64u(fields.k) : null;
    if (!transportKey || transportKey.length !== PUBLIC_KEY_BYTES || !isPublicKey(transportKey))
        return reject("key");
    const hasHost = fields.h !== undefined;
    const hasRelays = fields.r !== undefined;
    if (hasHost !== hasRelays)
        return reject("relay_pair");
    if (fields.routes !== undefined && fields.routes !== "any" && fields.routes !== "local")
        return reject("routes");
    const routes = fields.routes === undefined ? {} : { routes: fields.routes };
    if (!hasHost)
        return { outcome: "ok", descriptor: { v: 1, k: fields.k, ...routes }, transportKey, hostId: null };
    const hostId = typeof fields.h === "string" ? fromB64u(fields.h) : null;
    if (!hostId || hostId.length !== HOST_ID_BYTES)
        return reject("host_id");
    const relays = fields.r;
    if (!Array.isArray(relays) || relays.length < 1 || relays.length > MAX_RELAY_NODES)
        return reject("relays");
    if (!relays.every((host) => typeof host === "string" && RELAY_HOST.test(host)))
        return reject("relay_host");
    return { outcome: "ok", descriptor: { v: 1, k: fields.k, h: fields.h, r: [...relays], ...routes }, transportKey, hostId };
}
