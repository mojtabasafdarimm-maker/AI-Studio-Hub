import { botOwner, nameFromEmail } from "../../shared/bot-owner.js";
import { personKey } from "../person-key.js";
/** The name of the member who looks after a team bot, for a line the bot reads; null when nobody does. */
export function lookedAfterBy(bot, personName) {
    const email = botOwner(bot);
    if (!email)
        return null;
    const name = personName(personKey({ id: "", email }));
    return name && name !== email ? name : nameFromEmail(email);
}
