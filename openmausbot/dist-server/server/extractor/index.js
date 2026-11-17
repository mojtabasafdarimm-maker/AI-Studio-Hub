import { helpersOn, includedAccount, openrouterAccount, sharedOpenRouterKey, workersAiAccount } from "../decider/accounts.js";
import { EXTRACT_KEY_CHECK, extractRequestProblem, relayAcceptsExtract } from "./contract.js";
import { extractWithOpenRouter, extractWithRelay, OPENROUTER_EXTRACT_MODEL } from "./remote.js";
import { extractWithWorkersAi } from "./workers-ai.js";
export const DEFAULT_EXTRACT_TIMEOUT_MS = 8_000;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 30_000;
/** In order: own Workers AI, Cloud's included relay (only for requests it accepts), OpenRouter, nothing. */
export function extractorAccount(cfg, request) {
    const candidates = [workersAiAccount(cfg), includedAccount(), openrouterAccount(cfg)];
    return candidates.find((account) => Boolean(account) && !(account.included && request && !relayAcceptsExtract(request.seam, request.fields, request.input))) ?? null;
}
export function extractorReady(cfg) {
    return helpersOn(cfg, extractorAccount(cfg));
}
/** Settings: which backend reads, never a key. */
export function describeExtractor(cfg) {
    const account = extractorAccount(cfg);
    return { ...(account ? { provider: account.provider } : {}), ...(account?.included ? { included: true } : {}), ready: helpersOn(cfg, account) };
}
/** The OpenRouter model extraction uses: the decider's own when it is a chat model, else a default one. */
function openrouterModel(cfg) {
    const own = cfg.decider?.openrouterModel?.trim();
    return own && cfg.decider?.openrouterApi === "chat" ? own : OPENROUTER_EXTRACT_MODEL;
}
const today = (timeZone) => {
    try {
        return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    }
    catch {
        return new Date().toISOString().slice(0, 10);
    }
};
export function createExtractor(deps) {
    const fetchImpl = deps.fetch ?? fetch;
    const now = deps.now ?? (() => performance.now());
    async function call(account, cfg, seam, fields, input, options) {
        const provider = account.provider;
        if (options.signal?.aborted)
            return { ok: false, provider, reason: "cancelled" };
        const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_EXTRACT_TIMEOUT_MS));
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        options.signal?.addEventListener("abort", onAbort, { once: true });
        let timer;
        const timedOut = new Promise((resolve) => {
            timer = setTimeout(() => {
                controller.abort();
                resolve({ ok: false, reason: "timeout" });
            }, timeoutMs);
        });
        const request = {
            key: account.token, baseUrl: account.api, ...(account.accountId ? { accountId: account.accountId } : {}),
            ...(provider === "openrouter" ? { model: openrouterModel(cfg) } : {}),
            seam, fields, input, referenceDate: today(deps.timeZone?.()), signal: controller.signal, fetch: fetchImpl,
        };
        const backend = provider === "workersai" ? extractWithWorkersAi : provider === "openrouter" ? extractWithOpenRouter : extractWithRelay;
        const started = now();
        let outcome;
        try {
            outcome = await Promise.race([Promise.resolve().then(() => backend(request)).catch(() => ({ ok: false, reason: "malformed" })), timedOut]);
        }
        finally {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
        }
        const latencyMs = Math.max(0, Math.round(now() - started));
        if (!outcome.ok) {
            const reason = outcome.reason !== "timeout" && options.signal?.aborted ? "cancelled" : outcome.reason;
            return { ok: false, provider, reason, ...(outcome.status ? { status: outcome.status } : {}), latencyMs };
        }
        return { ok: true, provider, values: outcome.values, ...(outcome.model ? { model: outcome.model } : {}), latencyMs };
    }
    return {
        async extract(seam, fields, input, options = {}) {
            try {
                if (extractRequestProblem(fields, input) !== null)
                    return { ok: false, reason: "misconfigured" };
                const cfg = deps.config();
                if (cfg.decider?.provider === "off")
                    return { ok: false, reason: "disabled" };
                const any = extractorAccount(cfg);
                if (!any)
                    return { ok: false, reason: cfg.decider?.enabled === true ? "no_key" : "disabled" };
                if (!helpersOn(cfg, any))
                    return { ok: false, reason: "disabled" };
                if (seam === "inboxTriage" && cfg.decider?.jobs?.inboxTriage === false)
                    return { ok: false, reason: "job_off" };
                const account = extractorAccount(cfg, { seam, fields, input });
                // Through the included token, only the exact requests the relay takes.
                if (!account)
                    return { ok: false, reason: any.included ? "misconfigured" : "no_key" };
                return await call(account, cfg, seam, fields, input, options);
            }
            catch {
                return { ok: false, reason: "malformed" };
            }
        },
        async testKey(options = {}) {
            try {
                const cfg = deps.config();
                const account = extractorAccount(cfg, { seam: "keyCheck", ...EXTRACT_KEY_CHECK });
                if (!account)
                    return { ok: false, reason: "no_key" };
                return await call(account, cfg, "keyCheck", EXTRACT_KEY_CHECK.fields, EXTRACT_KEY_CHECK.input, { timeoutMs: 10_000, ...options });
            }
            catch {
                return { ok: false, reason: "malformed" };
            }
        },
    };
}
/** Settings' "Routing and extraction" section (AI page): which of the person's own keys are on file and who reads, never a key.
 * The Cloudflare account ID is not a secret, so it is shown back. */
export function describeHelpers(cfg) {
    const accountId = cfg.decider?.workersAiAccountId?.trim();
    return {
        own: { jev: Boolean(cfg.decider?.key?.trim()), workersAi: Boolean(cfg.decider?.workersAiToken?.trim()), openrouter: Boolean(cfg.decider?.openrouterKey?.trim()) },
        ...(sharedOpenRouterKey(cfg) ? { sharedKey: true } : {}),
        ...(accountId ? { workersAiAccountId: accountId } : {}),
        extraction: describeExtractor(cfg),
    };
}
