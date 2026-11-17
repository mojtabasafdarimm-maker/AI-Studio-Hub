/** The site as a page address and the host shown on the card. A bare
 * domain means its https home page. Anything that is not a plain http(s)
 * address — a script URL, a file, an address carrying a username or
 * password — is refused, so the card can never open more than a page. */
export function normalizeSignInSite(raw) {
    if (typeof raw !== "string")
        return null;
    const text = raw.trim();
    // eslint-disable-next-line no-control-regex -- Reject control characters and spaces before URL parsing normalizes them.
    if (!text || text.length > 2048 || /[\u0000- \u007f\\]/u.test(text))
        return null;
    let url;
    try {
        url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`);
    }
    catch {
        return null;
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password)
        return null;
    // A bare word is no site ("example" would parse as a host); localhost and
    // addresses are the exceptions a developer's own app needs.
    if (!url.hostname.includes(".") && url.hostname !== "localhost" && !url.hostname.startsWith("["))
        return null;
    return { url: url.href, site: url.hostname.replace(/^www\./, "") };
}
/** A still-open sign-in card for this site — the set a newer request
 * supersedes. Done, cancelled, already-superseded and answered-in-chat
 * cards keep their settled state. In a room only the asking bot's own
 * cards count. */
export function isPendingSignInRequest(message, site, requestingBotId, roomThread) {
    return (message.kind === "signin" &&
        message.signIn?.site === site &&
        signInWaits(message.signIn) &&
        (!roomThread || message.from?.botId === requestingBotId));
}
/** Whether the card still waits on the person: not done, cancelled, superseded or answered in the chat. */
export function signInWaits(card) {
    return card.done !== true && card.cancelled !== true && card.superseded !== true && card.answeredInChat !== true;
}
/** Whether a sign-in card, if there still is one, waits on the person: not stopped and still open. */
export function signInCardWaits(card) {
    return card !== undefined && card.stopped !== true && signInWaits(card);
}
/** How a card ended, or null while it is open. */
export function signInOutcome(state) {
    if (state.done === true)
        return "done";
    if (state.cancelled === true)
        return "cancelled";
    return null;
}
/** The line that resumes the bot, through the same continuation the
 * credential card uses. */
export function signInResumePrompt(site, outcome) {
    return outcome === "done"
        ? `OpenMausBot sign-in update: the person finished signing in to ${site}. Check you are signed in, then continue the task that paused for it. Never ask them for a password or a one-time code in chat.`
        : `OpenMausBot sign-in update: the person declined to sign in to ${site}. Continue without it if you can, or briefly explain what you could not do. Never ask them for a password or a one-time code in chat.`;
}
