import { serverLine } from "../server-lines.js";
/** Long enough that a hand-off held by a turn about to finish says nothing. */
export const QUEUED_NOTE_AFTER_MS = 30_000;
export function createWaitWords(deps) {
    return {
        text(threadId, { first, running, ahead, limit, server }) {
            const language = deps.language(threadId);
            if (server)
                return limit !== undefined ? serverLine(language, first ? "server.room.turns" : "server.room.turnsStill", { limit, ahead }) : serverLine(language, first ? "server.room.wait" : "server.room.still", { running, ahead });
            if (limit !== undefined)
                return serverLine(language, first ? "server.planTurns.wait" : "server.planTurns.still", { limit, ahead });
            if (!first)
                return serverLine(language, "server.memory.still", { running, ahead });
            const wait = serverLine(language, "server.memory.wait", { running, ahead });
            return deps.starter() ? `${wait} ${serverLine(language, "server.memory.starter")}` : wait;
        },
        began(threadId, { running, ahead, limit, server }) {
            deps.held(threadId, limit !== undefined ? `${server ? "server" : "plan"}: ${limit} at once, ${ahead} ahead` : `${server ? "room" : "memory"}: ${running} running, ${ahead} ahead${deps.starter() ? ", on Starter" : ""}`);
        },
        changed: deps.changed,
        queued(threadId, reason) {
            if (!reason)
                return undefined;
            return serverLine(deps.language(threadId), reason === "group-turn" ? "server.queued.groupTurn" : deps.starter() ? "server.queued.capacityStarter" : "server.queued.capacity");
        },
    };
}
const stillHeld = (node) => node?.status === "queued" || node?.status === "resume";
/** One line in the requester's chat once a hand-off has been held a while, naming the limit. A computer's wait and a person's
 * open card say so themselves. */
export function createQueuedNotes(deps) {
    const noted = new Set();
    return (node) => {
        if (noted.has(node.id) || node.groupId || deps.now() - (node.lastProgressAt ?? node.createdAt) < QUEUED_NOTE_AFTER_MS)
            return;
        if (deps.waitsForComputer(node) || deps.behindPerson(node))
            return;
        const parent = deps.parent(node);
        if (!parent)
            return;
        const language = deps.language(parent.threadId), bot = deps.botName(node.botId) ?? "?";
        const { busy, limit } = deps.slots(node.botId);
        const line = deps.threadBusy(node.botId, node.threadId) ? serverLine(language, "server.teammates.queued.thread", { bot })
            : busy.length >= limit ? serverLine(language, "server.teammates.queued.slots", { bot, busy: busy.length, limit })
                : deps.groupTurn(node.botId) ? serverLine(language, "server.teammates.queued.room", { bot }) : undefined;
        if (!line)
            return;
        for (const id of noted)
            if (!stillHeld(deps.node(id)))
                noted.delete(id);
        noted.add(node.id);
        deps.post(parent, node, line);
    };
}
