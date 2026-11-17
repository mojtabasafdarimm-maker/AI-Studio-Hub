import { peerDeliveryReceipt } from "../peer-delivery.js";
import { escapeNotes } from "../peer-provenance.js";
import { AUTHORITY } from "../provenance-label.js";
import { composeAddition } from "../runtime/envelope.js";
import { personOnly, withDefault } from "../runtime/questions.js";
import { conversationLanguage, serverLine } from "../server-lines.js";
import { answerableInWords } from "./ask-cards.js";
import { sentRow } from "./handoff-sent.js";
const ENDED = new Set(["completed", "failed", "cancelled"]);
export function createQuestionRouting(deps) {
    const { store } = deps;
    /** At Full access a question asked with an ask tool in work handed on, which the person started, is answered at once
     * with this instead of a card; undefined shows the card. What only the person can give still reaches them, and so
     * does every question in work an outside event started or in work that runs in their private chat. */
    function notAsked(input) {
        if (input.level !== "full" || personOnly(input.question))
            return undefined;
        const node = deps.active().find((n) => n.threadId === input.threadId && n.botId === input.botId && n.status === "running" && n.parentId !== undefined);
        const requester = node?.parentId ? deps.node(node.parentId) : undefined;
        if (!node || !requester || node.origin?.kind === "outside" || deps.keptPrivate(node, requester))
            return undefined;
        return `Not asked: at this level nobody is interrupted. Take the sensible default yourself, carry on, and say in one plain line what you chose. If you truly cannot choose, end your turn with NEEDS INPUT:, the question and Default: your pick, and @${store.bot(requester.botId)?.name ?? "your requester"} decides.`;
    }
    const signInsOnly = (node) => {
        const rows = store.messagesFor(node.threadId);
        return Boolean(node.cards?.length) && node.cards.every((id) => rows.some((row) => row.id === id && row.signIn));
    };
    function waitingOn(target) {
        const parked = deps.parkedFor(target.id).filter((node) => node.parentId && !node.groupId && (!node.cards?.length || signInsOnly(node)))
            .map((node) => ({ threadId: node.threadId, question: withDefault(node.question ?? "").question, node }));
        const live = store.tasks(target.id).flatMap((task) => {
            const card = store.messagesFor(task.threadId).findLast((row) => !row.inbox && answerableInWords(row.card) && deps.live(task.threadId, row.card.requestId));
            if (!card)
                return [];
            const node = deps.active().find((n) => n.threadId === task.threadId && n.botId === target.id && n.status === "running");
            return [{ threadId: task.threadId, question: card.card.subtitle || card.card.title, card, ...(node ? { node } : {}) }];
        });
        return [...parked, ...live];
    }
    /** `sender` handed this work on: its requester is a turn of that bot outside a room, still waiting for it. */
    const handedOnBy = (node, senderId) => {
        const requester = node.parentId ? deps.node(node.parentId) : undefined;
        return requester?.botId === senderId && !requester.groupId && !ENDED.has(requester.status);
    };
    /** A bot's message goes into work the target already has instead of becoming new work. It answers a teammate's question
     * when it says so (`answers`: the assignment id the question's note names), when the sender's own turn was resumed with
     * that question, or when it goes to the thread (`threadId`) where work the sender handed on in an earlier turn waits on
     * a question (not on a sign-in only the person can do). Otherwise, to the thread where such work is running, it is
     * handed to that running turn. Work handed out in this very turn (`sentThisTurn`) stays apart: a second assignment is its
     * own. When the sender chose `threadId` itself (`selected`: a report-back thread it steers), a question it carries from another
     * thread does not take the message. Undefined when it goes into no work; a failed receipt when `answers` names work that no longer asks. */
    async function relay(input) {
        const { sender, target, message } = input;
        const waiting = waitingOn(target).filter((one) => deps.mayReach(input.senderThreadId, one.threadId));
        const ownWork = (node) => node !== undefined && node.threadId === input.threadId
            && !input.sentThisTurn?.has(node.id) && handedOnBy(node, sender.id) && deps.mayReach(input.senderThreadId, node.threadId);
        const pick = input.answers !== undefined ? waiting.find((one) => one.node?.id === input.answers)
            : waiting.find((one) => one.node !== undefined && input.senderNode?.carrying?.includes(one.node.id) === true && (!input.selected || one.threadId === input.threadId))
                ?? waiting.find((one) => ownWork(one.node) && (one.card !== undefined || !one.node.cards?.length));
        const refused = () => input.answers === undefined ? undefined : peerDeliveryReceipt({ botId: target.id, botName: target.name, outcome: "failed",
            detail: `nothing of ${target.name}'s waits on an answer as ${input.answers}: it was answered or its work ended. Send it without answers if it still needs doing` });
        // A question in words only the person can answer; a wait on a card (a sign-in) is still settled from elsewhere.
        if (pick && personOnly(pick.question) && !pick.node?.cards?.length) {
            return peerDeliveryReceipt({ botId: target.id, botName: target.name, outcome: "failed",
                detail: `only the person can answer "${pick.question}": it waits on them where it was asked, and a teammate's answer doesn't settle it. Tell them where it is if they ask` });
        }
        if (!pick)
            return refused() ?? await handOn(input, deps.active().find((node) => node.botId === target.id && node.status === "running" && ownWork(node)));
        const by = { kind: "bot", botId: sender.id };
        // Security invariant: first, so what this sender says can never reach a turn still holding the lent computer.
        if (!input.lends)
            deps.handedInUnproven(pick.threadId);
        if (pick.card) {
            if (!(await deps.answerLive(pick.threadId, pick.card.card.requestId, `@${sender.name} answered: ${message}`)))
                return refused();
            const card = store.messagesFor(pick.threadId).find((row) => row.id === pick.card.id)?.card;
            if (card)
                store.patchMessage(pick.threadId, pick.card.id, { card: { ...card, answered: "answer", answeredText: message, answeredBy: { kind: "bot", name: sender.name } } });
        }
        else {
            const node = pick.node;
            if (!deps.answerNode(node.id, message, by))
                return refused();
            if (node.cards?.length)
                deps.settleSignIns(node);
            const asked = store.messagesFor(node.threadId).find((row) => row.card?.requestId?.startsWith(`needs-input-${node.id}-`) && !row.inbox
                && (!row.card.answered || (row.card.answeredBy?.kind === "bot" && row.card.answeredText === undefined)));
            if (asked?.card)
                store.patchMessage(node.threadId, asked.id, { card: { ...asked.card, answered: "answer", answeredText: message, answeredBy: { kind: "bot", name: sender.name } } });
        }
        store.appendMessage(input.senderThreadId, { role: "bot", kind: "activity", from: { botId: sender.id, name: sender.name, color: sender.color },
            tool: { name: `Answered ${target.name}'s question`, ok: true, output: pick.question.slice(0, 400) },
            threadRef: { botId: target.id, threadId: pick.threadId, title: store.taskByThread(target.id, pick.threadId)?.title ?? target.name } });
        return peerDeliveryReceipt({ botId: target.id, botName: target.name, outcome: "injected", threadId: pick.threadId, ...(pick.node ? { requestId: pick.node.id } : {}),
            detail: `answered its question "${pick.question}"; it carries on with your answer, and its result returns to whoever handed it that work` });
    }
    /** The sender's message, to the turn running the work it handed on: the turn reads it at its next step, and that work's one
     * result still returns once. Undefined when no such turn runs or its engine cannot take it now. */
    async function handOn(input, running) {
        const { sender, target, message } = input;
        if (running && !input.lends)
            deps.handedInUnproven(running.threadId);
        if (!running || !(await deps.steer(running.threadId, composeAddition(running.id, sender.name, message, running.origin?.kind === "outside" ? AUTHORITY.info : AUTHORITY.behalf))))
            return undefined;
        store.appendMessage(running.threadId, { role: "user", kind: "text", text: escapeNotes(message), peerAsk: { botId: sender.id, name: sender.name }, aside: true, steered: true });
        const title = store.taskByThread(target.id, running.threadId)?.title;
        store.appendMessage(input.senderThreadId, sentRow({ sender, recipient: target, threadId: running.threadId, via: "direct", language: conversationLanguage(input.senderThreadId),
            ...(title ? { title } : {}) }));
        return peerDeliveryReceipt({ botId: target.id, botName: target.name, outcome: "injected", threadId: running.threadId, requestId: running.id,
            detail: "handed to the turn it is running on the work you gave it, which reads it at its next step; that work's one result still returns to you" });
    }
    /** The question card `botId`'s turn in `threadId` waits on that a Chief may answer for the person: answerable in words, not
     * one only the person can answer, and not in work an outside event started, whose questions stay theirs. */
    function forPerson(botId, threadId) {
        if (deps.unattended(botId, threadId))
            return undefined;
        const row = store.messagesFor(threadId).findLast((one) => !one.inbox && answerableInWords(one.card) && deps.live(threadId, one.card.requestId));
        const question = row?.card ? row.card.subtitle || row.card.title : "";
        return row && !personOnly(question) ? { row, question } : undefined;
    }
    /** What the Chief's turns list: the questions `teammates` (those it manages) wait on the person for, in threads the Chief
     * did not open on them and it may read (`readable`); at most ten. */
    function waitingForPerson(chief, teammates, readable = () => true) {
        return teammates.flatMap((teammate) => store.tasks(teammate.id)
            .filter((task) => task.activity === "waiting-on-you" && task.archivedAt === undefined && task.openedBy?.botId !== chief.id && readable(task.threadId, teammate.id))
            .flatMap((task) => {
            const asked = forPerson(teammate.id, task.threadId);
            return asked ? [{ bot: teammate.name, threadId: task.threadId, thread: task.title, question: asked.question, since: asked.row.at }] : [];
        })).slice(0, 10);
    }
    /** A Chief answers, for the person, the question card `target` waits on in `threadId`: a thread the Chief did not open on
     * it, such as the person's own chat with it. The caller checks that the Chief manages `target` and may read that thread.
     * Undefined when the thread waits on no question the Chief may answer, so the usual thread rules apply: a sign-in, an
     * approval or a question only the person can answer stays theirs. The card shows the Chief's answer, and the person's own
     * answer still replaces it. */
    async function answerForPerson(input) {
        const { sender, target, threadId, message } = input;
        const task = store.taskByThread(target.id, threadId);
        if (!task || task.archivedAt !== undefined || task.openedBy?.botId === sender.id)
            return undefined;
        const asked = forPerson(target.id, threadId);
        if (!asked)
            return undefined;
        const { row, question } = asked, card = row.card;
        if (!input.lends)
            deps.handedInUnproven(threadId);
        if (!(await deps.answerLive(threadId, card.requestId, `@${sender.name} answered for the person: ${message}`))) {
            return peerDeliveryReceipt({ botId: target.id, botName: target.name, outcome: "failed", threadId,
                detail: `${target.name}'s question "${question}" was answered or closed meanwhile; nothing was sent` });
        }
        const settled = store.messagesFor(threadId).find((one) => one.id === row.id)?.card;
        if (settled)
            store.patchMessage(threadId, row.id, { card: { ...settled, answered: "answer", answeredText: message, answeredBy: { kind: "bot", name: sender.name } } });
        store.appendMessage(input.senderThreadId, { role: "bot", kind: "activity", from: { botId: sender.id, name: sender.name, color: sender.color },
            tool: { name: serverLine(conversationLanguage(input.senderThreadId), "server.teammates.answeredForPerson", { name: target.name }), ok: true, output: question.slice(0, 400) },
            threadRef: { botId: target.id, threadId, title: task.title } });
        return peerDeliveryReceipt({ botId: target.id, botName: target.name, outcome: "injected", threadId,
            detail: `answered its question "${question}" for the person; it carries on with your answer, and the person can still give their own in that thread` });
    }
    return { notAsked, relay, answerForPerson, waitingForPerson };
}
