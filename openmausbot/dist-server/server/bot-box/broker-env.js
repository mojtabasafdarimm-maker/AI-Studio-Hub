import { brokerUrl } from "./broker.js";
/** The providers whose CLIs take a base URL from the environment. A key with no such knob stays as it is, and the report
 * names it (`unbrokered`), so the gap is visible rather than silent. */
export const BROKERED_PROVIDERS = [
    { name: "anthropic", keyEnv: "ANTHROPIC_API_KEY", baseUrlEnv: "ANTHROPIC_BASE_URL", header: "x-api-key", defaultUpstream: "https://api.anthropic.com" },
    { name: "anthropic-token", keyEnv: "ANTHROPIC_AUTH_TOKEN", baseUrlEnv: "ANTHROPIC_BASE_URL", header: "authorization", defaultUpstream: "https://api.anthropic.com" },
    { name: "openai", keyEnv: "OPENAI_API_KEY", baseUrlEnv: "OPENAI_BASE_URL", header: "authorization", defaultUpstream: "https://api.openai.com/v1" },
    { name: "gemini", keyEnv: "GEMINI_API_KEY", baseUrlEnv: "GOOGLE_GEMINI_BASE_URL", header: "x-goog-api-key", defaultUpstream: "https://generativelanguage.googleapis.com" },
    { name: "google", keyEnv: "GOOGLE_API_KEY", baseUrlEnv: "GOOGLE_GEMINI_BASE_URL", header: "x-goog-api-key", defaultUpstream: "https://generativelanguage.googleapis.com" },
];
/** Keys the box would otherwise carry raw: named in the report when present. */
export const UNBROKERED_KEY_ENV = [
    "XAI_API_KEY", "MISTRAL_API_KEY", "CEREBRAS_API_KEY", "GROQ_API_KEY", "GREENFERENCE_API_KEY", "MODELGO_API_KEY", "META_API_KEY", "MINIMAX_API_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY",
    "CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "FACTORY_API_KEY", "CLINE_API_KEY", "OPENCODE_API_KEY", "OPENROUTER_API_KEY",
];
/** A key's value that already is a broker token (a re-wrap, a self-check) is left alone. */
const isToken = (value) => value.startsWith("omb_t0_");
/** Looks like an address the broker can forward to: http(s), no credentials in it. */
export function usableUpstream(value, fallback) {
    if (!value)
        return fallback;
    try {
        const url = new URL(value);
        if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password)
            return value.replace(/\/+$/, "");
    }
    catch { }
    return fallback;
}
/**
 * The rewrite for one spawn: `token` is the per-process token the caller minted (the grants here are what it gets), and
 * `port` the broker's port inside the box. Nothing changes for an environment that holds no brokered key.
 */
export function brokerRewrite(env, token, port) {
    const out = { ...env };
    const grants = {};
    for (const provider of BROKERED_PROVIDERS) {
        const key = out[provider.keyEnv];
        if (!key || isToken(key))
            continue;
        const upstream = usableUpstream(out[provider.baseUrlEnv], provider.defaultUpstream);
        // A base URL that already points at this broker (a re-wrap) keeps its grant's upstream unknown: refuse by leaving the key.
        if (/^http:\/\/127\.0\.0\.1:\d+\/b\//.test(upstream))
            continue;
        const value = provider.header === "authorization" ? `Bearer ${key}` : key;
        grants[provider.name] = { upstream, headers: { [provider.header]: value } };
        out[provider.keyEnv] = token;
        out[provider.baseUrlEnv] = brokerUrl(port, token, provider.name);
    }
    const unbrokered = UNBROKERED_KEY_ENV.filter((name) => out[name] && !isToken(out[name]));
    return { env: out, grants, unbrokered };
}
