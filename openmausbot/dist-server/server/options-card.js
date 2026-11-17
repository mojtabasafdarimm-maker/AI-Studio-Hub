import { parseOptionsCardInput, WATCHER_OPTIONS_CARD_BOT_ID, } from "../shared/options-card.js";
/** Passive: no requestId or tool field, so a click grants no tool approval and performs no external action. */
export function createOptionsCard(args) {
    if (args.bot.id !== WATCHER_OPTIONS_CARD_BOT_ID) {
        return { ok: false, status: 403, error: "create_options_card is not enabled for this bot." };
    }
    const parsed = parseOptionsCardInput(args.input);
    if (!parsed.ok)
        return { ok: false, status: 400, error: parsed.error };
    const message = args.store.appendMessage(args.threadId, {
        role: "bot",
        kind: "options",
        from: { botId: args.bot.id, name: args.bot.name, color: args.bot.color },
        card: parsed.value,
    });
    return { ok: true, messageId: message.id };
}
