// A bot named like a person here: "@Bob" reaches the teammate Bob, never a bot of that name (shared/person-mention.ts),
// so a bot made or renamed with a teammate's name, or the owner's own, says so once in its own chat, and the Chief's
// create_bot hears it in its result. Nothing is refused: the person may keep the name.
import { PERSON_TAG, personNameClash, personTagNames } from "../../shared/person-mention.js";
import { conversationLanguage, serverLine } from "../server-lines.js";
export function createBotNameClash(deps) {
    const { store } = deps;
    /** Each bot's name when last looked at: only a new name is checked, so a restart says nothing again. */
    const seen = new Map(store.bots.map((bot) => [bot.id, bot.name]));
    function people() {
        const own = deps.profileName()?.trim();
        const tags = own ? personTagNames(own).filter((tag) => tag !== PERSON_TAG) : [];
        return [...deps.people(), ...(own && tags.length ? [{ name: own, tags }] : [])];
    }
    const line = (person, name, language) => serverLine(language, "server.bots.nameClash", { person, name });
    /** The warning a bot named `name` gets in create_bot's result (English, for the model), or null when no person here
     * goes by it. */
    function warning(name) {
        const person = personNameClash(name, people());
        return person ? line(person, name) : null;
    }
    const unsubscribe = store.onChange((change) => {
        if (change.type === "bot.deleted") {
            seen.delete(change.botId);
            return;
        }
        if (change.type !== "bot")
            return;
        const bot = store.bot(change.botId);
        if (!bot || seen.get(bot.id) === bot.name)
            return;
        seen.set(bot.id, bot.name);
        const person = bot.hidden ? null : personNameClash(bot.name, people());
        if (person)
            store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: `notice: ${line(person, bot.name, conversationLanguage(bot.threadId))}`, ok: true } });
    });
    return { warning, stop: unsubscribe };
}
