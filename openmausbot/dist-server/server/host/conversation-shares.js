// On a Team Cloud a private conversation is shared only by the person it is private to: with the team, when it becomes
// the team's (audience `team`), or with one teammate. A conversation shared with one person has an audience of its own,
// `member:<share key>`, the key made from the conversation and held by no session: its memory layer, engine home and
// browser are its own, so neither person's private notes reach it, and nobody but its two readers (never an admin) sees
// it. Security invariant: a share is never undone into a narrower audience by anyone's request; only someone leaving the
// team dissolves one with one reader, into a private chat of the reader who stays.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.js";
import { memberAudience } from "../audience.js";
export const CONVERSATION_SHARES_FILE = "conversation-shares.json";
const MAX_SHARES = 50_000;
const person = z.string().regex(/^p_[\w-]{22}$/);
const shareSchema = z.object({ owner: person, with: z.union([z.literal("team"), person]), at: z.number(), before: z.object({ with: person, at: z.number() }).optional(),
    /** Its person opened it from a Slack channel, shared with the team from its first line (host/team-slack-host.ts). */
    from: z.literal("slack").optional() });
const fileSchema = z.record(z.string().regex(/^[\w-]{1,128}$/), shareSchema);
export function shareKey(threadId) {
    return `p_${createHash("sha256").update(`conversation:${threadId}`).digest("base64url").slice(0, 22)}`;
}
export function createConversationShares(deps) {
    const file = join(deps.dataDir, CONVERSATION_SHARES_FILE);
    let shares = {};
    if (deps.team) {
        try {
            const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
            if (parsed.success)
                shares = parsed.data;
            else
                console.warn(`conversation shares: ${file} is not a shares file; nothing is shared`);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                console.warn(`conversation shares: ${file} is unreadable; nothing is shared`);
        }
    }
    const keys = () => new Set(Object.entries(shares).filter(([, share]) => share.with !== "team").map(([threadId]) => shareKey(threadId)));
    let shareKeys = keys();
    const save = () => {
        const entries = Object.entries(shares);
        if (entries.length > MAX_SHARES)
            shares = Object.fromEntries(entries.slice(-MAX_SHARES));
        shareKeys = keys();
        writeFileAtomic(file, `${JSON.stringify(shares)}\n`, { mode: 0o600 });
    };
    return {
        get(threadId) {
            return deps.team ? shares[threadId] : undefined;
        },
        /** The audience sharing gave the conversation; null when it was never shared. */
        audienceOf(threadId) {
            const share = deps.team ? shares[threadId] : undefined;
            if (!share)
                return null;
            return share.with === "team" ? "team" : memberAudience(shareKey(threadId));
        },
        /** A Slack channel's conversation: the team's, and never the chat its bot opens to. */
        fromSlack(threadId) {
            return deps.team && shares[threadId]?.from === "slack";
        },
        /** Who reads a conversation shared with one person: its owner and that person. Null for any other conversation. */
        readers(threadId) {
            const share = deps.team ? shares[threadId] : undefined;
            return share && share.with !== "team" ? [share.owner, share.with] : null;
        },
        /** A share key names a conversation, never a person: no About you, no inbox, no own connections. */
        isShareKey(key) {
            return shareKeys.has(key);
        },
        /** A task as one person is sent it: marked shared, and when shared with one person, who the other reader is. */
        forViewer(task, viewer, nameOf) {
            const share = deps.team ? shares[task.threadId] : undefined;
            if (!share)
                return task;
            if (share.with === "team")
                return { ...task, shared: true };
            const byYou = share.owner === viewer;
            const other = byYou ? share.with : share.owner;
            return { ...task, shared: true, sharedWith: { name: nameOf(other) ?? "", ...(byYou ? { byYou: true } : {}) } };
        },
        /** Whether a notification about the conversation reaches this person: one from before it was shared with them was
         * its owner's alone, and stays so. */
        reaches(entry, person) {
            const share = deps.team && entry.threadId ? shares[entry.threadId] : undefined;
            if (!share || entry.at >= share.at || person === share.owner)
                return true;
            return Boolean(share.before && person === share.before.with && entry.at >= share.before.at);
        },
        share(threadId, owner, to, at = Date.now(), from) {
            const earlier = shares[threadId];
            const before = earlier && earlier.with !== "team" ? { with: earlier.with, at: earlier.at } : undefined;
            const share = shareSchema.parse({ owner, with: to, at, ...(before ? { before } : {}), ...(from ? { from } : {}) });
            shares[threadId] = share;
            save();
            return share;
        },
        /** Someone left: a conversation they shared with one person becomes that person's, one shared with them becomes its
         * owner's again. What was shared with the team stays the team's. */
        personLeft(key) {
            const dissolved = [];
            for (const [threadId, share] of Object.entries(shares)) {
                if (share.with === "team" || (share.owner !== key && share.with !== key))
                    continue;
                dissolved.push({ threadId, to: share.owner === key ? share.with : share.owner });
                delete shares[threadId];
            }
            if (dissolved.length)
                save();
            return dissolved;
        },
        forget(threadIds) {
            const known = threadIds.filter((threadId) => Object.hasOwn(shares, threadId));
            for (const threadId of known)
                delete shares[threadId];
            if (known.length)
                save();
        },
    };
}
