import { createHash } from "node:crypto";
import { formatQuestionAnswers } from "../shared/ask-question.js";
import { NO, YES } from "../shared/call-consent.js";
import { liveCardKind } from "../shared/live-approval.js";
import { reactionAnswer } from "../shared/reactions.js";
import { peerName } from "./peer-roster.js";
import { personOf, replyExcerpt } from "./replies.js";
export function reactionSendPrefix(threadId, messageId, by) {
    return `reaction-${createHash("sha256").update(JSON.stringify([threadId, messageId, by])).digest("hex").slice(0, 32)}-`;
}
export function cardReply(card, answer) {
    const kind = liveCardKind(card);
    if (kind === "approval")
        return { behavior: answer === "yes" ? "allow" : "deny" };
    if (kind !== "question")
        return null;
    const said = answer === "yes" ? YES : NO;
    const plain = answer === "yes" ? "Yes" : "No";
    const questions = card.questionRequest?.questions;
    if (!questions) {
        const label = card.options.length ? card.options.find((option) => said.test(option)) : plain;
        return label ? { behavior: "answer", message: label } : null;
    }
    const only = questions.length === 1 && !questions[0].multiSelect ? questions[0] : null;
    const label = !only ? undefined : only.options.length ? only.options.find((option) => said.test(option.label))?.label : plain;
    return label ? { behavior: "answer", message: formatQuestionAnswers(questions, [[label]]) } : null;
}
/** One line with no brackets or parentheses: a person's name cannot close the note or start a line of its own. */
const reactorName = (reaction, userName) => peerName((reaction.by === "user" ? personOf(userName, {}) : reaction.name ?? "Someone").replace(/[()]/g, " "));
const feelings = (message) => (message.reactions ?? []).filter((reaction) => !reactionAnswer(reaction.emoji));
/** `turnIds`: the lines this turn carries. */
export function withReactionNotes(text, path, turnIds, userName) {
    const start = path.findIndex((message) => turnIds.has(message.id));
    if (start < 0)
        return text;
    const before = path.slice(0, start);
    const since = before.findLast((message) => message.role === "user" && !message.peerAsk)?.at ?? 0;
    const notes = before.flatMap((message) => message.role !== "bot" || message.from || !message.text ? [] : feelings(message)
        .filter((reaction) => (reaction.at ?? 0) > since)
        .map((reaction) => `(${reactorName(reaction, userName)} reacted ${reaction.emoji} to your message “${replyExcerpt(message.text, 160)}”.)`));
    return notes.length ? `${notes.join("\n")}\n\n${text}` : text;
}
export function roomReactionNote(message, userName) {
    const felt = message.role === "bot" ? feelings(message) : [];
    return felt.length ? `\n(${felt.map((reaction) => `${reactorName(reaction, userName)} reacted ${reaction.emoji}`).join(", ")})` : "";
}
export function createReactions(deps) {
    const { store } = deps;
    function recipient(message, threadId) {
        if (message.role !== "bot")
            return null;
        if (!store.groupByThread(threadId))
            return store.botByThread(threadId);
        return message.from ? store.bot(message.from.botId) : null;
    }
    /** Each reaction a person sets is stamped later than any before it, so its answer's sendId is its own: a withdrawn
     * answer's sendId stays cancelled, and choosing that answer again sends a new one. */
    let lastStamp = 0;
    const stamp = () => (lastStamp = Math.max(Date.now(), lastStamp + 1));
    function answersSent(threadId, messageId, by) {
        const prefix = reactionSendPrefix(threadId, messageId, by);
        const sent = store.messagesFor(threadId).filter((line) => line.sendId?.startsWith(prefix));
        return { latest: sent.at(-1)?.reaction, sendId: (entry) => `${prefix}${entry.at ?? 0}${reactionAnswer(entry.emoji) === "yes" ? "y" : "n"}` };
    }
    async function deliver(auth, threadId, target, owner, entry, sent) {
        const answer = reactionAnswer(entry.emoji);
        if (!answer)
            return "noted";
        if (liveCardKind(target.card)) {
            const reply = store.groupByThread(threadId) ? null : cardReply(target.card, answer);
            if (!reply)
                return "none";
            const result = await deps.answerCard({ auth, threadId, requestId: target.card.requestId, ...reply });
            if (!result.ok)
                throw Object.assign(new Error(result.error), { status: result.status });
            return "answered";
        }
        if ((target.kind !== "text" && target.kind !== "widget") || !target.text?.trim() || sent.latest === entry.emoji)
            return "none";
        const receipt = await deps.reply({
            auth, threadId, owner, target: { ...target, reactedWith: entry.emoji }, answer: entry.emoji, sendId: sent.sendId(entry),
        });
        return receipt.queued ? "queued" : receipt.repeated ? "none" : "started";
    }
    /** `on` sets (true) or clears (false) the person's `emoji`; absent, a second tap of the same emoji clears it. */
    async function react(input) {
        const { auth, threadId, messageId, emoji, reactor, on } = input;
        const target = store.messagesFor(threadId).find((message) => message.id === messageId);
        if (!target)
            throw Object.assign(new Error("no such message"), { status: 404 });
        const previous = target.reactions?.find((reaction) => reaction.by === reactor.by);
        const kept = previous?.emoji === emoji ? null : previous?.emoji ?? null;
        const next = on === true || (on === undefined && previous?.emoji !== emoji) ? emoji : kept;
        if (next === (previous?.emoji ?? null))
            return { message: target, delivery: "none" };
        const owner = recipient(target, threadId);
        const entry = next ? { emoji: next, by: reactor.by, ...(reactor.name ? { name: reactor.name } : {}), at: stamp() } : null;
        const message = store.setReaction(threadId, messageId, reactor.by, entry) ?? target;
        if (!owner)
            return { message, delivery: "none" };
        const sent = answersSent(threadId, messageId, reactor.by);
        const withdrawPrevious = () => {
            if (previous && reactionAnswer(previous.emoji))
                deps.withdraw(threadId, owner, sent.sendId(previous));
        };
        if (!entry) {
            withdrawPrevious();
            return { message, delivery: "none" };
        }
        const latest = () => store.messagesFor(threadId).find((candidate) => candidate.id === messageId) ?? message;
        try {
            const delivery = await deliver(auth, threadId, message, owner, entry, sent);
            withdrawPrevious();
            return { message: latest(), delivery };
        }
        catch (error) {
            const current = latest().reactions?.find((reaction) => reaction.by === reactor.by);
            if (current && current.at === entry.at && current.emoji === entry.emoji)
                store.setReaction(threadId, messageId, reactor.by, previous ?? null);
            throw error;
        }
    }
    return { react };
}
