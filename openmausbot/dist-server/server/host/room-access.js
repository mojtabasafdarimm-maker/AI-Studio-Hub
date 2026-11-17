import { isLinkedId } from "../bot-link/protocol.js";
import { peerAllowed, reachRefusal } from "../peer-roster.js";
/** Security: what is said in a Team Cloud member's private chat never reaches a room. */
export const PRIVATE_CHAT_ROOM_WRITE = "This is a private chat, and nothing said here goes into a room, where others would read it. Hand the work to the bot directly (leave group_id out), or tell the person what you wanted to post so they can post it themselves.";
const NOT_A_MEMBER = "The addressed agent isn't a member of this room; work sent to it again goes to it directly, in a thread of its own";
const LEFT_THE_ROOM = "The addressed agent is no longer a member of this room, so its room job stopped; work sent to it again goes to it directly, in a thread of its own";
export function createRoomAccess({ store, privateTo = () => null, lookedAfterBy, personalReach }) {
    function reachProblem(from, bot, parent, node) {
        if (peerAllowed(from, bot))
            return undefined;
        const personal = personalReach?.();
        if (personal?.carries(from, bot, parent.threadId, node))
            return undefined;
        return personal?.refusal(from, bot, parent.threadId) ?? reachRefusal(from, bot, lookedAfterBy);
    }
    function roomRootProblem(node) {
        const group = node.groupId ? store.group(node.groupId) : undefined;
        const bot = store.bot(node.botId);
        if (!bot || bot.hidden)
            return "The addressed agent no longer exists";
        if (!group || !(group.dm ? group.threadId === node.threadId : store.groupTaskByThread(group.id, node.threadId)))
            return "Destination room task no longer exists";
        if (!group.memberIds.includes(bot.id))
            return "The addressed agent is no longer a member of this room";
        return undefined;
    }
    function roomHandoffProblem(node, parent) {
        // A bot of the person's other place is no record here: whether it can be reached is the link's to say.
        if (isLinkedId(node.botId))
            return undefined;
        const group = node.groupId ? store.group(node.groupId) : undefined;
        const bot = store.bot(node.botId);
        if (!bot || bot.hidden)
            return "The addressed agent no longer exists";
        if (node.groupId && (!group || group.dm || !store.groupTaskByThread(group.id, node.threadId)))
            return "Destination room task no longer exists";
        if (!node.groupId && !store.taskByThread(bot.id, node.threadId))
            return "Destination bot task no longer exists";
        if (group && parent && privateTo(parent.threadId))
            return PRIVATE_CHAT_ROOM_WRITE;
        if (group && roomSetupPending(group))
            return "Destination room setup is unfinished";
        if (group && !group.memberIds.includes(bot.id))
            return NOT_A_MEMBER;
        // A room job in a thread of its own still answers to its room: a member who left it stops.
        const laneThread = laneRoomThread(node);
        const laneRoom = laneThread ? store.groupByThread(laneThread) : undefined;
        if (laneRoom && !laneRoom.dm && !laneRoom.memberIds.includes(bot.id))
            return LEFT_THE_ROOM;
        // Work the person's other place handed over the link has no sender here to check: the link itself admits it.
        if (parent && !isLinkedId(parent.botId)) {
            const from = store.bot(parent.botId);
            const source = parent.groupId ? store.group(parent.groupId) : undefined;
            if (!from || from.hidden || (parent.groupId ? !source || !source.memberIds.includes(from.id) || !store.groupTaskByThread(source.id, parent.threadId) : !store.taskByThread(from.id, parent.threadId)))
                return "Source membership or task was removed";
            if (source && group && source.id === group.id && parent.threadId !== node.threadId)
                return "Same-room work must stay in the originating conversation";
            // A bot's own thread (start_thread's report_back) is no teammate: its teammate list never names itself.
            if (!(from.id === bot.id && !node.groupId)) {
                const refused = reachProblem(from, bot, parent, node);
                if (refused)
                    return refused;
            }
        }
    }
    /** Security: work addressed into a room for a bot outside it goes to that bot directly, in a thread of its own, so
     *  the room's readers never change. A private chat and an unfinished room keep their refusals. */
    function roomHandoffTarget(node, parent) {
        const group = node.groupId ? store.group(node.groupId) : undefined;
        const bot = store.bot(node.botId);
        if (!group || group.dm || !bot || bot.hidden || group.memberIds.includes(bot.id))
            return node;
        if ((parent && privateTo(parent.threadId)) || roomSetupPending(group))
            return node;
        return { botId: bot.id, threadId: bot.threadId };
    }
    function laneRoomThread(n) {
        if (n.groupId)
            return undefined;
        const opener = store.taskByThread(n.botId, n.threadId)?.openedBy;
        return opener?.kind === "work" && opener.roomLane && opener.threadId && store.groupByThread(opener.threadId) ? opener.threadId : undefined;
    }
    /** `fromThreadId`: the conversation a bot speaks from; a webhook speaks from none. */
    function roomTalks(bot, group, fromThreadId) {
        if (group.dm)
            return { ok: false, problem: "dm" };
        if (!group.memberIds.includes(bot.id))
            return { ok: false, problem: "not-member" };
        if (fromThreadId !== undefined && privateTo(fromThreadId))
            return { ok: false, problem: "private" };
        if (roomSetupPending(group))
            return { ok: false, problem: "setup" };
        return { ok: true };
    }
    function roomSetupPending(group) {
        const hasMarker = Object.prototype.hasOwnProperty.call(group, "setupCompletedAt") ||
            Object.prototype.hasOwnProperty.call(group, "setupSkippedAt");
        return (!group.dm &&
            hasMarker &&
            group.setupCompletedAt == null &&
            group.setupSkippedAt == null &&
            store.messagesFor(group.threadId).length === 0);
    }
    return { roomRootProblem, roomHandoffProblem, roomHandoffTarget, roomSetupPending, roomTalks, laneRoomThread };
}
