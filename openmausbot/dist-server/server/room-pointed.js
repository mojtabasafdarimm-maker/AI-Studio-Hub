import { appRow } from "./chat-apps.js";
import { preparePointed } from "./pointed.js";
import { userError } from "./user-errors.js";
export function prepareRoomPointed(store, threadId, value) {
    const pointed = preparePointed(store, threadId, value);
    if (!pointed || !pointed.ok)
        return pointed;
    // Valid now, so value is the list of parts; each bot gets the records of its own pages only.
    const byBot = new Map();
    for (const part of value) {
        const botId = appRow(store, threadId, part.appId)?.from?.botId;
        // A room page always names the bot that showed it; one without has nobody to read the pick.
        if (!botId)
            return { ok: false, status: 404, ...userError("serverError.page.notHere") };
        byBot.set(botId, [...(byBot.get(botId) ?? []), part]);
    }
    const blocks = {};
    for (const [botId, parts] of byBot) {
        const own = byBot.size === 1 ? pointed : preparePointed(store, threadId, parts);
        if (!own?.ok)
            return own ?? { ok: false, status: 404, ...userError("serverError.page.notHere") };
        blocks[botId] = own.block;
    }
    return { ok: true, pick: { refs: pointed.refs, blocks } };
}
export function roomPickBots(pick) {
    return pick ? Object.keys(pick.blocks) : [];
}
/** Page bots of a pick that will not answer this line (held or gone since it was queued): their part reaches no one.
 * startGroupTurn also reports parts still in the run's pick when its round ends (a turn failed or the round stopped). */
export function undeliveredPickBots(pick, responders) {
    return roomPickBots(pick).filter((id) => !responders.some((responder) => responder.id === id));
}
/** A line that points at a member's page goes to that member first, with anyone the person named too; none otherwise. */
export function pointedResponders(pick, members, named) {
    const ids = roomPickBots(pick);
    const pageBots = members.filter((member) => !member.hidden && ids.includes(member.id));
    return pageBots.length ? [...pageBots, ...named().filter((member) => !pageBots.includes(member))] : [];
}
/** Each turn takes its own bot's part out of the pick, so a run works on a copy and the queued line keeps its own. */
export function copyRoomPick(pick) {
    return { ...pick, blocks: { ...pick.blocks } };
}
/** The pick text for this bot's turn, once: the bot that made the page reads it on its first turn, no one else does. */
export function takeRoomPick(holder, botId) {
    const blocks = holder?.pick?.blocks;
    if (!blocks || !Object.hasOwn(blocks, botId))
        return "";
    const block = blocks[botId];
    delete blocks[botId];
    return block;
}
