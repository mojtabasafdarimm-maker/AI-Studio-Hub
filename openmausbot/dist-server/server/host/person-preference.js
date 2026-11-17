import { layerId, memberAudience } from "../audience.js";
export function createPersonPreference(deps) {
    return {
        /** Where `bot`'s turn may save a preference; null when no one person's own words began its work. */
        target(turn, bot) {
            if (deps.team) {
                const person = deps.requester(turn.threadId, turn.generation);
                if (!person)
                    return null;
                const name = deps.personName(person);
                // Their own layer of this bot, which is how About me finds the person it belongs to.
                const layer = layerId(bot.id, memberAudience(person));
                return { ...(name ? { person: name } : {}), save: (text) => deps.aboutMe.learn({ botId: layer, botName: bot.name }, [text]) };
            }
            return deps.userStarted(turn) ? { save: (text) => deps.aboutMe.learn({ botId: bot.id, botName: bot.name }, [text]) } : null;
        },
    };
}
