import { randomUUID } from "node:crypto";
import { ACCESS_REQUEST_OPTIONS, atLeast } from "../../shared/bot-access.js";
import { botOwner, nameFromEmail } from "../../shared/bot-owner.js";
import { accessOf } from "../bot-visibility.js";
import { personKey } from "../person-key.js";
import { PASS } from "../routes/table.js";
import { userError } from "../user-errors.js";
const ONE_BOT = /^\/api\/bots\/([\w-]{1,128})\/access-request$/;
export function createAccessRequests(deps) {
    const personKeyOf = (email) => personKey({ id: "", email });
    const nameOf = (email) => deps.profileName(email)?.trim() || nameFromEmail(email);
    const levelFor = (person, botId) => deps.visibleTo(person.role === "member" ? { kind: "member", email: person.email } : { kind: "all", email: person.email }).level(botId);
    const sessionEmail = (auth) => auth.kind === "session" && auth.session.membershipAuthority === "team" ? auth.session.email?.trim().toLowerCase() ?? null : null;
    /** Who decides: the bot's owner while they are on the team, else every admin. */
    function deciders(bot) {
        const people = deps.people();
        const owner = botOwner(bot);
        const theirs = owner ? people.find((person) => person.email === owner) : undefined;
        return theirs ? [theirs] : people.filter((person) => person.role !== "member");
    }
    /** The open asks for this bot from this person, in the inbox of each admin and of the bot's owner. */
    function openAsks(bot, email) {
        const owner = botOwner(bot);
        return deps.people().filter((person) => person.role !== "member" || person.email === owner).flatMap((person) => {
            const home = deps.inbox().home(personKeyOf(person.email));
            const line = home ? deps.store().messagesFor(home.threadId).find((message) => message.card?.accessRequest?.botId === bot.id && message.card.accessRequest.email === email && !message.card.answered && !message.card.dismissed) : undefined;
            return home && line ? [{ person, threadId: home.threadId, line }] : [];
        });
    }
    const routes = async ({ res, path, method, auth, json }) => {
        const one = method === "POST" ? ONE_BOT.exec(path) : null;
        if (!one)
            return PASS;
        const bot = deps.store().bot(one[1]);
        const email = sessionEmail(auth);
        if (!deps.team || !bot || !email)
            return json(res, 404, userError("serverError.bot.missing"));
        if (deps.levelOf(auth, bot.id) !== "view")
            return json(res, 409, { error: `You can already chat with ${bot.name}.` });
        const asked = openAsks(bot, email);
        if (asked.length)
            return json(res, 200, { asked: asked.map(({ person }) => ({ email: person.email, name: nameOf(person.email) })) });
        const name = nameOf(email);
        const card = {
            title: `${name} asks to chat with ${bot.name}`,
            subtitle: `${name} can view ${bot.name}. Allow lets them chat with it and start their own conversations.`,
            options: [...ACCESS_REQUEST_OPTIONS], fixedOptions: true, requestType: "question",
            accessRequest: { botId: bot.id, botName: bot.name, email, name },
        };
        const reached = deciders(bot).filter((person) => deps.inbox().deliver(personKeyOf(person.email), {
            kind: "ask", from: { name, email }, text: card.subtitle, title: card.title, notify: "question", card: { ...card, requestId: `access-${randomUUID()}` },
        }));
        if (!reached.length)
            return json(res, 409, { error: `Nobody who can let you in has an inbox here yet. Ask an admin of ${deps.team.name}.` });
        return json(res, 201, { asked: reached.map((person) => ({ email: person.email, name: nameOf(person.email) })) });
    };
    /** Answers one of these cards, and the same ask in every other inbox; null for any other card. The person answering
     * is the inbox's own. */
    function resolve(threadId, requestId, behavior, message) {
        const line = deps.store().messagesFor(threadId).find((candidate) => candidate.card?.requestId === requestId && candidate.card.accessRequest);
        const ask = line?.card?.accessRequest;
        if (!line?.card || !ask)
            return null;
        if (line.card.answered || line.card.dismissed)
            return { status: 409, body: { error: "This has already been answered." } };
        const allow = behavior === "allow" || (behavior === "answer" && message === ACCESS_REQUEST_OPTIONS[0]);
        const decider = deps.inbox().personOf(threadId);
        const person = deps.people().find((one) => personKeyOf(one.email) === decider);
        const bot = deps.store().bot(ask.botId);
        if (allow) {
            if (!bot || !person || levelFor(person, bot.id) !== "edit")
                return { status: 403, body: { error: `Only people who can edit ${ask.botName} can let someone chat with it.` } };
            const access = accessOf(bot);
            const raised = !atLeast(access.people[ask.email], "chat");
            const after = raised ? { everyone: access.everyone, people: { ...access.people, [ask.email]: "chat" } } : access;
            if (raised)
                deps.writeAccess(bot, after);
            deps.record?.({ category: "visibility", action: "access.allow", target: { kind: "bot", id: bot.id, name: bot.name }, before: { access, asked: ask.email }, after: { access: after, asked: ask.email } }, person.email);
            deps.inbox().deliver(personKeyOf(ask.email), {
                kind: "notice", from: { name: nameOf(person.email), email: person.email },
                text: `${nameOf(person.email)} let you chat with ${bot.name}.`, title: `You can chat with ${bot.name}`, notify: "done",
            });
        }
        if (!allow && bot && person)
            deps.record?.({ category: "visibility", action: "access.decline", target: { kind: "bot", id: bot.id, name: bot.name }, after: { asked: ask.email } }, person.email);
        for (const open of [{ threadId, line }, ...(bot ? openAsks(bot, ask.email).filter((other) => other.threadId !== threadId) : [])]) {
            deps.store().patchMessage(open.threadId, open.line.id, { card: { ...open.line.card, answered: "answer", answeredText: allow ? ACCESS_REQUEST_OPTIONS[0] : ACCESS_REQUEST_OPTIONS[1] } });
        }
        return { status: 200, body: { ok: true, outcome: allow ? "allowed" : "declined" } };
    }
    return { routes, resolve };
}
