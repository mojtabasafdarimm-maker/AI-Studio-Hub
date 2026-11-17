import { deciderCredential } from "../included-services.js";
import { WORKERS_AI_ACCOUNT_ID } from "./config.js";
import { customEndpoint } from "./custom.js";
import { GEMINI_DECIDER_URL } from "./gemini.js";
import { OPENROUTER_DEFAULT_BASE_URL } from "./openrouter.js";
import { WORKERS_AI_DEFAULT_BASE_URL } from "./workers-ai.js";
/** The engine's OpenRouter key, only while the decider's OpenRouter address is OpenRouter's own. */
export function sharedOpenRouterKey(cfg) {
    const baseUrl = cfg.decider?.openrouterBaseUrl?.trim();
    if (baseUrl && baseUrl !== OPENROUTER_DEFAULT_BASE_URL)
        return undefined;
    return cfg.openrouter?.key?.trim() || undefined;
}
/** The OpenRouter key the decider uses: its own, else the one under Settings → API keys. */
export function deciderOpenRouterKey(cfg, draft) {
    const own = draft?.trim() || cfg.decider?.openrouterKey?.trim();
    if (own)
        return { token: own, source: "own" };
    const shared = sharedOpenRouterKey(cfg);
    return shared ? { token: shared, source: "shared" } : null;
}
/** The person's own Workers AI token with its account ID: one without the other is nothing. */
export function workersAiAccount(cfg, draft = {}) {
    const token = draft.token?.trim() || cfg.decider?.workersAiToken?.trim();
    const accountId = draft.accountId?.trim() || cfg.decider?.workersAiAccountId?.trim();
    if (!token || !accountId || !WORKERS_AI_ACCOUNT_ID.test(accountId))
        return null;
    return { provider: "workersai", token, accountId: accountId.toLowerCase(), api: cfg.decider?.workersAiBaseUrl?.trim() || WORKERS_AI_DEFAULT_BASE_URL, included: false };
}
export function jevAccount(cfg, draft) {
    const own = draft?.trim() || cfg.decider?.key?.trim();
    if (!own)
        return null;
    const credential = deciderCredential(own, cfg.decider?.baseUrl);
    return credential ? { ...credential, provider: "jev" } : null;
}
/** The person's own gateway: a key with nowhere safe to send it is nothing. */
export function customAccount(cfg, draft) {
    const token = draft?.trim() || cfg.decider?.customKey?.trim();
    const base = cfg.decider?.customBaseUrl?.trim();
    if (!token || !base || !customEndpoint(base, "systemone"))
        return null;
    return { provider: "custom", token, api: base, included: false };
}
/** Cloud's included relay, a Jev base URL whose `/v1/extract` also extracts. */
export function includedAccount() {
    const credential = deciderCredential(undefined, undefined);
    return credential?.included ? { ...credential, provider: "jev" } : null;
}
/** The Gemini key saved for speech, else the one saved for images: Google's Decisions API takes either. */
export function geminiAccount(cfg) {
    const token = cfg.tts?.geminiKey?.trim() || cfg.imageGen?.geminiKey?.trim();
    return token ? { provider: "gemini", token, api: GEMINI_DECIDER_URL, included: false } : null;
}
export function openrouterAccount(cfg, draft) {
    const key = deciderOpenRouterKey(cfg, draft);
    return key ? { provider: "openrouter", token: key.token, api: cfg.decider?.openrouterBaseUrl?.trim() || OPENROUTER_DEFAULT_BASE_URL, included: false, keySource: key.source } : null;
}
/** On and usable: the helper models' one switch. An included relay is on unless switched off; an own key once switched on. */
export function helpersOn(cfg, account) {
    if (!account || cfg.decider?.provider === "off")
        return false;
    return account.included ? cfg.decider?.enabled !== false : cfg.decider?.enabled === true;
}
