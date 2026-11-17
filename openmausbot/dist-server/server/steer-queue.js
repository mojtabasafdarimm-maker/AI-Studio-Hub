// Mid-turn sends wait here off the transcript (else they become the active leaf mid-turn) and survive Stop: stop-then-steer is the feature.
import { newId } from "./contracts.js";
import { chatFollowups, saveChatFollowup, settleChatFollowups } from "./message-db.js";
import { drainCoalesceHead } from "./admission.js";
import { spokenLineFields } from "./live-call-record.js";
import { workOriginSchema } from "./peer-provenance.js";
const queues = new Map();
export function restoreSteeredMessages() {
    queues.clear();
    for (const row of chatFollowups("bot")) {
        if (row.status !== "pending")
            continue;
        const entry = queues.get(row.threadId) ?? { botId: row.ownerId, items: [] };
        if (entry.botId !== row.ownerId)
            throw new Error("queued task belongs to another bot");
        const { via, callId, origin: storedOrigin, ...payload } = row.payload;
        const origin = workOriginSchema.safeParse(storedOrigin);
        entry.items.push({
            ...payload,
            ...spokenLineFields(via, callId),
            ...(origin.success ? { origin: origin.data } : {}),
            messageId: row.id,
            prompt: row.payload.prompt ?? row.payload.text,
            queuedAt: row.payload.queuedAt ?? Date.now(),
        });
        queues.set(row.threadId, entry);
    }
}
const listeners = new Set();
const changed = () => {
    for (const listener of listeners) {
        try {
            listener();
        }
        catch {
            console.warn("steer-queue: change listener failed");
        }
    }
};
/** Public pending chips only: never expose provider prompts or reply context. `shownSender`: where several people write,
 * whose each chip is. */
