import { waitNoticeText } from "./wait-notice-text.js";
import { redactParams } from "../shared/redact.js";
import { buildNotification } from "./notify.js";
/** The chat a wait's follow-up run works in: the one it was asked in, never on a Cloud home or in a room. */
export function waitRunChat(run, directChat, cloudHome) {
    if (cloudHome || !run.resultsThreadId)
        return null;
    return directChat(run.botId, run.resultsThreadId) ? run.resultsThreadId : null;
}
function settleWaitCard(store, threadId, messageId, how) {
    const card = store.messagesFor(threadId).find((m) => m.id === messageId)?.card;
    if (!card?.waitRequest || card.waitRequest.settled)
        return;
    store.patchMessage(threadId, messageId, {
        card: { ...card, ...(how === "cancelled" ? { undone: true } : {}), waitRequest: { ...card.waitRequest, settled: how } },
    });
}
/** The card's Cancel: true once it stopped the wait. A wait that already ended settles its card instead, so Cancel goes. */
export function cancelWaitFromCard(waits, store, card) {
    if (waits.cancel(card.waitId, card.botId))
        return true;
    settleWaitCard(store, card.threadId, card.messageId, "expired");
    return false;
}
export function createWaitHost(deps) {
    const { store } = deps;
    const now = deps.now ?? Date.now;
    return {
        sourceAlive: (botId, threadId) => store.bot(botId) !== null && deps.directChat(botId, threadId),
        botBusy: (botId) => {
            const bot = store.bot(botId);
            return bot ? bot.busy === true : undefined;
        },
        post(wait, notice) {
            const bot = store.bot(wait.botId);
            if (!bot)
                return true;
            if (deps.threadBusy(wait.botId, wait.threadId))
                return false;
            const posted = store.messagesFor(wait.threadId).some((m) => m.wait?.id === wait.id && m.wait.status === notice.status);
            if (posted)
                return true;
            const words = waitNoticeText(wait, notice);
            store.appendMessage(wait.threadId, { role: "bot", kind: "text", text: notice.text, textCode: words?.key, textParams: words?.params && redactParams(words.params), wait: { id: wait.id, status: notice.status } });
            store.patchTask(wait.botId, wait.threadId, { unread: true });
            deps.wrote(bot, wait.threadId);
            if (notice.status === "fired")
                deps.notify(buildNotification("wait", bot, wait.threadId, notice.text, { avatarUrl: bot.avatarUrl }));
            return true;
        },
        followUp(wait) {
            deps.enqueue({
                webhookId: `wait:${wait.id}`,
                webhookName: wait.label,
                prompt: `[Wait finished: ${wait.label}] ${wait.followUp}`,
                botId: wait.botId,
                runOn: "maus",
                deliveryId: wait.id,
                receivedAt: now(),
                eventSource: "wait",
                ...(deps.cloudHome ? {} : { resultsThreadId: wait.threadId }),
            });
        },
        showCard(wait) {
            const bot = store.bot(wait.botId);
            if (!bot)
                return undefined;
            const message = store.appendMessage(wait.threadId, {
                role: "bot",
                kind: "options",
                card: {
                    title: `Waiting: ${wait.label}`,
                    subtitle: `Then ${bot.name} will: ${wait.followUp}`,
                    options: [],
                    answered: "allow",
                    dismissed: true,
                    autoApplied: true,
                    requestId: wait.id,
                    tool: "wait_until",
                    waitRequest: { waitId: wait.id, label: wait.label, followUp: wait.followUp },
                },
            });
            return message.id;
        },
        settleCard(wait, how) {
            if (wait.cardMessageId)
                settleWaitCard(store, wait.threadId, wait.cardMessageId, how);
        },
    };
}
