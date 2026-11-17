import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { phoneRegistration } from "../../shared/phone-jobs.js";
import { writeFileAtomic } from "../atomic.js";
export { phoneRegistration };
const KEY = z.string().min(1).max(300);
const recordSchema = z.object({
    key: KEY, owner: z.string().min(1).max(300), registration: phoneRegistration,
    registeredAt: z.number(), seen: z.number(), lastUsedAt: z.number().nullable(),
}).strict();
/** The newest removals kept; an older one is forgotten, so that phone could register again under its old pairing. */
export const MAX_BLOCKED = 200;
/** `blocked`: keys the computer removed, absent from files written before it existed. */
const fileSchema = z.object({ version: z.literal(1), phones: z.array(recordSchema).max(200), blocked: z.array(KEY).max(MAX_BLOCKED).optional() });
export const PHONE_ONLINE_MS = 60_000;
export const MAX_PHONES = 20;
export const PHONE_REMOVED_TEXT = "This phone was removed on the computer. Pair it again to use its apps.";
const SEEN_WRITE_MS = 60_000;
const failure = (message, status = 409) => Object.assign(new Error(message), { status });
export class PhoneRegistry {
    file;
    now;
    phones = new Map();
    written = new Map();
    removalPending = false;
    /** Removed on the computer: such a key never registers again; pairing the phone again gives it a new one. */
    removed = new Set();
    constructor(file, now = Date.now) {
        this.file = file;
        this.now = now;
        try {
            if (existsSync(file)) {
                const saved = fileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
                for (const phone of saved.phones)
                    this.phones.set(phone.key, phone);
                this.removed = new Set(saved.blocked);
            }
        }
        catch {
            this.phones = new Map();
            this.removed = new Set();
            console.warn("phones: the record of paired phones could not be read; starting a new one");
        }
    }
    save(required = false) {
        try {
            writeFileAtomic(this.file, `${JSON.stringify({ version: 1, phones: [...this.phones.values()], blocked: [...this.removed] })}\n`, { mode: 0o600 });
            this.removalPending = false;
        }
        catch (error) {
            console.warn(`phones: could not save the record of paired phones: ${error instanceof Error ? error.message : String(error)}`);
            if (required)
                throw error;
        }
    }
    /** Same key: update. Same owner + installId under another key: replace that record, keeping its history. A key the
     * computer removed is refused with 403. */
    register(key, owner, registration) {
        if (this.removed.has(key))
            throw failure(PHONE_REMOVED_TEXT, 403);
        const at = this.now();
        const sameKey = this.phones.get(key);
        const twin = [...this.phones.values()].find((phone) => phone.key !== key && phone.owner === owner && phone.registration.installId === registration.installId);
        const previous = sameKey ?? twin;
        if (!previous && this.phones.size >= MAX_PHONES)
            throw failure("Too many phones");
        if (twin) {
            this.phones.delete(twin.key);
            this.written.delete(twin.key);
        }
        const record = { key, owner, registration, registeredAt: previous?.registeredAt ?? at, seen: at, lastUsedAt: previous?.lastUsedAt ?? null };
        this.phones.set(key, record);
        this.written.set(key, at);
        this.save();
        return record;
    }
    get(key) {
        return this.phones.get(key);
    }
    seen(key) {
        const phone = this.phones.get(key);
        if (!phone)
            return;
        const at = this.now();
        phone.seen = at;
        if (at - (this.written.get(key) ?? 0) < SEEN_WRITE_MS)
            return;
        this.written.set(key, at);
        this.save();
    }
    used(key) {
        const phone = this.phones.get(key);
        if (!phone)
            return;
        phone.lastUsedAt = phone.seen = this.now();
        this.save();
    }
    /** `block`: removed on the computer, so the key stays refused (persisted) until the phone pairs again; the phone
     * removing itself does not block. */
    remove(key, options = {}) {
        const removed = this.phones.delete(key);
        if (removed)
            this.written.delete(key);
        const blocking = options.block === true && !this.removed.has(key) && KEY.safeParse(key).success;
        if (blocking) {
            this.removed.add(key);
            for (const oldest of this.removed) {
                if (this.removed.size <= MAX_BLOCKED)
                    break;
                this.removed.delete(oldest);
            }
        }
        if (removed || blocking)
            this.removalPending = true;
        if (this.removalPending)
            this.save(true);
        return removed;
    }
    blocked(key) {
        return this.removed.has(key);
    }
    /** A null owner lists every phone (the desktop admin list). */
    list(owner, busy) {
        const at = this.now();
        return [...this.phones.values()]
            .filter((phone) => owner === null || phone.owner === owner)
            .sort((a, b) => b.seen - a.seen)
            .map(({ owner: _owner, ...rest }) => ({ ...rest, online: at - rest.seen < PHONE_ONLINE_MS, busy: busy(rest.key) }));
    }
    /** Seen within the last minute. */
    online(key) {
        const phone = this.phones.get(key);
        return phone !== undefined && this.now() - phone.seen < PHONE_ONLINE_MS;
    }
    forOwner(owner) {
        return [...this.phones.values()].filter((phone) => phone.owner === owner);
    }
}
