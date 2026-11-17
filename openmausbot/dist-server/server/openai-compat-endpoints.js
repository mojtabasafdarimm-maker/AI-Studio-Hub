import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isOllamaServer, OLLAMA_PLACEHOLDER_KEY, probeOllama } from "./drivers/ollama.js";
export const ADDED_ENDPOINT_PREFIX = "openai-compat-";
/** Origin and path only. The driver appends /models and /chat/completions, and fetch refuses URLs with credentials. */
export function endpointBaseUrl(raw) {
    let url;
    try {
        url = new URL(raw.trim());
    }
    catch {
        return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
        return null;
    if (url.username || url.password || url.search || url.hash)
        return null;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}
/** What the instance list shows: never userinfo, query or fragment, even from a hand-edited config.json. */
export function endpointDisplayUrl(config) {
    const raw = config?.url;
    if (typeof raw !== "string")
        return undefined;
    try {
        const url = new URL(raw);
        return url.protocol === "https:" || url.protocol === "http:" ? `${url.origin}${url.pathname}`.replace(/\/+$/, "") : undefined;
    }
    catch {
        return undefined;
    }
}
export const addEndpointSchema = z.object({
    displayName: z.string().trim().min(1).max(80),
    url: z.string().max(512),
    key: z.string().trim().min(1).max(4096),
    models: z.array(z.string().trim().min(1).max(200)).max(64).optional(),
    catalog: z.enum(["lmstudio", "ollama"]).optional(),
}).strict();
export function isAddedEndpoint(instanceId, entry) {
    return entry?.driver === "openai-compat" && instanceId.startsWith(ADDED_ENDPOINT_PREFIX);
}
/** Ollama and LM Studio are added once per address: a second entry only shows the same engine twice. Returns why, or null. */
export function localServerAlreadyAdded(instances, rawUrl) {
    const url = endpointBaseUrl(rawUrl);
    const existing = url ? Object.entries(instances).find(([instanceId, entry]) => isAddedEndpoint(instanceId, entry) && endpointDisplayUrl(entry.config) === url) : undefined;
    return existing ? `"${existing[1].displayName ?? existing[0]}" at ${url} is already an engine (${existing[0]}). Use that one; do not add it again.` : null;
}
export function addEndpoint(instances, body) {
    const url = endpointBaseUrl(body.url);
    if (!url)
        return { error: "Enter an http or https base URL without a user name, password or query string." };
    if (/^https?:\/\//i.test(body.key))
        return { error: "That API key looks like a URL. Paste the secret key itself, not a web address." };
    const instanceId = `${ADDED_ENDPOINT_PREFIX}${randomUUID()}`;
    const models = [...new Set(body.models ?? [])];
    instances[instanceId] = {
        driver: "openai-compat", displayName: body.displayName, access: "api",
        config: { key: body.key, url, ...(models.length ? { managedModels: models } : {}), ...(body.catalog ? { catalog: body.catalog } : {}) },
    };
    return { instanceId };
}
/** A new base URL and, optionally, a new key for an added server, in place: its id, models and bots stay. A saved key is
 * only sent on to the origin (scheme, host and port) it was entered for, so a move to another origin, or from https to
 * http, needs the key again. Ollama's placeholder key is no secret and moves with it. */
export function changeEndpointAddress(instances, instanceId, change) {
    const entry = instances[instanceId];
    const config = (entry.config ?? {});
    const saved = typeof config.url === "string" ? endpointBaseUrl(config.url) : null;
    const url = change.url === undefined ? saved : endpointBaseUrl(change.url);
    if (!url)
        return { status: 400, error: "Enter an http or https base URL without a user name, password or query string." };
    if (change.apiKey !== undefined && /^https?:\/\//i.test(change.apiKey)) {
        return { status: 400, error: "That API key looks like a URL. Paste the secret key itself, not a web address." };
    }
    if (change.apiKey === undefined && config.key !== OLLAMA_PLACEHOLDER_KEY && (!saved || new URL(url).origin !== new URL(saved).origin)) {
        return { status: 400, error: "Enter the API key again: a saved key is only sent to the server it was entered for." };
    }
    if (config.catalog && url !== saved) {
        const others = Object.fromEntries(Object.entries(instances).filter(([id]) => id !== instanceId));
        const duplicate = localServerAlreadyAdded(others, url);
        if (duplicate)
            return { status: 409, error: duplicate };
    }
    entry.config = { ...config, url, ...(change.apiKey !== undefined ? { key: change.apiKey } : {}) };
    return { addressChanged: url !== saved };
}
/** Whether the server at `url` lists its models with `key`: Ollama's own list for an Ollama server, else /models. */
export async function endpointModelsReadable(config, timeoutMs = 8_000) {
    if (isOllamaServer(config))
        return ["ready", "no-models"].includes((await probeOllama(config.url, { key: config.key, timeoutMs })).state);
    try {
        const response = await fetch(`${config.url}/models`, {
            headers: { authorization: `Bearer ${config.key}` }, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok)
            return false;
        const body = await response.json();
        return Array.isArray(body) || Array.isArray(body.data);
    }
    catch {
        return false;
    }
}
export function withEndpointUrls(described, configs) {
    if (!Array.isArray(described))
        return described;
    return described.map((instance) => {
        const entry = instance.instanceId ? configs[instance.instanceId] : undefined;
        if (!entry || !isAddedEndpoint(instance.instanceId, entry))
            return instance;
        const url = endpointDisplayUrl(entry.config);
        const managedModels = entry.config?.managedModels;
        const placeholderKey = entry.config?.key === OLLAMA_PLACEHOLDER_KEY;
        return { ...instance, ...(url ? { url } : {}), ...(Array.isArray(managedModels) ? { managedModels } : {}), ...(placeholderKey ? { placeholderKey } : {}) };
    });
}
