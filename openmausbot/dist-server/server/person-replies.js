import { createHash } from "node:crypto";
import { cancelChannelMessage, queuedChannelMessage, queueChannelMessage } from "./channel-queue.js";
import { acceptedSendMatch, sendFingerprint } from "./send-idempotency.js";
import { cancelSteeredMessage, queuedSteeredMessage } from "./steer-queue.js";
const conflict = (message) => Object.assign(new Error(message), { status: 409 });
/** A bot answered the question: the person's own answer still replaces it. */
const decidedByBot = (card) => card.answeredBy?.kind === "bot";
export function createPersonReplies(deps) {
    const { store, sendSequencer } = deps;
    function room(threadId) {
        const group = store.groupByThread(threadId);
        const owned = group ? group.dm ? group.threadId === threadId : Boolean(store.groupTaskByThread(group.id, threadId)) : false;
        return { group, owned };
    }
    async function deliver(reply) {
        const { auth, threadId, owner, target, answer, sendId, about, via, callId } = reply;
        const { group, owned } = room(threadId);
        if (group && (!owned || !group.memberIds.includes(owner.id))) {
            throw conflict(`the bot that ${about === "question" ? "asked this question" : "wrote this message"} is no longer in this conversation`);
        }
        if (!group && !store.taskByThread(owner.id, threadId))
            throw conflict(`the ${about}'s conversation no longer exists`);
        const text = group ? `@${owner.name}: ${answer}` : answer;
        const key = group ? `group:${group.id}:${threadId}:${sendId}` : `bot:${owner.id}:${threadId}:${sendId}`;
        return sendSequencer.run(key, sendFingerprint(text, target.id, group ? "chat" : undefined), async () => {
            const accepted = acceptedSendMatch(store.messagesFor(threadId), sendId, text, target.id, group ? "chat" : undefined);
            if (accepted.kind === "conflict")
                throw conflict(`this ${about} already has a different recorded answer`);
            if (accepted.kind === "match")
                return { queued: false, repeated: true };
            const queuedDirect = group ? null : queuedSteeredMessage(owner.id, threadId, sendId);
            if (queuedDirect) {
                if (queuedDirect.text !== text || queuedDirect.replyToId !== target.id)
                    throw conflict(`this ${about} already has a different queued answer`);
                return { queued: true };
            }
            const queuedRoom = group ? queuedChannelMessage(group.id, threadId, sendId) : null;
            if (queuedRoom) {
                if (queuedRoom.text !== text || queuedRoom.replyToId !== target.id || queuedRoom.mode !== "chat") {
                    throw conflict(`this ${about} already has a different queued answer`);
                }
                return { queued: true };
            }
            const refused = reply.refusal?.();
            if (refused)
                throw conflict(refused);
            deps.assertWithinBudget();
            const sender = deps.messageSender(auth);
            const trigger = deps.usageTriggerFor(auth);
            if (group) {
                const current = store.group(group.id);
                if (!current || !owned)
                    throw conflict(`the room switched tasks before it could receive the answer`);
                if (deps.groupThreadIsWorking(current.id, threadId)) {
                    queueChannelMessage(current.id, threadId, text, { replyToId: target.id, sendId, mode: "chat", sender, trigger, reaction: target.reactedWith, mentions: [owner.id] });
                    return { queued: true };
                }
                deps.startGroupTurn(current.id, text, target, sendId, "chat", undefined, { threadId, sender, trigger, mentions: [owner.id] });
                return { queued: false };
            }
            const direct = await deps.startOrQueueDirectMessage(owner.id, threadId, text, target, sendId, sender, trigger, via, callId);
            return { queued: Boolean(direct.queued) };
        });
    }
    function withdraw(threadId, owner, sendId) {
        const group = store.groupByThread(threadId);
        if (group) {
            const queued = queuedChannelMessage(group.id, threadId, sendId);
            if (queued)
                cancelChannelMessage(group.id, queued.id);
            return;
        }
        const queued = queuedSteeredMessage(owner.id, threadId, sendId);
        if (queued)
            cancelSteeredMessage(owner.id, queued.id, threadId);
    }
    async function deliverLateQuestionAnswer(auth, threadId, requestId, answer, cardMessage, owner, via, callId) {
        const latestCard = () => store.messagesFor(threadId).find((message) => message.id === cardMessage.id)?.card;
        const receipt = await deliver({
            auth, threadId, owner, target: cardMessage, answer, via, callId, about: "question",
            sendId: `late-question-${createHash("sha256").update(`${threadId}:${requestId}`).digest("hex").slice(0, 32)}`,
            refusal: () => {
                const card = latestCard();
                return !card || (card.answered && !decidedByBot(card)) || card.dismissed ? "this question has already been answered" : null;
            },
        });
        const latest = latestCard();
        if (latest && (!latest.answered || decidedByBot(latest)) && !latest.dismissed) {
            const { answeredBy: _decider, ...card } = latest;
            store.patchMessage(threadId, cardMessage.id, { card: { ...card, answered: "answer", answeredText: answer, dismissed: false } });
        }
        return receipt;
    }
    return { deliver, withdraw, deliverLateQuestionAnswer };
}
