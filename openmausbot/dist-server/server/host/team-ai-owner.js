// Who connects an AI for a team: its owner. A User can't, so what they read names the owner rather than telling them to.
import { nameFromEmail } from "../../shared/bot-owner.js";
import { personKey } from "../person-key.js";
/** The team's owner by the name they chose. The Admin names a person here only when they first pair, so null until the
 * owner has opened the team. */
export function teamAiOwner(people, chosenName) {
    const owner = people.find((person) => person.role === "owner");
    if (!owner)
        return null;
    const chosen = chosenName(personKey({ id: "", email: owner.email }))?.trim();
    return { email: owner.email, name: chosen && chosen !== owner.email ? chosen : nameFromEmail(owner.email) };
}
