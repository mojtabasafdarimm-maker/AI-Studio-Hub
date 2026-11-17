// Sharing a team bot with a person tells that person, once, in their inbox: "Ada shared Quotes with you." Sharing with
// everyone tells nobody, and neither does adding someone who could already use the bot.
import { sharedLevel } from "../../shared/bot-access.js";
import { nameFromEmail } from "../../shared/bot-owner.js";
import { personKey } from "../person-key.js";
/** The members `after` lets use the bot who could not before: named one by one, never through "everyone", and never an
 * admin, who reaches every bot already. */
export function newlyShared(before, after, people) {
    return people.filter((person) => person.role === "member" && Object.hasOwn(after.people, person.email)
        && sharedLevel(before, person.email) === "none").map((person) => person.email);
}
export function createShareNotice(deps) {
    return (auth, bot, before, after) => {
        const by = auth.kind === "session" ? auth.session.email?.trim().toLowerCase() : undefined;
        const name = by ? deps.profileName(by)?.trim() || nameFromEmail(by) : "An admin";
        const main = deps.store().tasks(bot.id).filter((task) => !task.routineRunId).sort((a, b) => a.createdAt - b.createdAt)[0];
        for (const email of newlyShared(before, after, deps.people())) {
            if (email === by)
                continue;
            deps.inbox().deliver(personKey({ id: "", email }), {
                kind: "notice", from: { name, ...(by ? { email: by } : {}) }, ...(main ? { origin: { botId: bot.id, threadId: main.threadId } } : {}),
                text: `${name} shared ${bot.name} with you.`, title: `${bot.name} is shared with you`, notify: "done",
            });
        }
    };
}
