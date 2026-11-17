import { sameAccess, visibilityFromAccess } from "../../shared/bot-access.js";
import { botOwner } from "../../shared/bot-owner.js";
import { accessOf, parseBotAccess, sameAudience } from "../bot-visibility.js";
import { refusalFor } from "../host/bot-access-gate.js";
import { userError } from "../user-errors.js";
import { PASS } from "./table.js";
const ONE_BOT = /^\/api\/bots\/([\w-]{1,128})\/access$/;
/** The bot's sharing with `next` applied: the owner is never listed (they always edit), and nobody new comes in from
 * outside the team. An entry the bot already had (an older list's address or @domain) may stay. */
export function settledAccess(bot, next, member) {
    const before = accessOf(bot).people;
    const owner = botOwner(bot);
    const people = {};
    for (const [entry, level] of Object.entries(next.people)) {
        if (entry === owner)
            continue;
        if (!Object.hasOwn(before, entry) && !member(entry))
            return { ok: false, error: `${entry} isn't in this team. Add people from the team.` };
        people[entry] = level;
    }
    return { ok: true, access: { everyone: next.everyone, people } };
}
/** Stores a bot's sharing with its visibility in the same write, and tells everyone whose view of it changed. */
export function writeAccess(deps, bot, access) {
    const visibility = visibilityFromAccess(access, botOwner(bot));
    const audienceMoved = !sameAudience(bot.visibility, visibility);
    const updated = deps.store.patchBot(bot.id, { access, visibility });
    if (updated && audienceMoved) {
        for (const group of deps.store.groups.filter((candidate) => candidate.memberIds.includes(updated.id))) {
            deps.broadcast({ kind: "group", group: deps.publicGroupState(group) });
        }
        deps.broadcast({ kind: "sections", sections: deps.store.sections });
        deps.audienceChanged();
    }
    return updated;
}
export function createBotAccessRoutes(deps) {
    return async ({ req, res, path, method, auth, json, readBody }) => {
        const one = method === "PUT" ? ONE_BOT.exec(path) : null;
        if (!one)
            return PASS;
        const { team, people, store } = deps;
        if (!team || !people)
            return json(res, 400, { error: "Only a team's bots are shared." });
        const bot = store.bot(one[1]);
        if (!bot)
            return json(res, 404, userError("serverError.bot.missing"));
        if (deps.levelOf(auth, bot.id) !== "edit")
            return json(res, 403, refusalFor(bot.name, "edit"));
        const parsed = parseBotAccess(await readBody(req));
        if (!parsed.ok)
            return json(res, 400, { error: parsed.error });
        const current = store.bot(bot.id);
        if (!current)
            return json(res, 404, userError("serverError.bot.missing"));
        const settled = settledAccess(current, parsed.access, (email) => people.has(email));
        if (!settled.ok)
            return json(res, 400, { error: settled.error });
        const before = accessOf(current);
        const updated = writeAccess(deps, current, settled.access);
        if (updated && !sameAccess(before, settled.access)) {
            deps.record?.(auth, { category: "visibility", action: "access.update", target: { kind: "bot", id: updated.id, name: updated.name }, before: { access: before }, after: { access: settled.access } });
            deps.shared?.(auth, updated, before, settled.access);
        }
        return updated ? json(res, 200, { bot: deps.wireBot(updated) }) : json(res, 404, userError("serverError.bot.missing"));
    };
}
