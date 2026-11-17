import { BLOCK_OPEN as APP_EVENT_DATA } from "./app-events.js";
import { answeredByPerson } from "./cloud-lending.js";
import { routinePrompt } from "./routine-execution.js";
import { WEBHOOK_EVENT_DATA } from "./webhooks.js";
/** Security invariant: only a user line nobody else's words or no automation made. A peer's ask or aside, a line a
 * script or an outside interface relayed, and a routine's, webhook's or app event's own prompt are never the owner's,
 * however they arrive; a webhook's post is a bot's line. */
export function ownersOwnLine(row) {
    if (row.role !== "user" || row.sender || row.peerAsk || row.aside || row.relayed || row.via === "api")
        return false;
    const text = typeof row.text === "string" ? row.text : "";
    return !routinePrompt(text) && !text.includes(WEBHOOK_EVENT_DATA) && !text.includes(APP_EVENT_DATA);
}
/** Security invariant: a card counts as the owner's only when the owner answered it in that computer's own window. */
function answeredInWindow(card) {
    return answeredByPerson(card) && (!card.answeredBy || card.answeredBy.kind === "loopback");
}
/** A row of the owner's own that does not carry them yet: a line they wrote, or a card they answered, in that
 * computer's own window. */
export const unstamped = (row) => ownersOwnLine(row) || Boolean(row.card && answeredInWindow(row.card));
/** What makes a row the owner's on My Cloud; null when it is someone else's, an automation's, or carries them already. */
export function ownerStamp(row, owner) {
    const line = ownersOwnLine(row);
    const card = row.card && answeredInWindow(row.card) ? row.card : null;
    if (!line && !card)
        return null;
    const answeredBy = { kind: "session", name: owner.name, person: owner.person, ...(card?.answeredBy?.via ? { via: card.answeredBy.via } : {}) };
    return { ...(line ? { sender: { name: owner.name, id: owner.person } } : {}), ...(card ? { card: { ...card, answeredBy } } : {}) };
}
/** A conversation's rows as My Cloud keeps them: the owner's own lines and answers carry the owner. */
export function stampOwner(rows, owner) {
    return rows.map((row) => {
        const stamp = ownerStamp(row, owner);
        return stamp ? { ...row, ...stamp } : row;
    });
}
