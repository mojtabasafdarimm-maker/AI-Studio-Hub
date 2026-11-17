import { shownPersonName } from "../../shared/bot-owner.js";
import { serverLine } from "../server-lines.js";
const PERSON = /^p_[\w-]{22}$/;
export function runActorOf(auth, personOf) {
    return auth.kind === "session" ? { person: personOf(auth), admin: auth.scopes.includes("admin") } : { admin: false };
}
/** A new line `from` a person (absent: not a person's own line) in a conversation whose run `asker` owns. */
export function arrivalDecision(input) {
    if (!input.shared)
        return "as-today";
    return input.asker !== null && input.from !== undefined && input.from === input.asker.person ? "as-today" : "queue";
}
export function mayStop(input) {
    const { shared, asker, by } = input;
    return !shared || asker === null || by.admin || by.person === asker.person;
}
/** A waiting line is its writer's to remove; one no person wrote, an Owner's or Admin's. */
export function mayRemoveQueued(input) {
    const { shared, sender, by } = input;
    if (!shared)
        return true;
    const writer = sender?.id && PERSON.test(sender.id) ? sender.id : undefined;
    return writer ? writer === by.person : by.admin;
}
/** A request is its writer's to run again; an Owner or Admin runs anyone's again, and anyone one no person wrote. */
export function mayRetry(input) {
    const { shared, sender, by } = input;
    return !shared || !sender?.id || by.admin || sender.id === by.person;
}
/** Waiting lines join the running turn only when every one is the asker's own and the asker adds them. */
export function mayJoinRun(input) {
    const { shared, asker, senders, by } = input;
    if (!shared)
        return true;
    return asker !== null && by.person === asker.person && senders.every((sender) => sender?.id === asker.person);
}
/** A person's own line, as the server recorded it: never a bot's, a relay's, an aside or one sent through the API. */
function linePerson(line) {
    if (!line || line.role !== "user" || line.kind !== "text" || line.peerAsk || line.relayed || line.aside || line.via === "api")
        return null;
    const person = line.sender?.id;
    return person && PERSON.test(person) ? { person, name: line.sender.name } : null;
}
export function createRunOwners(deps) {
    const lineAsker = (threadId, messageId) => messageId ? linePerson(deps.messages(threadId).find((line) => line.id === messageId)) : null;
    const named = (owner) => owner && { person: owner.person, name: shownPersonName(deps.personName(owner.person) ?? owner.name) };
    /** A routine, a webhook or an app's event runs nobody's request; work handed on for a person runs theirs. */
    const asker = (threadId) => named(askerOf(threadId));
    const askerOf = (threadId) => {
        if (deps.isRoom(threadId))
            return lineAsker(threadId, deps.roomRequestMessageId(threadId));
        const request = deps.directRequest(threadId);
        if (!request || request.stopped || request.automation !== undefined)
            return null;
        const own = lineAsker(threadId, request.messageId);
        if (own)
            return own;
        const handedFor = request.origin?.kind === "user" ? request.origin.person : undefined;
        return handedFor ? { person: handedFor, name: handedFor } : null;
    };
    return {
        shared: deps.shared,
        asker,
        /** A waiting line's writer as the chat names them, where several people write; nothing elsewhere. */
        shownSender(threadId, sender) {
            return deps.shared(threadId) ? { ...sender, name: shownPersonName((sender.id && deps.personName(sender.id)) || sender.name) } : undefined;
        },
        /** The conversation's wire field naming whose request runs, while it works where several people write. */
        askedBy(task) {
            const owner = task.busy && deps.shared(task.threadId) ? asker(task.threadId) : null;
            return owner ? { askedBy: { name: owner.name, id: owner.person } } : {};
        },
        /** A new line while this conversation's run goes on: as today, or into the queue behind it. */
        arrival(threadId, sender, ownLine) {
            if (!deps.shared(threadId))
                return "as-today";
            return arrivalDecision({ shared: true, asker: asker(threadId), from: ownLine ? sender?.id : undefined });
        },
        /** The sentence someone who may not stop this conversation's run reads, or null when they may. */
        stopRefusal(threadId, by) {
            const shared = deps.shared(threadId);
            const owner = shared ? asker(threadId) : null;
            return mayStop({ shared, asker: owner, by }) ? null : serverLine(deps.language(threadId), "server.runOwner.onlyAskerStops", { name: owner.name });
        },
        /** Where several read, the running request's asker: their own line added to it goes ahead of everyone else's waiting
         * lines, as it does in a private chat. */
        askerFirst(threadId) {
            return deps.shared(threadId) ? asker(threadId)?.person : undefined;
        },
        removeRefusal(threadId, sender, by) {
            return mayRemoveQueued({ shared: deps.shared(threadId), sender, by }) ? null : serverLine(deps.language(threadId), "server.runOwner.notYourQueued");
        },
        joinRefusal(threadId, senders, by) {
            const shared = deps.shared(threadId);
            return mayJoinRun({ shared, asker: shared ? asker(threadId) : null, senders, by }) ? null : serverLine(deps.language(threadId), "server.runOwner.waitsItsTurn");
        },
        /** The sentence someone who may not run this request again reads, or null when they may. */
        retryRefusal(threadId, sender, by) {
            if (mayRetry({ shared: deps.shared(threadId), sender, by }))
                return null;
            return serverLine(deps.language(threadId), "server.runOwner.onlyAskerRetries", { name: shownPersonName(deps.personName(sender.id) ?? sender.name) });
        },
    };
}
/** The rule as a route asks it, by the request's sign-in. A route built without it (a server one person uses, or a
 * route's own test) refuses nothing and sees no admin, so nothing changes there. */
export function routeRunOwners(owners, actorOf) {
    const by = (auth) => actorOf?.(auth) ?? { admin: false };
    return {
        admin: (auth) => by(auth).admin,
        /** Where several people write, who wrote a request decides who runs it again or rewords it, not who opened the conversation. */
        decidesRetry: (threadId) => owners?.shared(threadId) ?? false,
        stopRefusal: (auth, threadId) => owners?.stopRefusal(threadId, by(auth)) ?? null,
        removeRefusal: (auth, threadId, sender) => owners?.removeRefusal(threadId, sender, by(auth)) ?? null,
        joinRefusal: (auth, threadId, senders) => owners?.joinRefusal(threadId, senders, by(auth)) ?? null,
        retryRefusal: (auth, threadId, sender) => owners?.retryRefusal(threadId, sender, by(auth)) ?? null,
    };
}
