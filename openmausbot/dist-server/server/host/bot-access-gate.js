import { atLeast } from "../../shared/bot-access.js";
import { bodyThreadIds, memberLevel, pathSubject } from "../bot-visibility.js";
import { onParsedBody } from "../harness/http.js";
import { personKey } from "../person-key.js";
import { userError, userErrorFields } from "../user-errors.js";
const OPEN_CONVERSATION = /^\/api\/(?:bots|groups)\/[\w-]+\/tasks\/(?!delete$)[\w-]+$/;
/** What a member needs on what a request's path names; null where the route weighs the request itself (a bot's own
 * PATCH, which checks each field, and a routine, which its own writer may still change). */
export function levelNeeded(method, path) {
    const verb = method.toUpperCase();
    if (verb === "GET" || verb === "HEAD")
        return "view";
    if (/^\/api\/bots\/[\w-]+$/.test(path))
        return null;
    if (/^\/api\/bots\/[\w-]+\/(?:access|bot-api(?:\/new-key)?)$/.test(path))
        return "edit";
    if (/^\/api\/routines\/[\w-]+$/.test(path))
        return null;
    if (/^\/api\/(?:bots|groups)\/[\w-]+\/read$/.test(path) || /^\/api\/bots\/[\w-]+\/(?:access-request|data\/page)$/.test(path))
        return "view";
    if (verb === "POST" && OPEN_CONVERSATION.test(path))
        return "view";
    if (/^\/api\/routine-runs\/[\w-]+\/seen$/.test(path))
        return "view";
    return "chat";
}
export function refusalFor(name, needed) {
    return needed === "edit" ? { error: `Only people who can edit ${name} can change this.` } : userError("serverError.bot.viewOnly", { bot: name });
}
export function createBotAccessGate(deps) {
    const ownerBots = (owner) => owner?.bot !== undefined ? [owner.bot] : owner?.group !== undefined ? deps.roomBots(owner.group) ?? [] : [];
    const targetBots = (target) => typeof target?.groupId === "string" && target.groupId ? deps.roomBots(target.groupId) ?? []
        : typeof target?.botId === "string" ? [target.botId] : [];
    /** The first of these bots the member sees but may not do this with. A bot they cannot see is the visibility gate's. */
    function short(visible, botIds, needed) {
        for (const id of botIds) {
            const level = visible.level(id);
            if (level !== "none" && !atLeast(level, needed))
                return refusalFor(deps.botName(id) ?? "this bot", needed);
        }
        return null;
    }
    /** Null to let the request through; else why a member may not. Body fields are checked as the route reads them. */
    return function accessRefusal(req, auth, method, path, visible) {
        if (auth.kind !== "session" || !visible.member || !visible.filtersThreads)
            return null;
        const needed = levelNeeded(method, path);
        const subject = pathSubject(path);
        const named = !subject ? [] : subject.kind === "bot" ? [subject.id] : subject.kind === "thread" ? ownerBots(deps.threadOwner(subject.id))
            : subject.kind === "group" ? deps.roomBots(subject.id) ?? [] : subject.kind === "routine" ? targetBots(deps.routine(subject.id))
                : subject.kind === "routine-run" ? targetBots(deps.run(subject.id)) : [];
        const routine = subject?.kind === "routine" && needed === null ? subject.id : null;
        const own = routine !== null && deps.routineWriter(routine) === personKey(auth.session);
        const refused = needed ? short(visible, named, needed) : routine !== null ? short(visible, named, own ? "chat" : "edit") : null;
        if (refused)
            return refused;
        if (method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD")
            return null;
        const bodyNeeds = needed ?? "chat";
        onParsedBody(req, (body) => {
            const record = body && typeof body === "object" && !Array.isArray(body) ? body : {};
            const added = path === "/api/groups" && Array.isArray(record.memberIds) ? record.memberIds.filter((id) => typeof id === "string") : [];
            const targeted = path === "/api/routines" || routine !== null ? targetBots(record) : [];
            const threads = bodyThreadIds(body).flatMap((threadId) => ownerBots(deps.threadOwner(threadId)));
            const error = short(visible, [...added, ...targeted, ...threads], bodyNeeds);
            if (error)
                throw Object.assign(new Error(error.error), { status: 403 }, userErrorFields(error));
            return null;
        });
        return null;
    };
}
/** A card whose answer changes the bot itself (its instructions, model, skills, team, triggers, MCP servers) is answered
 * only by someone who can edit it; any other card by whoever may answer it. */
export function setupCardRefusal(card, bot, level) {
    if (!card || !bot)
        return null;
    const changesBot = card.profileRequest !== undefined || card.modelRequest !== undefined || card.skillRequest !== undefined ||
        card.teamSetupRequest !== undefined || card.webhookRequest !== undefined || card.appTriggerRequest !== undefined || card.mcpRequest !== undefined;
    return changesBot && !atLeast(level(bot.id), "edit") ? refusalFor(bot.name, "edit").error : null;
}
/** A message another app relays for a person (the guarded route's onBehalfOf) needs that person to be able to chat with
 * the bot; one that names nobody is anyone in the team, so it needs everyone to be able to. */
export function relayedSendRefusal(bot, email, admin) {
    if (admin || atLeast(memberLevel(bot, email), "chat"))
        return null;
    return `${email ?? "Someone outside the people added"} can't chat with ${bot.name} here.`;
}
/** What index.ts asks of levels: a session's level on a bot, the request gate, and the check a card's answer passes. */
export function createBotAccessHost(deps) {
    const levelOf = (auth, botId) => deps.visibleFor(auth).level(botId);
    const accessRefusal = createBotAccessGate({
        botName: (id) => deps.store().bot(id)?.name,
        roomBots: (id) => deps.store().group(id)?.memberIds,
        threadOwner: deps.threadOwner,
        routine: (id) => deps.routines()?.listRoutines().find((one) => one.id === id),
        run: (id) => deps.routines()?.listRuns().find((one) => one.id === id),
        routineWriter: deps.routineWriter,
    });
    function cardRefusal(auth, threadId, requestId) {
        const store = deps.store();
        const line = store.messagesFor(threadId).find((message) => message.card?.requestId === requestId);
        if (!line?.card)
            return null;
        return setupCardRefusal(line.card, store.bot(line.from?.botId ?? "") ?? store.botByThread(threadId) ?? undefined, (botId) => levelOf(auth, botId));
    }
    return { levelOf, accessRefusal, cardRefusal };
}
