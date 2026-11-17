// Security invariant: a room's bulletin and a bot's memory load into later turns at their own level, as instructions. What
// work from outside asks to write there waits on a person's card, whatever the bot's level, and nothing is written until
// they say yes.
import { randomUUID } from "node:crypto";
import { buildNotification } from "../notify.js";
import { serverLine } from "../server-lines.js";
import { OUTSIDE_STAYS_HERE } from "./outside-lineage.js";
const MEMORY_ACTIONS = new Set(["append", "replace", "remove", "supersede", "forget"]);
/** A card shows all of what it would save, or it isn't offered. */
const SHOWN_CHARS = 2_000;
const OPEN_CARDS = 5;
const TOOL = "outside_write";
const speaker = (bot) => ({ botId: bot.id, name: bot.name, color: bot.color });
export function createOutsideWrites(deps) {
    const { store } = deps;
    function apply(write, threadId, botId) {
        if (write.kind === "room-bulletin")
            return store.group(write.roomId) && store.patchGroup(write.roomId, { bulletin: write.bulletin }) ? null : "The room no longer exists.";
        if (!botId)
            return "The bot no longer exists.";
        const { kind: _kind, ...change } = write;
        return deps.writeMemory(botId, threadId, change);
    }
    function propose(from, threadId, title, subtitle, write) {
        if (subtitle.length > SHOWN_CHARS)
            return { status: 400, body: { error: `This is too long for a person to review on a card: keep it under ${SHOWN_CHARS} characters.` } };
        if (store.messagesFor(threadId).filter((line) => line.card?.outsideWrite && !line.card.answered).length >= OPEN_CARDS) {
            return { status: 429, body: { error: "A person already has several of these to look at from this conversation. Finish without saving more." } };
        }
        const requestId = `outside-write-${randomUUID()}`;
        const language = deps.language(threadId);
        const message = store.appendMessage(threadId, {
            role: "bot", kind: "options", from: speaker(from),
            card: { title, subtitle, options: [serverLine(language, "server.outside.save"), serverLine(language, "server.outside.skip")], requestId, tool: TOOL, outsideWrite: write },
        });
        deps.decide({ threadId, requestId, botId: from.id, botName: from.name, tool: TOOL, summary: title, decision: "card-shown", source: "outside-write" });
        deps.notify(buildNotification("approval", { id: from.id, name: from.name }, threadId, title));
        return { status: 201, body: { status: "proposed", state: "pending", requestId, messageId: message.id, message: "This came from outside work, so it is not saved yet: a person sees a card and decides. Do not wait for it and do not try another way." } };
    }
    return {
        submitBulletin(from, threadId, room, bulletin) {
            return propose(from, threadId, serverLine(deps.language(threadId), "server.outside.bulletinTitle"), `${room.name}: ${bulletin}`, { kind: "room-bulletin", roomId: room.id, bulletin });
        },
        submitMemory(from, threadId, body) {
            const action = typeof body?.action === "string" ? body.action : "";
            if (!MEMORY_ACTIONS.has(action))
                return { status: 403, body: { error: OUTSIDE_STAYS_HERE } };
            const change = { action, ...(typeof body.text === "string" ? { text: body.text } : {}), ...(typeof body.oldText === "string" ? { oldText: body.oldText } : {}), ...(typeof body.until === "string" ? { until: body.until } : {}) };
            const title = serverLine(deps.language(threadId), action === "append" ? "server.outside.memoryTitle" : "server.outside.memoryChangeTitle");
            return propose(from, threadId, title, [change.oldText, change.text].filter(Boolean).join(" → ") || action, { kind: "memory", ...change });
        },
        /** A person's answer to the card; null when the request is not one of these cards. */
        resolve(threadId, requestId, behavior) {
            const message = store.messagesFor(threadId).find((line) => line.card?.requestId === requestId && line.card.outsideWrite);
            const card = message?.card;
            const write = card?.outsideWrite;
            if (!message || !card || !write)
                return null;
            if (card.answered)
                return { ok: true, outcome: card.answered === "allow" ? "allowed-once" : "rejected", alreadySettled: true };
            const botId = message.from?.botId ?? store.botByThread(threadId)?.id;
            const bot = botId ? store.bot(botId) : undefined;
            const allowed = behavior === "allow";
            const problem = allowed ? apply(write, threadId, botId) : null;
            store.patchMessage(threadId, message.id, { card: { ...card, answered: !allowed ? "deny" : problem ? "unavailable" : "allow", ...(problem ? { dismissed: true } : {}) } });
            deps.decide({ threadId, requestId, botId, botName: bot?.name, tool: TOOL, summary: card.title, decision: allowed && !problem ? "user-approved" : "user-denied", source: "user" });
            return { ok: true, outcome: !allowed ? "rejected" : problem ? "unavailable" : "allowed-once" };
        },
    };
}
