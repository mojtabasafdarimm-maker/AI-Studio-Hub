// Sharing a private conversation and saving a line to a bot's team memory, on a Team Cloud only.
// Security invariant: only a signed-in person acts here, never a bot, a script without a person or the server itself.
// Sharing is the conversation's own person's act alone (an admin can't, and can't see it); saving needs only to read the
// conversation, which for a private one is again its person alone. The visibility and access gates have already
// answered 404 for a conversation the caller can't see and 403 for a bot they can't chat with; each check is repeated
// here so a route never depends on a gate it can't see.
import { z } from "zod";
import { atLeast } from "../../shared/bot-access.js";
import { memberAudience } from "../audience.js";
import { NO_SUCH_CONVERSATION } from "../host/team-private.js";
import { personKey } from "../person-key.js";
import { serverLine } from "../server-lines.js";
import { userError } from "../user-errors.js";
import { PASS } from "./table.js";
/** Longer words are cut to one note (team-memory-saves.ts); this only bounds what a request may carry. */
const TEAM_MEMORY_BODY_MAX = 100_000;
const SHARE = /^\/api\/bots\/([\w-]{1,128})\/tasks\/([\w-]{1,128})\/share$/;
const TEAM_MEMORY = /^\/api\/bots\/([\w-]{1,128})\/memory\/team(?:\/([\w-]{1,64}))?$/;
const shareBody = z.object({ with: z.union([z.literal("team"), z.object({ email: z.string().email().max(320) })]) });
const saveBody = z.object({ threadId: z.string().regex(/^[\w-]{1,128}$/), messageId: z.string().regex(/^[\w-]{1,128}$/), text: z.string().max(TEAM_MEMORY_BODY_MAX) });
function signedIn(auth) {
    if (auth.kind !== "session" || auth.session.membershipAuthority !== "team" || !auth.session.email)
        return null;
    return { email: auth.session.email.trim().toLowerCase(), person: personKey(auth.session), admin: auth.scopes.includes("admin") };
}
export function createConversationSharing(deps) {
    const sharedAs = (share) => {
        if (!share)
            return null;
        if (share.with === "team")
            return "team";
        const email = deps.people().find((person) => personKey({ id: "", email: person.email }) === share.with)?.email;
        return email ? { email, name: deps.nameOf(email) } : null;
    };
    const nameOfShare = (share) => {
        const as = sharedAs(share);
        return as && as !== "team" ? as.name : "someone";
    };
    const canChat = (person, botId) => atLeast(deps.levelFor(person, botId), "chat");
    const routes = async ({ req, res, path, method, auth, json, readBody }) => {
        const share = SHARE.exec(path);
        const memory = share ? null : TEAM_MEMORY.exec(path);
        if (!share && !memory)
            return PASS;
        const me = deps.team ? signedIn(auth) : null;
        if (!me)
            return json(res, 404, { error: "not found" });
        const store = deps.store();
        const bot = store.bot((share ?? memory)[1]);
        if (!bot)
            return json(res, 404, userError("serverError.bot.missing"));
        if (share) {
            if (method !== "GET" && method !== "POST")
                return PASS;
            const threadId = share[2];
            const task = store.taskByThread(bot.id, threadId);
            if (!task || !deps.sees(auth, threadId))
                return json(res, 404, { error: NO_SUCH_CONVERSATION });
            if (bot.defaultBot)
                return json(res, 409, userError("serverError.share.ownBot"));
            const current = deps.shares.get(threadId);
            if (current?.with === "team")
                return json(res, 409, userError("serverError.share.alreadyTeam"));
            const mine = deps.starter(threadId) === me.person && (current ? current.owner === me.person : deps.audienceOf(threadId) === memberAudience(me.person));
            if (!mine)
                return json(res, 403, userError("serverError.share.notYours"));
            const eligible = () => deps.people().filter((person) => person.email !== me.email && canChat(person, bot.id))
                .map((person) => ({ email: person.email, name: deps.nameOf(person.email) })).sort((a, b) => a.name.localeCompare(b.name));
            if (method === "GET")
                return json(res, 200, { shared: sharedAs(current), people: eligible() });
            const parsed = shareBody.safeParse(await readBody(req));
            if (!parsed.success)
                return json(res, 400, { error: "with must be \"team\" or { email }" });
            const wanted = parsed.data.with;
            const recipient = wanted === "team" ? null : deps.people().find((person) => person.email === wanted.email.trim().toLowerCase());
            if (wanted !== "team") {
                if (!recipient || recipient.email === me.email)
                    return json(res, 409, userError("serverError.share.notTeammate", { name: wanted.email }));
                if (current) {
                    return current.with === personKey({ id: "", email: recipient.email }) ? json(res, 200, { shared: sharedAs(current) })
                        : json(res, 409, userError("serverError.share.alreadyWith", { name: nameOfShare(current) }));
                }
                if (!canChat(recipient, bot.id))
                    return json(res, 409, userError("serverError.share.cantUse", { name: deps.nameOf(recipient.email), bot: bot.name }));
            }
            if (deps.busy(bot.id, threadId))
                return json(res, 409, userError("serverError.share.busy", { bot: bot.name }));
            if (deps.routinesIn(threadId) > 0)
                return json(res, 409, userError("serverError.share.routine"));
            const to = recipient ? personKey({ id: "", email: recipient.email }) : "team";
            const saved = deps.shares.share(threadId, me.person, to);
            deps.audienceChanged(bot.id, threadId);
            deps.changed(bot.id);
            if (recipient)
                tell(to, bot, threadId, "server.share.withYouTitle", "server.share.withYou", { name: deps.nameOf(me.email), title: task.title || bot.name, bot: bot.name }, { name: deps.nameOf(me.email), email: me.email });
            return json(res, 200, { shared: sharedAs(saved) });
        }
        const entryId = memory[2];
        if (method === "GET" && !entryId) {
            const entries = deps.saves.list(bot.id, me).map((entry) => ({ id: entry.id, text: entry.line, at: entry.at, ...(entry.person === me.person ? { yours: true } : {}) }));
            return json(res, 200, { entries });
        }
        if (method === "DELETE" && entryId) {
            const removed = deps.saves.remove(bot.id, entryId, me);
            if (removed === "not-yours")
                return json(res, 403, userError("serverError.teamMemory.notYours"));
            return json(res, 200, { ok: true, removed: removed === "removed" });
        }
        if (method !== "POST" || entryId)
            return PASS;
        const parsed = saveBody.safeParse(await readBody(req));
        if (!parsed.success)
            return json(res, 400, { error: "threadId, messageId and text are required" });
        const { threadId, messageId } = parsed.data;
        if (!store.taskByThread(bot.id, threadId) || !deps.sees(auth, threadId))
            return json(res, 404, { error: NO_SUCH_CONVERSATION });
        if (bot.defaultBot)
            return json(res, 409, userError("serverError.share.ownBot"));
        if (!atLeast(deps.levelOf(auth, bot.id), "chat"))
            return json(res, 403, userError("serverError.bot.viewOnly", { bot: bot.name }));
        if (!store.messagesFor(threadId).some((message) => message.id === messageId))
            return json(res, 404, { error: "no such message" });
        if (deps.outside(threadId))
            return json(res, 409, userError("serverError.teamMemory.outside"));
        const text = parsed.data.text.replace(/\s+/g, " ").trim();
        if (!text)
            return json(res, 400, userError("serverError.teamMemory.empty"));
        const entry = deps.saves.add({ botId: bot.id, person: me.person, name: deps.nameOf(me.email), text });
        return json(res, 201, { entry: { id: entry.id, text: entry.line, at: entry.at, yours: true } });
    };
    /** Someone left the team: a conversation shared between them and one other person becomes the other's own, and the
     * lines they saved to team memory stay without them. */
    function personLeft(person) {
        for (const { threadId, to } of deps.shares.personLeft(person)) {
            deps.handTo(threadId, to);
            const botId = deps.botOf(threadId);
            if (botId)
                deps.audienceChanged(botId, threadId);
        }
        deps.saves.personLeft(person);
    }
    if (deps.team)
        deps.store().onChange((change) => { if (change.type === "message")
            handedBackAndForth(change.threadId, change.message); });
    return { routes, personLeft };
    /** The one line in `to`'s inbox about this conversation, and one notification linking it when the line is new. */
    function tell(to, bot, threadId, titleKey, textKey, params, from) {
        const language = deps.language(to);
        const heading = serverLine(language, titleKey, params);
        const kept = deps.inbox().keepOne(to, {
            kind: "message", from, origin: { botId: bot.id, threadId },
            text: serverLine(language, textKey, params), title: heading, notify: "mention",
        });
        if (kept?.created)
            deps.notify({ kind: "mention", botId: bot.id, botName: bot.name, threadId, title: heading, body: params.title ?? "", forPerson: to, ...(bot.avatarUrl ? { avatarUrl: bot.avatarUrl } : {}) });
    }
    /** A conversation shared with one person goes back and forth: what one of the two writes, or the bot answers them,
     * waits in the other's inbox while they don't have it open. */
    function handedBackAndForth(threadId, message) {
        const readers = deps.shares.readers(threadId);
        const botId = readers && deps.botOf(threadId);
        const bot = botId ? deps.store().bot(botId) : undefined;
        const task = bot && deps.store().taskByThread(bot.id, threadId);
        if (!readers || !bot || !task)
            return;
        const personLine = (line) => line.role === "user" && !line.peerAsk && !line.relay && readers.includes(line.sender?.id ?? "");
        const writer = personLine(message) ? message.sender.id : message.role === "bot" && message.kind === "text" && !message.inbox
            ? deps.store().messagesFor(threadId).findLast(personLine)?.sender?.id : undefined;
        const to = writer && readers.find((person) => person !== writer);
        const people = deps.people();
        const email = (key) => people.find((person) => personKey({ id: "", email: person.email }) === key)?.email;
        const toEmail = to ? email(to) : undefined, writerEmail = writer ? email(writer) : undefined;
        if (!to || !toEmail || !writerEmail || deps.looking(toEmail, threadId))
            return;
        const params = { name: deps.nameOf(writerEmail), title: task.title || bot.name, bot: bot.name };
        if (message.role === "user")
            tell(to, bot, threadId, "server.share.wroteTitle", "server.share.wrote", params, { name: params.name, email: writerEmail });
        else
            tell(to, bot, threadId, "server.share.answeredTitle", "server.share.answered", params, { name: bot.name, botId: bot.id });
    }
}
