// A bot's API: one key per bot, off by default, that lets an outside caller send the bot a message through the webhook
// receiver and read its reply. The key is random, shown once and kept hashed only, like a webhook secret.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.js";
import { DATA_DIR } from "./config.js";
import { defuse } from "./records-block.js";
import { redactSecretsInText } from "../shared/redact.js";
import { API_OWNER_WHO, API_WHO, AUTHORITY, fromNote } from "./provenance-label.js";
import { parseJson } from "./schema.js";
export const BOT_API_RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
/** Turns one bot's API may have running at once before a new call is refused. */
export const BOT_API_MAX_PENDING = 50;
export const BOT_API_MAX_MESSAGE_CHARS = 20_000;
/** Per bot: one bot's callers can't push another's calls out. */
const MAX_ATTEMPTS = 200;
const SAVE_AFTER_MS = 1_000;
const KEY_PREFIX = "bak_";
const REFUSED_BURST_MS = 15 * 60_000;
const recordSchema = z.object({
    botId: z.string().min(1),
    keyHash: z.string().regex(/^[a-f0-9]{64}$/),
    /** Whose key it is, on a Team Cloud: it goes when they leave. */
    mintedBy: z.string().optional(),
    createdAt: z.number().finite().nonnegative(),
    keyCreatedAt: z.number().finite().nonnegative(),
    callCount: z.number().int().nonnegative(),
    lastCalledAt: z.number().finite().nonnegative().optional(),
    /** The owner marked this key as acting for them (bot-api-host.ts): a thread it opens runs at the bot's own level. A new
     * key starts without it. */
    actsAsOwner: z.literal(true).optional(),
});
const attemptSchema = z.object({
    id: z.string().min(1),
    botId: z.string().min(1),
    receivedAt: z.number().finite().nonnegative(),
    outcome: z.enum(["accepted", "rejected"]),
    statusCode: z.number().int().min(100).max(599),
    threadId: z.string().optional(),
    preview: z.string().optional(),
    reason: z.string().optional(),
    repeats: z.number().int().positive().optional(),
    /** Taken in a thread that runs as the owner's own work. */
    asOwner: z.literal(true).optional(),
});
const fileSchema = z.object({
    version: z.literal(1),
    bots: z.array(recordSchema),
    attempts: z.array(attemptSchema).optional(),
});
export function hashBotApiKey(key) {
    return createHash("sha256").update(key).digest("hex");
}
function newKey() {
    return `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}
export class BotApiManager {
    file;
    now;
    bots = [];
    attempts = [];
    rate = new Map();
    saveTimer = null;
    /** Saves are refused while set, so an empty state never overwrites an unreadable file. */
    unreadable = false;
    constructor(options = {}) {
        this.file = options.file ?? join(DATA_DIR, "bot-api.json");
        this.now = options.now ?? Date.now;
        try {
            const parsed = fileSchema.safeParse(parseJson(readFileSync(this.file, "utf8")));
            if (!parsed.success)
                throw parsed.error;
            this.bots = parsed.data.bots;
            this.attempts = parsed.data.attempts ?? [];
        }
        catch (error) {
            if (error.code !== "ENOENT") {
                this.unreadable = true;
                console.error(`bot api: ignoring unreadable ${this.file}: ${error instanceof SyntaxError ? "invalid JSON" : error instanceof Error ? error.message : "unable to read"}`);
            }
        }
    }
    status(botId) {
        const record = this.bots.find((candidate) => candidate.botId === botId);
        if (!record)
            return { enabled: false, actsAsOwner: false, callCount: 0 };
        return { enabled: true, actsAsOwner: record.actsAsOwner === true, keyCreatedAt: record.keyCreatedAt, callCount: record.callCount, ...(record.lastCalledAt !== undefined ? { lastCalledAt: record.lastCalledAt } : {}) };
    }
    /** Turns the API on with a fresh key, or replaces the key of one already on. The key is returned once and never kept. */
    enable(botId, mintedBy) {
        this.assertWritable();
        const key = newKey();
        const now = this.now();
        const record = this.bots.find((candidate) => candidate.botId === botId);
        if (record) {
            record.keyHash = hashBotApiKey(key);
            record.keyCreatedAt = now;
            // A new key is a new token: whoever is given it acts as the owner only once the owner says so again.
            delete record.actsAsOwner;
            if (mintedBy)
                record.mintedBy = mintedBy;
            else
                delete record.mintedBy;
        }
        else {
            this.bots.unshift({ botId, keyHash: hashBotApiKey(key), ...(mintedBy ? { mintedBy } : {}), createdAt: now, keyCreatedAt: now, callCount: 0 });
        }
        this.rate.delete(botId);
        this.save();
        return { key, status: this.status(botId) };
    }
    disable(botId) {
        const at = this.bots.findIndex((candidate) => candidate.botId === botId);
        if (at === -1)
            return false;
        this.assertWritable();
        this.bots.splice(at, 1);
        this.rate.delete(botId);
        this.save();
        return true;
    }
    /** A teammate who left takes the keys they made: whoever still holds one was given it by them. */
    revokeMintedBy(person) {
        const gone = this.bots.filter((record) => record.mintedBy === person).map((record) => record.botId);
        for (const botId of gone)
            this.disable(botId);
        return gone;
    }
    /** A deleted bot's API goes with it, its calls included. */
    removeForBot(botId) {
        if (!this.bots.some((candidate) => candidate.botId === botId) && !this.attempts.some((attempt) => attempt.botId === botId))
            return;
        this.assertWritable();
        this.bots = this.bots.filter((candidate) => candidate.botId !== botId);
        this.attempts = this.attempts.filter((attempt) => attempt.botId !== botId);
        this.rate.delete(botId);
        this.save();
    }
    enabled(botId) {
        return this.bots.some((candidate) => candidate.botId === botId);
    }
    /** Whether the key acts as the owner. The host also asks whether this server allows it at all. */
    actsAsOwner(botId) {
        return this.bots.find((candidate) => candidate.botId === botId)?.actsAsOwner === true;
    }
    /** Marks the key as acting for the owner, or not; false when the API is off. */
    setActsAsOwner(botId, on) {
        const record = this.bots.find((candidate) => candidate.botId === botId);
        if (!record)
            return false;
        this.assertWritable();
        if (on)
            record.actsAsOwner = true;
        else
            delete record.actsAsOwner;
        this.save();
        return true;
    }
    /** Constant-time: a wrong key costs the same as a right one, whatever it shares with it. */
    authorize(botId, key) {
        const record = this.bots.find((candidate) => candidate.botId === botId);
        if (!record || !key)
            return false;
        const actual = Buffer.from(hashBotApiKey(key), "hex");
        const expected = Buffer.from(record.keyHash, "hex");
        return actual.length === expected.length && timingSafeEqual(actual, expected);
    }
    /** Counts a call against the key's minute; false once the minute's calls are used up. */
    admit(botId) {
        const now = this.now();
        const recent = (this.rate.get(botId) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
        if (recent.length >= BOT_API_RATE_LIMIT)
            return false;
        recent.push(now);
        this.rate.set(botId, recent);
        return true;
    }
    /** The calls since it was last switched on, which is what its count counts. */
    callsSinceOn(botId) {
        const record = this.bots.find((candidate) => candidate.botId === botId);
        return record ? this.listAttempts(botId).filter((attempt) => attempt.receivedAt >= record.createdAt) : [];
    }
    listAttempts(botId) {
        return this.attempts.filter((attempt) => attempt.botId === botId).map((attempt) => ({ ...attempt }));
    }
    record(botId, details) {
        const attempt = { id: randomUUID(), botId, receivedAt: this.now(), outcome: details.outcome, statusCode: details.statusCode };
        if (details.threadId)
            attempt.threadId = details.threadId;
        if (details.preview)
            attempt.preview = redactSecretsInText(details.preview).replace(/\s+/g, " ").trim().slice(0, 200);
        if (details.reason)
            attempt.reason = redactSecretsInText(details.reason).slice(0, 500);
        if (details.asOwner)
            attempt.asOwner = true;
        this.keep(attempt);
        const record = this.bots.find((candidate) => candidate.botId === botId);
        if (record && details.outcome === "accepted") {
            record.callCount += 1;
            record.lastCalledAt = attempt.receivedAt;
        }
        this.saveSoon();
        return attempt;
    }
    /** Anyone who can reach the receiver can send these: one rolling row per burst, in memory until the next real change. */
    recordRefused(botId, statusCode, reason) {
        const at = this.attempts.findLastIndex((attempt) => attempt.botId === botId);
        const burst = at === -1 ? undefined : this.attempts[at];
        if (burst?.outcome === "rejected" && burst.statusCode === statusCode && this.now() - burst.receivedAt <= REFUSED_BURST_MS) {
            burst.receivedAt = this.now();
            burst.repeats = (burst.repeats ?? 1) + 1;
            return burst;
        }
        const attempt = { id: randomUUID(), botId, receivedAt: this.now(), outcome: "rejected", statusCode, reason };
        this.keep(attempt);
        return attempt;
    }
    keep(attempt) {
        this.attempts.push(attempt);
        const own = this.attempts.filter((candidate) => candidate.botId === attempt.botId);
        if (own.length > MAX_ATTEMPTS)
            this.attempts.splice(this.attempts.indexOf(own[0]), 1);
    }
    /** A caller decides how often this runs, so it never writes per call: a synchronous save would block the server. */
    saveSoon() {
        if (this.saveTimer)
            return;
        this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, SAVE_AFTER_MS);
        this.saveTimer.unref?.();
    }
    flush() {
        if (!this.saveTimer)
            return;
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
        this.save();
    }
    assertWritable() {
        if (this.unreadable)
            throw Object.assign(new Error("The saved Bot API settings could not be read. Repair bot-api.json before changing them."), { status: 503 });
    }
    save() {
        if (this.unreadable)
            return;
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileAtomic(this.file, JSON.stringify({ version: 1, bots: this.bots, attempts: this.attempts }, null, 2), { mode: 0o600 });
    }
}
export const BOT_API_MESSAGE_DATA = "[UNTRUSTED BOT API MESSAGE]";
/** Security: the tag names a stored file for the turn to load, so a caller's copy of it never reaches the turn. */
export function withoutAttachedImages(message) {
    return defuse(message).replace(/<(\s*attached-image)/gi, "($1");
}
/** The caller's words go to the model as data from outside, never as the person's request, and can't pass for a note. */
export function botApiPrompt(message, receivedAt) {
    return [
        fromNote(API_WHO, "message", AUTHORITY.info),
        BOT_API_MESSAGE_DATA,
        defuse(`Received: ${new Date(receivedAt).toISOString()}`),
        "",
        withoutAttachedImages(message),
        "[/UNTRUSTED BOT API MESSAGE]",
    ].join("\n");
}
/** A message through a key the owner marked as acting for them: their request, at the bot's own level. Its words are
 * still defused, so they can't pass for a note or name a stored file. */
export function botApiOwnerPrompt(message) {
    return [fromNote(API_OWNER_WHO, "message", AUTHORITY.behalf), withoutAttachedImages(message)].join("\n");
}
