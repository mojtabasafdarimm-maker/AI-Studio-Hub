import { delegatedApprovalMode } from "../auto-approve.js";
import { chiefLevel } from "../chief-level.js";
const NAMES = { edits: "Auto-accept edits", auto: "Approve for me", full: "Full access" };
const MAX_HOPS = 32;
export function createDelegatedLevel(deps) {
    const { store } = deps;
    /** The nearest Chief conversation at or above `from`: its own, or one that handed it the work, however deep. */
    function chiefAbove(from) {
        let hop = from;
        for (let steps = 0; hop && steps < MAX_HOPS; steps++) {
            const bot = store.bot(hop.botId);
            if (bot && chiefLevel(bot))
                return { chief: bot, threadId: hop.threadId };
            hop = hop.parentId ? deps.node(hop.parentId) : undefined;
        }
        return undefined;
    }
    /** The level work `from` hands `target` comes down with, or null to keep `own`. */
    function handedDown(from, target, own) {
        const above = chiefAbove(from);
        if (!from || !above || from.botId === target.id || above.chief.id === target.id || deps.handsNoLevel(from.threadId) || deps.handsNoLevel(above.threadId))
            return null;
        const chiefMode = deps.sourceLevel(above.chief.id, above.threadId);
        const level = delegatedApprovalMode({
            senderIsChief: true, senderMode: chiefMode, sameBot: from.botId === target.id || above.chief.id === target.id,
            recipientMode: own, recipientDriverKind: deps.driverKind(target),
        });
        return level ? { level, chief: above.chief, chiefMode } : null;
    }
    /** The teammate's thread switches to the level the work came down with, keeps it, and says so once. */
    function apply(from, fromThreadId, fromNodeId, target, threadId) {
        const parentId = fromNodeId ? deps.node(fromNodeId)?.parentId : undefined;
        const own = deps.turnLevel(store.projectBotForTask(target.id, threadId) ?? target, false, threadId);
        const passed = handedDown({ botId: from.id, threadId: fromThreadId, ...(parentId ? { parentId } : {}) }, target, own);
        if (!passed || store.taskByThread(target.id, threadId)?.approvalMode === passed.level)
            return;
        store.patchTask(target.id, threadId, { approvalMode: passed.level, autoApprove: false, alwaysAllow: [] });
        const name = NAMES[passed.level] ?? passed.level;
        const via = passed.chief.id === from.id ? "" : `from ${passed.chief.name}, `;
        store.appendMessage(threadId, {
            role: "bot",
            kind: "activity",
            tool: { name: `${name} — handed on by ${from.name}, ${via}a Chief of Staff on ${name}`, ok: true },
        });
    }
    /** A room thread is shared, so a Chief's level rides the hand-off (`source`, the requester's node) and never lands on it. */
    function roomTurn(bot, threadId, source) {
        if (deps.guestDriven(threadId))
            return "ask";
        const own = deps.turnLevel(bot, source !== undefined, threadId);
        return handedDown(source, bot, own)?.level ?? own;
    }
    /** For the hand-off's record: the level its target really runs at and, when that is the level its chain brought down, the
     * Chief conversation's, so the runtime's one level rule sees the same Chief (docs/runtime-contract.md §3). */
    function levelOf(target, source) {
        const bot = store.bot(target.botId);
        if (!bot)
            return { level: "ask" };
        const running = store.projectBotForTask(bot.id, target.threadId) ?? bot;
        const level = target.groupId ? roomTurn(bot, target.threadId, source) : deps.turnLevel(running, true, target.threadId);
        const passed = handedDown(source, bot, "ask");
        return { level, ...(passed?.level === level ? { chief: passed.chiefMode } : {}), driverKind: deps.driverKind(running) };
    }
    return { apply, roomTurn, levelOf };
}
