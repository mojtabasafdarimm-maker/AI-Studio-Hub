import { createECDH, createHash } from "node:crypto";
import { isCredentialTargetId, isProviderCredentialTarget } from "../shared/credential-request.js";
import { PHONE_SECRET_INFO, PHONE_SECRET_MAX_BYTES, PHONE_SECRET_PROTOCOL_VERSION } from "../shared/phone-secret-envelope.js";
export { PHONE_SECRET_INFO, PHONE_SECRET_MAX_BYTES, PHONE_SECRET_PROTOCOL_VERSION };
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ROUTE_ID = /^[\w-]{1,128}$/;
const TARGET_ID = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
export class PhoneSecretError extends Error {
    status;
    constructor(message, status = 400) {
        super(message);
        this.name = "PhoneSecretError";
        this.status = status;
    }
}
let hpkeSuite;
const suite = () => hpkeSuite ??= import("@hpke/core").then(({ Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 }) => new CipherSuite({
    kem: new DhkemP256HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
}));
const INFO = new TextEncoder().encode(PHONE_SECRET_INFO);
const decodeBase64URL = (value, expectedBytes) => {
    if (typeof value !== "string" || !BASE64URL.test(value))
        return null;
    try {
        const decoded = Buffer.from(value, "base64url");
        if ((expectedBytes !== undefined && decoded.length !== expectedBytes) ||
            decoded.toString("base64url") !== value) {
            return null;
        }
        return decoded;
    }
    catch {
        return null;
    }
};
export function phoneSecretKeyIdFromJwk(jwk) {
    const x = decodeBase64URL(jwk.x, 32);
    const y = decodeBase64URL(jwk.y, 32);
    if (!x || !y)
        return null;
    return createHash("sha256")
        .update(Buffer.concat([Buffer.from([4]), x, y]))
        .digest()
        .subarray(0, 16)
        .toString("base64url");
}
/** One canonical string shared with Swift. Authenticating it stops a relay moving a ciphertext to another bot, conversation, card, device or credential. */
export function phoneSecretAAD(context) {
    const fields = [
        "openmausbot-phone-credential-v1",
        context.keyId,
        context.deviceId,
        context.botId,
        context.threadId,
        context.messageId,
        context.target,
        context.requestKey,
    ];
    if (!/^[A-Za-z0-9_-]{22}$/.test(context.keyId) ||
        !fields.slice(2, 6).every((value) => ROUTE_ID.test(value)) ||
        !TARGET_ID.test(context.target) ||
        !ROUTE_ID.test(context.requestKey)) {
        throw new PhoneSecretError("The credential request metadata is invalid");
    }
    return new TextEncoder().encode(fields.join("\n"));
}
export function phoneSecretOperationId(context) {
    const aad = phoneSecretAAD(context);
    return createHash("sha256")
        .update(aad)
        .update("\0")
        .update(String(context.version))
        .update("\n")
        .update(context.encapsulatedKey)
        .update("\n")
        .update(context.ciphertext)
        .digest("base64url");
}
export function assertPhoneSecretRequestMatches(context, authenticatedDeviceId, expected) {
    // Phone entry hands a key to the desktop's settings; the 1Password token goes to Logins, which a phone cannot reach.
    if (expected.target === "onePasswordToken") {
        throw new PhoneSecretError("Paste the 1Password token in OpenMausBot on your computer, or in My Cloud: a phone cannot save it yet.", 409);
    }
    // An AI provider key lives in the server's settings, which only the computer's own app writes.
    if (isCredentialTargetId(expected.target) && isProviderCredentialTarget(expected.target)) {
        throw new PhoneSecretError("Paste this key in OpenMausBot on your computer, or in My Cloud: a phone cannot save it yet.", 409);
    }
    if (context.deviceId !== authenticatedDeviceId ||
        context.target !== expected.target ||
        context.requestKey !== expected.requestKey) {
        throw new PhoneSecretError("This encrypted credential does not belong to this request", 409);
    }
}
export class PhoneSecretSubmissionRegistry {
    active = new Map();
    mutations = new Set();
    resources(scope) {
        return new Set([
            ...(scope.botId ? [`bot:${scope.botId}`] : []),
            ...(scope.threadId ? [`thread:${scope.threadId}`] : []),
            ...(scope.groupId ? [`group:${scope.groupId}`] : []),
        ]);
    }
    hasActiveResource(resources) {
        return [...this.active.values()].some((entry) => [...resources].some((resource) => entry.resources.has(resource)));
    }
    has(cardKey) {
        return this.active.has(cardKey);
    }
    hasBot(botId) {
        return this.hasActiveResource(this.resources({ botId }));
    }
    hasThread(threadId) {
        return this.hasActiveResource(this.resources({ threadId }));
    }
    hasGroup(groupId) {
        return this.hasActiveResource(this.resources({ groupId }));
    }
    /** Claim before the first await, so a submission and a destructive mutation never both pass preflight while the OS store is slow. */
    claimMutation(scope) {
        const resources = this.resources(scope);
        if (resources.size === 0 ||
            this.hasActiveResource(resources) ||
            [...resources].some((resource) => this.mutations.has(resource))) {
            return null;
        }
        for (const resource of resources)
            this.mutations.add(resource);
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            for (const resource of resources)
                this.mutations.delete(resource);
        };
    }
    async run(scope, operationId, work) {
        const running = this.active.get(scope.cardKey);
        if (running) {
            if (running.operationId !== operationId) {
                throw new PhoneSecretError("Another credential submission is already being saved", 409);
            }
            await running.promise;
            return;
        }
        const resources = this.resources(scope);
        if ([...resources].some((resource) => this.mutations.has(resource))) {
            throw new PhoneSecretError("This credential request is being changed. Try again.", 409);
        }
        // One microtask of deferral lets the registry publish the entry before decrypt/save, so no callback slips a competing transition in.
        const promise = Promise.resolve().then(work);
        const entry = { operationId, promise, resources };
        this.active.set(scope.cardKey, entry);
        try {
            await promise;
        }
        finally {
            if (this.active.get(scope.cardKey) === entry)
                this.active.delete(scope.cardKey);
        }
    }
}
async function importIdentity(message) {
    if (message.version !== PHONE_SECRET_PROTOCOL_VERSION) {
        throw new PhoneSecretError("The desktop credential key version is unsupported", 503);
    }
    const keyId = String(message.keyId ?? "");
    const candidate = message.privateKey;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new PhoneSecretError("The desktop credential key is unavailable", 503);
    }
    const privateKey = candidate;
    const x = decodeBase64URL(privateKey.x, 32);
    const y = decodeBase64URL(privateKey.y, 32);
    const d = decodeBase64URL(privateKey.d, 32);
    if (privateKey.kty !== "EC" ||
        privateKey.crv !== "P-256" ||
        !x ||
        !y ||
        !d ||
        phoneSecretKeyIdFromJwk(privateKey) !== keyId) {
        throw new PhoneSecretError("The desktop credential key is invalid", 503);
    }
    try {
        const ecdh = createECDH("prime256v1");
        ecdh.setPrivateKey(d);
        if (!ecdh.getPublicKey(undefined, "uncompressed").equals(Buffer.concat([Buffer.from([4]), x, y]))) {
            throw new Error("mismatched public point");
        }
    }
    catch {
        throw new PhoneSecretError("The desktop credential key is invalid", 503);
    }
    const imported = await (await suite()).kem.importKey("jwk", {
        kty: "EC",
        crv: "P-256",
        x: privateKey.x,
        y: privateKey.y,
        d: privateKey.d,
        ext: true,
        key_ops: ["deriveBits"],
    }, false);
    return { keyId, privateKey: imported };
}
function decodeSaveResult(raw) {
    const message = raw?.data ?? raw;
    if (!message || typeof message !== "object" || Array.isArray(message))
        return null;
    const value = message;
    if (value.type !== "openmausbot:phone-secret-save-result")
        return null;
    if (typeof value.requestId !== "string" || !ROUTE_ID.test(value.requestId) || typeof value.ok !== "boolean") {
        return null;
    }
    return {
        requestId: value.requestId,
        ok: value.ok,
        ...(typeof value.error === "string" ? { error: value.error.slice(0, 180) } : {}),
    };
}
/** The HTTP route hands this ciphertext only; plaintext exists only after HPKE opens it on the desktop and never reaches HTTP, chat, SQLite, SSE or logs. */
export class PhoneSecretBridge {
    identity = null;
    imported = false;
    pending = new Map();
    active = 0;
    send;
    timeoutMs;
    maximumPending;
    desktopManaged;
    constructor(send, 
    // Outlives every provider's validation deadline but stays below the HTTPS proxy and phone deadlines (Cloudflare's boundary).
    timeoutMs = 90_000, maximumPending = 8, 
    /** False on a self-hosted server: no desktop app ever hands it a key, so reopening the app cannot help. */
    desktopManaged = true) {
        this.send = send;
        this.desktopManaged = desktopManaged;
        this.timeoutMs = timeoutMs;
        this.maximumPending = maximumPending;
    }
    /** Whether a phone can seal a secret for this computer: only after the desktop app has handed over its key. */
    get ready() {
        return this.imported;
    }
    receive(raw) {
        const message = raw?.data ?? raw;
        if (!message || typeof message !== "object" || Array.isArray(message))
            return false;
        const record = message;
        if (record.type === "openmausbot:phone-secret-key") {
            const identity = importIdentity(record);
            this.identity = identity;
            this.imported = false;
            // Ready only once this key imports; a failed or superseded import never counts.
            identity.then(() => { if (this.identity === identity)
                this.imported = true; }, () => { });
            return true;
        }
        const result = decodeSaveResult(record);
        if (!result)
            return false;
        const pending = this.pending.get(result.requestId);
        if (!pending)
            return true;
        this.pending.delete(result.requestId);
        clearTimeout(pending.timer);
        if (result.ok)
            pending.resolve();
        else
            pending.reject(new PhoneSecretError(result.error || "The credential could not be saved", 503));
        return true;
    }
    async provide(context) {
        await this.withinLimit(async () => this.save(context, await this.openWithinLimit(context)));
    }
    /** The value a paired phone sealed for this computer, for a secret this server keeps itself and never sends on. */
    async open(context) {
        return this.withinLimit(() => this.openWithinLimit(context));
    }
    async withinLimit(work) {
        if (this.active >= this.maximumPending) {
            throw new PhoneSecretError("Another secure credential is still being saved. Try again.", 429);
        }
        this.active += 1;
        try {
            return await work();
        }
        finally {
            this.active -= 1;
        }
    }
    async openWithinLimit(context) {
        if (!this.identity) {
            throw new PhoneSecretError(this.desktopManaged
                ? "Secure phone entry is not ready on this computer. Reopen OpenMausBot and try again."
                : "This server cannot take secrets from a phone. Enter it on the web or on your computer instead.", 503);
        }
        const identity = await this.identity.catch(() => {
            throw new PhoneSecretError("Secure phone entry is not ready on this computer. Reopen OpenMausBot and try again.", 503);
        });
        if (context.version !== PHONE_SECRET_PROTOCOL_VERSION || context.keyId !== identity.keyId) {
            throw new PhoneSecretError("This phone was paired with an older security key. Pair it again by QR code.", 409);
        }
        const encapsulatedKey = decodeBase64URL(context.encapsulatedKey, 65);
        const ciphertext = decodeBase64URL(context.ciphertext);
        if (!encapsulatedKey ||
            !ciphertext ||
            ciphertext.length <= 16 ||
            ciphertext.length > PHONE_SECRET_MAX_BYTES + 16) {
            throw new PhoneSecretError("The encrypted credential is invalid");
        }
        let opened;
        try {
            opened = await (await suite()).open({ recipientKey: identity.privateKey, enc: encapsulatedKey, info: INFO }, ciphertext, phoneSecretAAD(context));
        }
        catch {
            throw new PhoneSecretError("The encrypted credential could not be verified");
        }
        const openedBytes = new Uint8Array(opened);
        let value;
        try {
            value = new TextDecoder("utf-8", { fatal: true }).decode(openedBytes).trim();
        }
        catch {
            throw new PhoneSecretError("The encrypted credential is not valid text");
        }
        finally {
            openedBytes.fill(0);
        }
        if (!value || Buffer.byteLength(value) > PHONE_SECRET_MAX_BYTES) {
            throw new PhoneSecretError("The credential must be between 1 and 4096 bytes");
        }
        return value;
    }
    async save(context, value) {
        const requestId = phoneSecretOperationId(context);
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new PhoneSecretError("The operating-system credential store did not respond. Try again.", 504));
            }, this.timeoutMs);
            timer.unref?.();
            this.pending.set(requestId, { resolve, reject, timer });
            if (this.send({
                type: "openmausbot:phone-secret-save",
                requestId,
                target: context.target,
                value,
            }))
                return;
            clearTimeout(timer);
            this.pending.delete(requestId);
            reject(new PhoneSecretError("Secure phone entry is unavailable in this build.", 503));
        });
    }
}