export function queuedSteerSnapshot(ownsThread, whyHeld = () => undefined, shownSender = () => undefined) {
    return Object.fromEntries([...queues]
        .filter(([threadId, entry]) => ownsThread(entry.botId, threadId))
        .map(([threadId, entry]) => [threadId, entry.items.filter((item) => !item.rowId).map((item) => ({
            queueId: item.messageId, text: item.text, ...(item.reason ? { reason: item.reason, why: whyHeld(threadId, item.reason) } : {}),
            ...(item.sender && shownSender(threadId, item.sender) ? { sender: shownSender(threadId, item.sender) } : {}),
        }))]));
}
export function onSteeredQueueChange(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function queueSteeredMessage(botId, threadId, text, options = {}) {
    const id = newId();
    const entry = queues.get(threadId) ?? { botId, items: [] };
    if (entry.botId !== botId)
        throw new Error("queued task belongs to another bot");
    const item = {
        messageId: id,
        text,
        prompt: options.prompt ?? text,
        replyToId: options.replyToId,
        sendId: options.sendId,
        dataContext: options.dataContext,
        reason: options.reason,
        unattended: options.unattended,
        peerAsk: options.peerAsk,
        ...(options.origin ? { origin: options.origin } : {}),
        sender: options.sender,
        trigger: options.trigger,
        queuedAt: options.queuedAt ?? Date.now(),
        ...spokenLineFields(options.via, options.callId),
        ...(options.fromApp ? { fromApp: options.fromApp } : {}),
        ...(options.reaction ? { reaction: options.reaction } : {}),
        ...(options.relay ? { relay: options.relay } : {}),
        ...(options.rowId ? { rowId: options.rowId } : {}),
        ...(options.mentions?.length ? { mentions: options.mentions } : {}),
    };
    saveChatFollowup({ id, kind: "bot", ownerId: botId, threadId, payload: item });
    // `first`: ahead of everything queued but the person's own messages sent before it; with `aheadOfOthers` (the person
    // whose request runs, where several people write), ahead of everyone else's too.
    const ahead = options.first ? entry.items.findIndex((other) => other.peerAsk !== undefined || other.unattended === true || other.queuedAt > item.queuedAt
        || (options.aheadOfOthers !== undefined && other.sender?.id !== options.aheadOfOthers)) : -1;
    if (ahead < 0)
        entry.items.push(item);
    else
        entry.items.splice(ahead, 0, item);
    queues.set(threadId, entry);
    changed();
    return { id };
}
export function queuedThreadPosition(botId, threadId) {
    let position = 0;
    for (const [candidate, entry] of queues) {
        if (entry.botId !== botId || !entry.items.some((item) => item.reason === "capacity" || item.reason === "group-turn"))
            continue;
        position += 1;
        if (candidate === threadId)
            return position;
    }
    return null;
}
export function hasQueuedSteeredMessages(botId, threadId) {
    const entry = queues.get(threadId);
    return entry?.botId === botId && entry.items.length > 0;
}
/** A message the person typed waits to run next, not a teammate's ask, an incident report, a relay or unattended work. */
export function hasQueuedPersonMessage(botId, threadId) {
    const entry = queues.get(threadId);
    return entry?.botId === botId && entry.items.some((item) => !item.peerAsk && !item.unattended && !item.relay && !item.fromApp);
}
export function isSteeredMessageQueued(botId, threadId, queueId) {
    const entry = queues.get(threadId);
    return entry?.botId === botId && entry.items.some((item) => item.messageId === queueId);
}
/** Entries leave the map before running, so racing settles never fire one queue twice; one coalesced group drains per settle. */
export function drainSteeredMessages(store, run, isBlocked) {
    // deleting only the entry being visited is safe under Map iteration
    for (const [threadId, entry] of queues) {
        const bot = store.projectBotForTask
            ? store.projectBotForTask(entry.botId, threadId)
            : store.bot(entry.botId);
        if (!bot) {
            settleChatFollowups(entry.items.map((item) => item.messageId), "cancelled");
            queues.delete(threadId);
            changed();
            continue;
        }
        if (bot.busy || isBlocked?.(entry.botId, threadId, entry.items[0]))
            continue;
        // isBlocked can re-enter this drain; if a nested drain took this entry, it is stale.
        if (queues.get(threadId) !== entry)
            continue;
        const group = drainCoalesceHead(entry.items, coalesceIdentity, (item) => item.queuedAt);
        const ids = group.map((item) => item.messageId);
        settleChatFollowups(ids, "dispatching");
        const rest = entry.items.slice(group.length);
        if (rest.length > 0)
            queues.set(threadId, { botId: entry.botId, items: rest });
        else
            queues.delete(threadId);
        changed();
        const appended = [];
        for (const item of group) {
            const recorded = item.rowId ? store.messagesFor?.(threadId).find((message) => message.id === item.rowId) : undefined;
            appended.push(recorded ?? store.appendMessage(threadId, {
                role: "user",
                kind: "text",
                text: item.text,
                replyToId: item.replyToId,
                sendId: item.sendId,
                ...(item.dataContext ? { dataContext: item.dataContext } : {}),
                queueId: item.messageId,
                peerAsk: item.peerAsk,
                sender: item.sender,
                ...spokenLineFields(item.via, item.callId),
                ...(item.fromApp ? { fromApp: item.fromApp } : {}),
                ...(item.relay ? { relay: item.relay } : {}),
                ...(item.reaction ? { reaction: item.reaction } : {}),
            }));
        }
        const last = appended.at(-1);
        if (!last)
            continue;
        // A blank line keeps each message its own Markdown block; otherwise a trailing attachment tag merges into the next and stops being an image.
        const prompt = group.map((item) => item.prompt).join("\n\n");
        const mentions = group.flatMap((item) => item.mentions ?? []);
        let running;
        try {
            running = run(entry.botId, threadId, prompt, last, appended.map((message) => message.id), 
            // One unattended line makes the turn unattended: a person's words in the group cannot re-attend a bot's own.
            group.some((item) => item.unattended === true), { trigger: group[0].trigger, sender: group[0].sender, peerAsk: group[0].peerAsk, origin: group[0].origin, ...(mentions.length ? { mentions } : {}) });
        }
        catch (error) {
            console.warn("steer-queue: queued dispatch threw", error);
            running = Promise.reject(error);
        }
        void Promise.resolve(running).then(() => settleChatFollowups(ids, null), () => settleChatFollowups(ids, "interrupted")).catch((error) => console.warn("steer-queue: could not settle durable follow-up", error));
    }
}
/** Who sent it, provenance included: a bot's own work never merges with a person's texts, nor a spoken line with a typed one. */
function coalesceIdentity(item) {
    if (item.peerAsk?.incident)
        return "incident";
    if (item.peerAsk)
        return `peer:${item.peerAsk.botId}:${item.unattended === true ? "unattended" : "attended"}:${JSON.stringify(item.origin ?? null)}`;
    if (item.unattended === true)
        return "unattended";
    const person = item.sender ? `person:${item.sender.id ?? item.sender.name}` : "person:local";
    return item.via === "call" ? `call:${item.callId ?? ""}|${person}` : person;
}
export function queuedSteeredMessage(botId, threadId, sendId) {
    const entry = queues.get(threadId);
    if (!entry || entry.botId !== botId)
        return null;
    const item = entry.items.find((candidate) => candidate.sendId === sendId);
    return item ? { id: item.messageId, text: item.text, replyToId: item.replyToId, ...(item.reason ? { reason: item.reason } : {}) } : null;
}
/** Whose waiting line this is, or null when nothing waits under that id. */
export function queuedSteerSender(botId, threadId, queueId) {
    const item = queues.get(threadId)?.botId === botId ? queues.get(threadId).items.find((candidate) => candidate.messageId === queueId) : undefined;
    if (!item)
        return null;
    return item.sender ? { sender: item.sender } : {};
}
export function cancelSteeredMessage(botId, messageId, expectedThreadId) {
    for (const [threadId, entry] of queues) {
        if (entry.botId !== botId || (expectedThreadId !== undefined && threadId !== expectedThreadId))
            continue;
        const items = entry.items.filter((item) => item.messageId !== messageId);
        if (items.length === entry.items.length)
            continue;
        settleChatFollowups([messageId], "cancelled");
        if (items.length === 0)
            queues.delete(threadId);
        else
            queues.set(threadId, { botId: entry.botId, items });
        changed();
        return true;
    }
    return false;
}
/** The entry leaves first, so a racing settle cannot also dispatch these words; the caller must restore or settle it. */
export function holdSteeredQueue(botId, threadId, queueId) {
    const entry = queues.get(threadId);
    if (!entry || entry.botId !== botId || !entry.items.some((item) => item.messageId === queueId))
        return null;
    queues.delete(threadId);
    changed();
    return { botId, threadId, items: entry.items };
}
export function restoreHeldSteeredQueue(held) {
    const existing = queues.get(held.threadId);
    if (existing && existing.botId !== held.botId)
        throw new Error("queued task belongs to another bot");
    queues.set(held.threadId, {
        botId: held.botId,
        items: existing ? [...held.items, ...existing.items] : held.items,
    });
    changed();
}
export function settleHeldSteeredQueue(held) {
    settleChatFollowups(held.items.map((item) => item.messageId), null);
}
export function _queuedCount(threadId) {
    return queues.get(threadId)?.items.length ?? 0;
}
