import { isMentionBoundary, isMentionNameContinuation } from "./mention-boundary.js";
/** The most bot ids one send may carry as picks from the @ list. */
export const MENTION_PICKS_MAX = 20;
/** `picked`: ids a person chose from the @ list. A pick never adds a bot whose name the line does not @-tag; it only
 * says which of the bots sharing that name was meant. */
export function resolveMentions(text, peers, picked = []) {
    const candidates = peers
        .filter((peer) => !peer.hidden && peer.name.trim())
        .sort((a, b) => b.name.length - a.name.length);
    const bots = [];
    const ambiguous = [];
    for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
        if (!isMentionBoundary(text, at))
            continue;
        const named = (peer) => text.slice(at + 1, at + 1 + peer.name.length).toLowerCase() === peer.name.toLowerCase();
        const hit = candidates.find((peer) => named(peer) && !isMentionNameContinuation(text.slice(at + 1 + peer.name.length)));
        if (!hit)
            continue;
        const sharing = candidates.filter((peer) => peer.name.toLowerCase() === hit.name.toLowerCase());
        const chosen = sharing.filter((peer) => peer.id !== undefined && picked.includes(peer.id));
        if (sharing.length > 1 && !chosen.length && !ambiguous.some((group) => group[0] === sharing[0]))
            ambiguous.push(sharing);
        for (const peer of sharing.length > 1 && chosen.length ? chosen : sharing)
            if (!bots.includes(peer))
                bots.push(peer);
    }
    return { bots, ambiguous };
}
/** The `mentions` a send carries: undefined when absent, null when it is not a short list of ids. */
export function parseMentionPicks(value) {
    if (value === undefined || value === null)
        return undefined;
    if (!Array.isArray(value) || value.length > MENTION_PICKS_MAX)
        return null;
    if (!value.every((id) => typeof id === "string" && /^[\w-]{1,128}$/.test(id)))
        return null;
    return [...new Set(value)];
}
