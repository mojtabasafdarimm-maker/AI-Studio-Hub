// Who a Team Cloud bot reports to, kept on its record: `reportsTo`, and `createdBy`, recorded once.
import { visibilityFromAccess } from "../shared/bot-access.js";
import { botOwner, chiefConflict, ownerEmail } from "../shared/bot-owner.js";
import { accessOf } from "./bot-visibility.js";
/** `null` hands each bot back to whoever created it. Refused when a Chief would become the second one its new owner has. */
export function setReportsTo(store, botIds, email) {
    const ids = [...new Set(botIds)];
    if (!ids.every((id) => store.bot(id)))
        return { ok: false, reason: "unavailable" };
    const reportsTo = email === null ? undefined : ownerEmail(email);
    if (chiefConflict(store.bots.map((bot) => (ids.includes(bot.id) ? { ...bot, reportsTo } : bot))))
        return { ok: false, reason: "chief-conflict" };
    for (const id of ids) {
        const bot = store.bot(id);
        if (bot.reportsTo !== reportsTo)
            store.patchBot(id, { reportsTo, ...handedOver(bot, botOwner({ ...bot, reportsTo })) });
    }
    return { ok: true, bots: ids.map((id) => store.bot(id)) };
}
/** A bot whose sharing was set keeps its visibility with its owner: the new one sees it, and whoever owned it before
 * can still edit it, as with a document handed on. */
function handedOver(bot, next) {
    if (bot.access === undefined)
        return {};
    const before = botOwner(bot), shared = accessOf(bot);
    const people = { ...shared.people, ...(before && before !== next ? { [before]: "edit" } : {}) };
    if (next)
        delete people[next];
    const access = { everyone: shared.everyone, people };
    return { access, visibility: visibilityFromAccess(access, next) };
}
export function setCreatedBy(store, botId, email) {
    const bot = store.bot(botId);
    if (bot && !bot.createdBy)
        store.patchBot(botId, { createdBy: ownerEmail(email) });
}
/** A member who left a Team Cloud: no bot is shared with them by name or looked after by them any more, so joining again
 * restores nothing. A bot they looked after is nobody's, whose asks go to the Admins; a Chief that would then be a second
 * one in its department gives up its crown. `share` writes a bot's sharing (and its visibility with it). The bots they
 * looked after. */
export function forgetMember(store, email, share) {
    const address = ownerEmail(email);
    const handedBack = [];
    for (const bot of store.bots) {
        if (bot.defaultBot?.person)
            continue;
        const looked = botOwner(bot) === address;
        const named = bot.reportsTo === address || bot.createdBy === address;
        const shared = accessOf(bot);
        const added = Object.hasOwn(shared.people, address);
        if (!looked && !named && !added)
            continue;
        let current = bot;
        if (looked || named) {
            const patch = {
                ...(looked || bot.reportsTo === address ? { reportsTo: undefined } : {}),
                ...(looked || bot.createdBy === address ? { createdBy: undefined } : {}),
            };
            if (bot.chiefOfStaff && chiefConflict(store.bots.map((other) => (other.id === bot.id ? { ...other, ...patch } : other))))
                patch.chiefOfStaff = false;
            current = store.patchBot(bot.id, patch) ?? bot;
            if (looked)
                handedBack.push(current);
        }
        if (added || (looked && bot.access !== undefined) || (looked && typeof bot.visibility === "object")) {
            const people = { ...shared.people };
            delete people[address];
            share(current, { everyone: shared.everyone, people });
        }
    }
    return handedBack;
}
