// What a secure card offers under "Use a saved one": Vault items whose names could fit what the bot asked for, by name
// only. Picking one lets the asking bot use it from then on and answers the card, so nobody types it again.
import { loginMatchesHost, loginUsableBy } from "../../shared/logins.js";
import { vaultNameKey } from "../../shared/vault.js";
/** Words that say what kind of thing it is, not whose: alone they would make every key fit every card. */
const KIND_WORDS = new Set(["a", "an", "the", "my", "of", "for", "to", "and", "api", "key", "keys", "token", "tokens", "secret", "secrets",
    "password", "passwords", "access", "value", "id", "auth", "app", "live", "test", "prod"]);
const CHOICES_MAX = 5;
function nameWords(name) {
    return new Set(vaultNameKey(name).split(" ").filter((word) => word.length > 1 && !KIND_WORDS.has(word)));
}
/** How many telling words two names share: "Stripe secret key" and STRIPE_LIVE_KEY share one. */
export function nameFit(asked, name) {
    const wanted = nameWords(asked);
    let shared = 0;
    for (const word of nameWords(name))
        if (wanted.has(word))
            shared++;
    return shared;
}
/** The few items that share a telling word with what was asked, closest first. */
export function fittingChoices(asked, items) {
    return items.map((item) => ({ item, fit: nameFit(asked, item.name) })).filter(({ fit }) => fit > 0)
        .sort((a, b) => b.fit - a.fit || a.item.name.localeCompare(b.item.name)).slice(0, CHOICES_MAX).map(({ item }) => item);
}
/** The sign-in card's "Use a saved login": saved logins for the card's site that the bot may not use yet. */
export function createSignInVaultChoices(deps) {
    const choices = (botId, threadId, messageId) => {
        const card = deps.openCard(botId, threadId, messageId);
        let host = "";
        try {
            host = card ? new URL(card.url).hostname.toLowerCase() : "";
        }
        catch { }
        if (!host)
            return [];
        const bots = deps.cardBots(botId);
        return deps.logins.list().filter((login) => loginMatchesHost(login, host) && !loginUsableBy(login, bots)).slice(0, CHOICES_MAX);
    };
    return {
        list(botId, threadId, messageId) {
            const found = choices(botId, threadId, messageId).map((login) => ({ id: login.id, name: login.username || login.site }));
            return { status: 200, body: { choices: found } };
        },
        use(botId, threadId, messageId, loginId) {
            const login = choices(botId, threadId, messageId).find((one) => one.id === loginId);
            if (!login)
                return { status: 404, body: { error: "That saved login is gone, or this sign-in request was already answered." } };
            if (login.bots !== "all")
                deps.logins.update(login.id, { bots: [...new Set([...login.bots, ...deps.cardBots(botId)])] });
            return deps.settle(botId, threadId, messageId, "done", { site: login.site });
        },
    };
}
