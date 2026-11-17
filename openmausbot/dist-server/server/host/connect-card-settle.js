import { NEEDS_YOU_WINDOW_MS } from "../../shared/today.js";
const accountKey = (alias) => alias?.trim().toLowerCase() ?? "";
/** Returns how many cards it settled. MCP sign-in cards, and cards dismissed, superseded, stopped or resumed, are left as they are. */
export function settleOpenConnectCards(deps, slug, alias) {
    const app = slug.toLowerCase();
    const account = accountKey(alias);
    let settled = 0;
    const since = deps.now() - NEEDS_YOU_WINDOW_MS;
    for (const threadId of deps.threadsWithCards(since)) {
        const resumeKeys = new Set();
        for (const message of deps.messagesFor(threadId)) {
            const card = message.kind === "connector" ? message.connector : undefined;
            if (!card || message.at < since || card.source === "mcp" || card.slug.toLowerCase() !== app || accountKey(card.alias) !== account)
                continue;
            if (card.status === "connected" || card.dismissed || card.superseded || card.stopped || card.resumed)
                continue;
            deps.patchMessage(threadId, message.id, { connector: { ...card, status: "connected", error: undefined } });
            resumeKeys.add(card.resumeKey);
            settled++;
        }
        for (const resumeKey of resumeKeys)
            deps.resume(threadId, resumeKey);
    }
    return settled;
}
/** The host's two moments an account connects: a connect card's own check, and Settings asking about apps it is connecting. */
export function createConnectCardSettle(deps) {
    return {
        card: (slug, alias) => settleOpenConnectCards(deps, slug, alias),
        services(services) {
            for (const [slug, service] of Object.entries(services)) {
                if (service?.connected)
                    settleOpenConnectCards(deps, slug);
                for (const account of service?.accounts ?? [])
                    if (account.alias && /^active$/i.test(account.status))
                        settleOpenConnectCards(deps, slug, account.alias);
            }
        },
    };
}
