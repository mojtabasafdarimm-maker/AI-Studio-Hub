// A Team Cloud member's own MausBot: its main chat is that person's, the way a chat they open is. Security: so it is
// private to them, an admin included, and the notes it wrote into the bot's own folder before (which anyone who sees
// the bot may read) move to their own layer the first time.
import { layerId, memberAudience } from "../audience.js";
import { defaultBotPerson } from "../../shared/default-bot.js";
export function createMausBotOwnChat(deps) {
    /** Marks the main chat as its person's at once; the notes follow, before anything else writes there. */
    const claim = (bot) => {
        const email = defaultBotPerson(bot);
        if (!email || deps.starters.get(bot.threadId) !== undefined)
            return null;
        const person = deps.personKey(email);
        deps.starters.set(bot.threadId, person);
        return deps.moveNotes(bot.id, layerId(bot.id, memberAudience(person)), person);
    };
    return {
        claim,
        /** At start, for the MausBots made before their main chat was their person's. */
        claimAll() {
            const moving = deps.bots().map(claim).filter((move) => move !== null);
            return Promise.all(moving).then(() => moving.length);
        },
    };
}
