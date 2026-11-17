// Burst mode's host: the lane's threads are ordinary threads of the bot, started through the same turn start any turn uses,
// so a burst thread gets the memory gate, the budget check and every other guard of a normal turn. The seam for a thread's
// own computer is `openThread`: each part is one thread with one model today, and the same place can ask for a computer.
import { fastModelFor } from "../turn-route.js";
import { buildNotification, summarize } from "../notify.js";
import { redactSecretsInText } from "../../shared/redact.js";
import { burstLimits } from "../burst/limits.js";
import { createBurstManager } from "../burst/manager.js";
import { openBurstStore } from "../burst/store.js";
import { serverLine } from "../server-lines.js";
const INBOX_TEXT_MAX = 2_000;
const CARD_LINE = {
    preview: "server.burst.preview",
    running: "server.burst.running",
    merging: "server.burst.merging",
    done: "server.burst.done",
    cancelled: "server.burst.cancelled",
};
const outcomeOf = (result) => ({ ok: result.ok && !result.stalled, text: result.text, asked: Boolean(result.cards?.ids.length) });
export function createBurstHost(deps) {
    const { store } = deps;
    const burstStore = openBurstStore(deps.dataDir);
    const limits = () => burstLimits({ cloudHome: deps.cloudHome, tier: deps.tier(), maxParallel: deps.maxParallel() });
    function cardLine(burst, card) {
        const language = deps.language(burst.threadId);
        return serverLine(language, CARD_LINE[card.phase], { count: card.total, done: card.counts.done, total: card.total, failed: card.counts.failed });
    }
    const manager = createBurstManager({
        store: burstStore,
        limits,
        hasRoom: deps.hasRoom,
        openThread(burst, child) {
            const bot = store.bot(burst.botId);
            if (!bot)
                return null;
            const task = store.createTask(bot.id, child.title, false, undefined, { botId: bot.id, name: bot.name, threadId: burst.threadId, burstId: burst.id, at: Date.now() }, deps.approval(bot, burst.model), burst.model);
            if (!task)
                return null;
            deps.opened(task.threadId, burst.threadId);
            return task.threadId;
        },
        startChild(burst, child, text, done) {
            const bot = store.bot(burst.botId);
            if (!bot)
                return Promise.reject(new Error("The bot is no longer here."));
            return deps.startTurn(bot.id, text, { threadId: child.threadId, peerAsk: { botId: bot.id, name: bot.name }, origin: deps.origin(burst), allowRoomTurnElsewhere: true,
                onSettled: (result) => { done(outcomeOf(result)); }, onDispatchError: (message) => { done({ ok: false, text: message }); } }).then(() => undefined);
        },
        stopChild(burst, child) {
            if (child.threadId)
                deps.stop(burst.botId, child.threadId, "The person cancelled this burst.");
        },
        async startMerge(burst, text, done) {
            if (!store.bot(burst.botId))
                throw new Error("The bot is no longer here.");
            if (deps.threadBusy(burst.botId, burst.threadId))
                return false;
            await deps.startTurn(burst.botId, text(), { threadId: burst.threadId, cardContinuation: true, ...(burst.cardMessageId ? { requestMessageId: burst.cardMessageId } : {}), origin: deps.origin(burst), allowRoomTurnElsewhere: true,
                onSettled: (result) => { done(outcomeOf(result)); }, onDispatchError: (message) => { done({ ok: false, text: message }); } });
            return true;
        },
        draw(burst, card) {
            const bot = store.bot(burst.botId);
            const line = cardLine(burst, card);
            if (!burst.cardMessageId)
                return store.appendMessage(burst.threadId, { role: "bot", kind: "burst", text: line, burst: card, ...(bot ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}) }).id;
            store.patchMessage(burst.threadId, burst.cardMessageId, { text: line, burst: card });
            return burst.cardMessageId;
        },
        postParts(burst, parts) {
            const language = deps.language(burst.threadId);
            const body = parts.map((child) => child.status === "done"
                ? `**${child.title}**\n\n${child.result ?? ""}`
                : `**${child.title}**: ${serverLine(language, "server.burst.partFailed", { reason: child.error ?? "" })}`).join("\n\n");
            const text = `${serverLine(language, "server.burst.partsHeader", { task: burst.task })}\n\n${body}`;
            store.appendMessage(burst.threadId, { role: "bot", kind: "text", text: redactSecretsInText(text) });
            return text;
        },
        deliver(burst, text) {
            const bot = store.bot(burst.botId);
            if (!bot)
                return;
            const notifiable = { id: bot.id, name: bot.name, threadId: burst.threadId, notifications: bot.notifications };
            const short = buildNotification("done", notifiable, burst.threadId, text, { avatarUrl: bot.avatarUrl });
            if (!short)
                return;
            const clean = redactSecretsInText(text);
            const routed = deps.route({ ...short, body: clean.length > INBOX_TEXT_MAX ? `${clean.slice(0, INBOX_TEXT_MAX - 1).trimEnd()}…` : clean });
            if (routed)
                deps.announce({ ...routed, body: summarize(clean) });
        },
        ...(deps.log ? { log: deps.log } : {}),
    });
    return Object.assign(manager, {
        model(bot, threadId) {
            const selection = deps.defaultModel(bot, threadId);
            return { selection, name: deps.modelName(selection) };
        },
    });
}
/** The bot's own engine's fast model when it has one this bot may use; otherwise the chat's own model. */
export function burstDefaultModel(input) {
    const fast = fastModelFor(input.catalog(input.own.instanceId), input.own.model, input.refused(input.own.instanceId));
    if (!fast || fast === input.own.model)
        return input.own;
    const selection = { instanceId: input.own.instanceId, model: fast };
    return input.usable(selection) ? selection : input.own;
}
export const BURST_ROOM_REFUSAL = "A burst runs from a bot's own chat, not a room. Ask the person to start it there.";
export const BURST_OUTSIDE_REFUSAL = "This work came in from outside, so it can't open a burst. Finish it here.";
/** Who may open a burst: a person's own request in the bot's own chat, the same rule as opening a thread on yourself. */
export function burstProposalRefusal(input) {
    if (!input.owner)
        return "source conversation does not belong to sender";
    if (input.owner.group)
        return BURST_ROOM_REFUSAL;
    if (input.outside)
        return BURST_OUTSIDE_REFUSAL;
    return input.self ?? null;
}
