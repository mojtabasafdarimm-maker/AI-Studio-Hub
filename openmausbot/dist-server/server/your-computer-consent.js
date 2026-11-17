// Asking before a bot uses the person's own computer. When a turn reaches this computer without the person having
// picked it as the place, its first screen call waits on one plain card, Allow once or Deny, at every approval level
// except Full access ("Just do it"), which is the person's grant to act without asking. The answer covers that turn
// only. Pending asks live in memory; a card left by a previous run is closed.
import { newId } from "./contracts.js";
import { optionCardsForTools } from "./message-db.js";
import { buildNotification } from "./notify.js";
import { turnWaitedOnPerson } from "./waiting-on-person.js";
import { cleanAppName, cleanSiteName, YOUR_COMPUTER_TOOL, yourComputerQuestion, yourComputerText, } from "../shared/your-computer.js";
export const YOUR_COMPUTER_WAITING = "OpenMausBot is asking the person whether you may use their own computer, and they have not answered yet, so this call was NOT performed and nothing happened on their screen. Do not ask them again in chat: the question is already in front of them. To keep waiting, take a screenshot (each call waits up to 45 seconds); meanwhile you may work on anything that does not need their computer.";
/** The claim fails with this, so the turn is told why without a failed-turn row: the person chose, nothing broke. */
export const YOUR_COMPUTER_DECLINED = "the person said no to using their own computer. Finish without it: use your own browser, a cloud computer or a connected app, or give them the links to do it themselves";
const YOUR_COMPUTER_ENDED = "the request ended before the person answered whether you may use their computer";
export class YourComputerDeclined extends Error {
    declined = true;
    constructor(message) {
        super(message);
        this.name = "YourComputerDeclined";
    }
}
export function yourComputerDeclined(error) {
    return error instanceof YourComputerDeclined;
}
const pending = new Map();
/** The cleaned call a computer-control request carries in its query, or nothing. */
export function yourComputerCallFrom(query) {
    const app = cleanAppName(query.get("app"));
    const site = cleanSiteName(query.get("site"));
    if (query.get("files") === "1")
        return { files: true };
    return app || site ? { ...(app ? { app } : {}), ...(site ? { site } : {}) } : undefined;
}
function settle(entry, answer, source) {
    const card = entry.store.messagesFor(entry.threadId).find((message) => message.id === entry.messageId)?.card;
    if (card && !card.answered) {
        entry.store.patchMessage(entry.threadId, entry.messageId, { card: { ...card, answered: answer, dismissed: source !== "user" } });
    }
    const task = entry.botId ? entry.store.projectBotForTask(entry.botId, entry.threadId) : null;
    if (turnWaitedOnPerson(task))
        entry.store.setTaskActivity(task.id, entry.threadId, "working");
}
/** Resolves when the person allows; rejects with YourComputerDeclined when they deny or the request ends first. */
export function askToUseYourComputer(bus, bot, owner, call) {
    const { store } = bus;
    const { key, params } = yourComputerQuestion(call);
    const title = yourComputerText(key, params);
    const name = bot?.name ?? "The bot";
    const room = store.groupByThread(owner.threadId);
    const requestId = newId();
    return new Promise((resolve, reject) => {
        // The card exists before the entry, so an answer or a cancellation can always settle it.
        const message = store.appendMessage(owner.threadId, {
            role: "bot",
            kind: "options",
            ...(room && bot ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}),
            card: {
                title,
                subtitle: yourComputerText("approval.yourComputer.detail", { name }),
                options: ["Allow once", "Deny"],
                requestId,
                requestType: "permission",
                tool: YOUR_COMPUTER_TOOL,
                yourComputer: call?.files ? { files: true } : call ? { ...(call.app ? { app: call.app } : {}), ...(call.site ? { site: call.site } : {}) } : {},
            },
        });
        pending.set(requestId, {
            threadId: owner.threadId, generation: owner.generation, messageId: message.id, botId: bot?.id, store,
            resolve: (allowed, why) => (allowed ? resolve() : reject(new YourComputerDeclined(why ?? YOUR_COMPUTER_DECLINED))),
        });
        if (bot) {
            const task = store.projectBotForTask(bot.id, owner.threadId);
            if (task?.busy)
                store.setTaskActivity(bot.id, owner.threadId, "waiting-on-you");
            bus.notify?.(buildNotification("approval", bot, owner.threadId, title, {
                avatarUrl: bot.avatarUrl, ...(room && !room.dm ? { group: { id: room.id, name: room.name } } : {}),
            }));
        }
    });
}
/** True when it settled one of these asks; call before handing an answer to the engine. */
export function resolveYourComputerAsk(requestId, behavior) {
    const entry = pending.get(requestId);
    if (!entry)
        return false;
    pending.delete(requestId);
    const allowed = behavior === "allow";
    settle(entry, allowed ? "allow" : "deny", "user");
    entry.resolve(allowed);
    return true;
}
/** Closes what a request left open: every ask in the thread, or only its own generation's. */
export function cancelYourComputerAsks(threadId, generation) {
    for (const [requestId, entry] of pending) {
        if (entry.threadId !== threadId || (generation !== undefined && entry.generation !== generation))
            continue;
        pending.delete(requestId);
        settle(entry, "deny", "system");
        entry.resolve(false, YOUR_COMPUTER_ENDED);
    }
}
/** What the screen call is told while the person has not answered this generation's ask. */
export function yourComputerWaiting(threadId, generation) {
    for (const entry of pending.values())
        if (entry.threadId === threadId && entry.generation === generation)
            return YOUR_COMPUTER_WAITING;
    return undefined;
}
/** Asks live in memory only: a card a previous run left open can never be answered, so it is closed at startup. */
export function dismissStaleYourComputerCards(store) {
    let dismissed = 0;
    for (const { threadId, messageId } of optionCardsForTools([YOUR_COMPUTER_TOOL])) {
        const card = store.messagesFor(threadId).find((message) => message.id === messageId)?.card;
        if (!card?.requestId || card.answered || card.dismissed || pending.has(card.requestId))
            continue;
        if (store.patchMessage(threadId, messageId, { card: { ...card, answered: "deny", dismissed: true } }))
            dismissed += 1;
    }
    return dismissed;
}
/**
 * Asks before waiting for this computer, and once more after the wait if the turn dropped below Full access while
 * it waited, so a thread switched to Ask mid-wait never gets the screen without a card. In that rare case the host
 * stays held while the person answers; a Deny fails the claim and no screen call runs.
 */
export async function claimWithYourComputerConsent(askNow, ask, bind) {
    const askedFirst = askNow();
    if (askedFirst)
        await ask();
    await bind();
    if (!askedFirst && askNow())
        await ask();
}
