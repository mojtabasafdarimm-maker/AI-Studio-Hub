import { z } from "zod";
import { persistableInstanceConfigs } from "./config.js";
import { PROVIDER_ICON_PRESETS } from "../shared/provider-icon.js";
import { isOllamaServer } from "./drivers/ollama.js";
const iconSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("preset"), preset: z.enum(PROVIDER_ICON_PRESETS) }).strict(),
    z.object({ kind: z.literal("custom"), dataUrl: z.string() }).strict(),
]);
export const providerIconPatchSchema = z.object({ icon: iconSchema.nullable() }).strict();
export function withInstanceIcon(cfg, instanceId, icon) {
    const next = structuredClone(cfg);
    const instances = persistableInstanceConfigs(next);
    if (!Object.hasOwn(instances, instanceId))
        return { ok: false, config: cfg, instances };
    if (icon)
        instances[instanceId].icon = icon;
    else
        delete instances[instanceId].icon;
    next.instances = instances;
    return { ok: true, config: next, instances };
}
/** Who runs a server, by its host. `*` is one DNS label, or the rest of one. Only providers we have a mark for:
 * Groq, Together, Fireworks and LM Studio servers keep the driver's own mark; Ollama isn't told by its host. */
const SERVER_HOSTS = {
    "api.openai.com": "openai", "*.api.openai.com": "openai",
    "*.openai.azure.com": "azure", "*.services.ai.azure.com": "azure", "*.cognitiveservices.azure.com": "azure",
    "bedrock-runtime.*.amazonaws.com": "aws",
    "generativelanguage.googleapis.com": "google", "aiplatform.googleapis.com": "google", "*-aiplatform.googleapis.com": "google",
    "api.x.ai": "xai",
    "api.deepseek.com": "deepseek",
    "dashscope.aliyuncs.com": "qwen", "dashscope-*.aliyuncs.com": "qwen",
    "*.*.maas.aliyuncs.com": "qwen",
    "api.moonshot.ai": "moonshot", "api.moonshot.cn": "moonshot",
    "api.mistral.ai": "mistral", "codestral.mistral.ai": "mistral",
    "api.cohere.com": "cohere", "api.cohere.ai": "cohere",
    "openrouter.ai": "openrouter", "*.openrouter.ai": "openrouter",
    "api.anthropic.com": "anthropic",
    "api.llama.com": "meta", "api.meta.ai": "meta",
};
const SERVER_MARKS = Object.entries(SERVER_HOSTS).map(([host, preset]) => [new RegExp(`^${host.replaceAll(".", "\\.").replaceAll("*", "[a-z0-9-]+")}$`), preset]);
/** The provider whose mark a server address shows. Only the host counts, so a look-alike host
 * (api.openai.com.evil.test) or a provider named in the path or user name never matches. */
export function serverIconPreset(url) {
    let host;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
            return undefined;
        host = parsed.hostname.replace(/\.$/, "");
    }
    catch {
        return undefined;
    }
    return SERVER_MARKS.find(([pattern]) => pattern.test(host))?.[1];
}
const servesOllama = (entry) => entry?.driver === "openai-compat" && isOllamaServer(entry.config);
/** The mark an instance shows everywhere the instance list goes: a stored icon (set before v0.1.102) wins; an
 * OpenAI-compatible server otherwise shows the mark of whoever runs it; anything else keeps its driver's mark. */
export function instanceIcon(entry) {
    if (entry?.icon)
        return { icon: entry.icon };
    if (servesOllama(entry))
        return { icon: { kind: "preset", preset: "ollama" } };
    const url = entry?.driver === "openai-compat" ? entry.config?.url : undefined;
    const preset = typeof url === "string" ? serverIconPreset(url) : undefined;
    return preset ? { icon: { kind: "preset", preset } } : {};
}
/** How the instance list shows an instance: its mark, and for an OpenAI-compatible server that is really Ollama,
 * `serverKind` and Ollama's name in place of the driver's own (a name someone gave it stays). */
export function instanceLook(entry) {
    if (!servesOllama(entry))
        return instanceIcon(entry);
    return { ...instanceIcon(entry), serverKind: "ollama", ...(entry.displayName ? {} : { displayName: "Ollama" }) };
}
