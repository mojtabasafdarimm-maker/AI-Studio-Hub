import { conversationLanguage, serverLine } from "../server-lines.js";
export function tellTurnedBackOn(store, routines) {
    const byBot = new Map();
    for (const routine of routines)
        byBot.set(routine.botId, [...(byBot.get(routine.botId) ?? []), routine.name]);
    for (const [botId, names] of byBot) {
        const bot = store.bot(botId);
        if (!bot)
            continue;
        const line = serverLine(conversationLanguage(bot.threadId), names.length === 1 ? "server.routines.turnedBackOn" : "server.routines.turnedBackOnMany", { names: names.join(", ") });
        store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: `notice: ${line}`, ok: true } });
    }
}
