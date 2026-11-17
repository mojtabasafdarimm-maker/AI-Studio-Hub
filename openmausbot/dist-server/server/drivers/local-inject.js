// Shared local-host inject: probe oMLX / Ollama / EXO / LM Studio / Unsloth, list what they serve
// under Custom, and decode a pick into a host + API id.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isContextName, pickedName, servedModel, serveWithWindow } from "./ollama-context.js";
export const LOCAL_HOSTS = [
    { id: "omlx", label: "oMLX", baseUrl: "http://127.0.0.1:8080/v1", apiKey: "omlx" },
    { id: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "ollama" },
    { id: "local_ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "ollama" },
    { id: "exo", label: "EXO", baseUrl: "http://127.0.0.1:52415/v1", apiKey: "exo" },
    { id: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "lm-studio" },
    { id: "unsloth", label: "Unsloth", baseUrl: "http://127.0.0.1:8888/v1", apiKeyEnv: "UNSLOTH_STUDIO_AUTH_TOKEN" },
    { id: "unsloth_api", label: "Unsloth", baseUrl: "http://127.0.0.1:8888/v1", apiKeyEnv: "UNSLOTH_STUDIO_AUTH_TOKEN" },
];
export const INJECT_SEP = "::";
const HOST_BY_ID = new Map(LOCAL_HOSTS.map((host) => [host.id, host]));
const MODEL_ID = /^[\w][\w./:+@-]*$/;
export function contextWindowsFromPs(extra) {
    const out = new Map();
    const rec = extra && typeof extra === "object" ? extra : null;
    if (!rec || !Array.isArray(rec.models))
        return out;
    for (const m of rec.models) {
        if (!m || typeof m !== "object")
            continue;
        const row = m;
        const id = typeof row.model === "string" ? row.model : typeof row.name === "string" ? row.name : null;
        const ctx = typeof row.context_length === "number" && Number.isFinite(row.context_length) && row.context_length > 0 ? row.context_length : null;
        if (id && ctx) {
            const picked = pickedName(id);
            out.set(id, ctx);
            out.set(picked, ctx);
            const baseId = picked.split(":")[0];
            const current = out.get(baseId);
            out.set(baseId, current === undefined ? ctx : Math.min(current, ctx));
        }
    }
    return out;
}
export function encodeInjectId(host, model) {
    return `${host}${INJECT_SEP}${model}`;
}
const isOllamaHost = (host) => host === "ollama" || host === "local_ollama";
const hostOrigin = (host) => host.baseUrl.replace(/\/v1\/?$/, "");
export function decodeInjectId(id) {
    if (!id)
        return null;
    const sep = id.indexOf(INJECT_SEP);
    if (sep <= 0)
        return null;
    const host = id.slice(0, sep);
    const model = id.slice(sep + INJECT_SEP.length);
    const known = HOST_BY_ID.get(host);
    if (!known || !MODEL_ID.test(model))
        return null;
    // Every engine reads the model it sends from here, so all of them use the name that carries the window.
    return { host, model: (isOllamaHost(host) ? servedModel(hostOrigin(known), model)?.model : undefined) ?? model };
}
/** The window a local pick will run with, once its turn has decided it. */
export function injectedContextWindow(id) {
    const sep = id?.indexOf(INJECT_SEP) ?? -1;
    if (sep <= 0)
        return undefined;
    const known = HOST_BY_ID.get(id.slice(0, sep));
    return known && isOllamaHost(known.id) ? servedModel(hostOrigin(known), id.slice(sep + INJECT_SEP.length))?.window : undefined;
}
/** Before a turn on an Ollama pick, settle the name that carries its window. */
export function withLocalContext(instance) {
    const adapter = instance.adapter;
    instance.adapter = {
        ...adapter,
        sendTurn: async (input) => {
            const sep = input.model?.indexOf(INJECT_SEP) ?? -1;
            const host = sep > 0 ? HOST_BY_ID.get(input.model.slice(0, sep)) : undefined;
            if (host && isOllamaHost(host.id))
                await serveWithWindow(hostOrigin(host), input.model.slice(sep + INJECT_SEP.length));
            return adapter.sendTurn(input);
        },
    };
    return instance;
}
export function localHost(id) {
    return HOST_BY_ID.get(id);
}
export function injectedApiModel(id) {
    return decodeInjectId(id)?.model ?? null;
}
/** Claude Code's settings.model is its last slug and not host-encoded, so a Custom pick of it maps
 * here instead of demanding /login. */
export function resolveInjectId(modelId, extras) {
    if (!modelId)
        return modelId;
    if (decodeInjectId(modelId))
        return modelId;
    const matches = extras.filter((row) => row.id === modelId || row.model === modelId);
    const match = matches.find((row) => row.loaded) ?? matches[0];
    return match?.id ?? modelId;
}
/** Anthropic-compatible base (Claude Code wants this without a trailing /v1). */
export function anthropicBaseUrl(host) {
    return host.baseUrl.replace(/\/v1\/?$/, "");
}
export function hostApiKey(host, env = process.env) {
    if (host.apiKeyEnv && env[host.apiKeyEnv])
        return env[host.apiKeyEnv];
    if (host.apiKey)
        return host.apiKey;
    if (host.id === "unsloth" || host.id === "unsloth_api") {
        const fromFile = readUnslothKey(env);
        if (fromFile)
            return fromFile;
    }
    return "local";
}
const CODEX_RESERVED_PROVIDERS = new Set(["openai", "ollama", "lmstudio"]);
/** Codex local providers without rewriting config.toml: secrets ride the child env, argv names the key only. */
export function codexLocalProviderArgs(env, modelId) {
    const inject = decodeInjectId(modelId);
    if (!inject || CODEX_RESERVED_PROVIDERS.has(inject.host))
        return [];
    const host = localHost(inject.host);
    if (!host)
        return [];
    const envKey = `OPENMAUSBOT_LOCAL_${host.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
    env[envKey] = hostApiKey(host, env);
    return [
        "-c",
        `model_providers.${host.id}.name=${JSON.stringify(host.label)}`,
        "-c",
        `model_providers.${host.id}.base_url=${JSON.stringify(host.baseUrl)}`,
        "-c",
        `model_providers.${host.id}.env_key=${JSON.stringify(envKey)}`,
    ];
}
function firstUnslothToken(row) {
    if (!row || typeof row !== "object")
        return null;
    const rec = row;
    for (const bucket of [rec.minted, rec.saved]) {
        if (typeof bucket === "string" && bucket)
            return bucket;
        if (Array.isArray(bucket)) {
            const token = bucket.find((value) => typeof value === "string" && value);
            if (typeof token === "string")
                return token;
        }
    }
    if (typeof rec.api_key === "string" && rec.api_key)
        return rec.api_key;
    return null;
}
function readUnslothKey(env) {
    const home = env.HOME || env.USERPROFILE || homedir();
    try {
        const raw = JSON.parse(readFileSync(join(home, ".unsloth", "studio", "auth", "agent_api_key.json"), "utf8"));
        // Older Studio wrote `{ api_key }`; current Studio writes
        // `{ servers: { "http://127.0.0.1:8888": { minted: ["sk-unsloth-…"] } } }`.
        if (raw.servers && typeof raw.servers === "object") {
            const servers = raw.servers;
            for (const url of ["http://127.0.0.1:8888", "http://localhost:8888"]) {
                const token = firstUnslothToken(servers[url]);
                if (token)
                    return token;
            }
            for (const row of Object.values(servers)) {
                const token = firstUnslothToken(row);
                if (token)
                    return token;
            }
        }
        if (typeof raw.api_key === "string" && raw.api_key)
            return raw.api_key;
        return null;
    }
    catch {
        return null;
    }
}
function idsFromModelsPayload(payload) {
    const records = Array.isArray(payload)
        ? payload
        : payload && typeof payload === "object" && Array.isArray(payload.data)
            ? payload.data
            : payload && typeof payload === "object" && Array.isArray(payload.models)
                ? payload.models
                : [];
    return records.flatMap((record) => {
        if (typeof record === "string")
            return MODEL_ID.test(record) ? [record] : [];
        if (!record || typeof record !== "object")
            return [];
        const id = record.id ?? record.name;
        if (typeof id !== "string" || !MODEL_ID.test(id))
            return [];
        const low = id.toLowerCase();
        // Our own names for a model's window are that model, not another one to pick.
        if (low.includes("embed") || low.includes("bge-") || low.includes("nomic") || isContextName(id))
            return [];
        return [id];
    });
}
async function timedJson(url, env, host, fetchImpl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    timer.unref?.();
    try {
        const response = await fetchImpl(url, {
            signal: controller.signal,
            headers: { Authorization: `Bearer ${hostApiKey(host, env)}` },
        });
        if (!response.ok)
            return null;
        return await response.json();
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
export function loadedIdsFromPayloads(_host, catalog, extra) {
    const loaded = new Set();
    const catalogIds = new Set(idsFromModelsPayload(catalog));
    const add = (raw) => {
        const id = pickedName(raw);
        const base = id.split(":")[0];
        if (catalogIds.size && !catalogIds.has(id) && !catalogIds.has(base))
            return;
        if (!MODEL_ID.test(id))
            return;
        loaded.add(id);
        if (catalogIds.has(base))
            loaded.add(base);
    };
    if (extra && typeof extra === "object") {
        const rec = extra;
        const running = Array.isArray(rec.models)
            ? rec.models
            : Array.isArray(rec.data)
                ? rec.data
                : [];
        // oMLX /v1/models/status flags loaded models; /health's default_model is only the configured default.
        const hasLoadedFlags = running.some((row) => row && typeof row === "object" && ("loaded" in row || "state" in row));
        if (!hasLoadedFlags && typeof rec.default_model === "string")
            add(rec.default_model);
        for (const row of running) {
            if (typeof row === "string") {
                if (!hasLoadedFlags)
                    add(row);
                continue;
            }
            if (!row || typeof row !== "object")
                continue;
            const item = row;
            const id = (typeof item.name === "string" && item.name) ||
                (typeof item.model === "string" && item.model) ||
                (typeof item.id === "string" && item.id) ||
                "";
            if (!id)
                continue;
            const state = typeof item.state === "string" ? item.state.toLowerCase() : "";
            if (item.loaded === false || state === "not-loaded" || state === "unloaded")
                continue;
            if (item.loaded === true || state === "loaded" || state === "idle" || !hasLoadedFlags) {
                add(id);
            }
        }
    }
    if (!loaded.size && catalog && typeof catalog === "object") {
        const rec = catalog;
        if (typeof rec.default_model === "string")
            add(rec.default_model);
        const records = Array.isArray(rec.data) ? rec.data : [];
        for (const row of records) {
            if (!row || typeof row !== "object")
                continue;
            const item = row;
            if (typeof item.id !== "string")
                continue;
            const state = typeof item.state === "string" ? item.state.toLowerCase() : "";
            if (item.loaded === true || state === "loaded")
                add(item.id);
        }
    }
    return loaded;
}
function loadedProbeUrl(host) {
    const origin = anthropicBaseUrl(host);
    if (host.id === "omlx")
        return `${origin}/v1/models/status`;
    if (host.id === "ollama" || host.id === "local_ollama")
        return `${origin}/api/ps`;
    if (host.id === "lmstudio")
        return `${origin}/api/v0/models`;
    return null;
}
function finiteContext(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
/** LM Studio 0.4 lists downloaded models at GET /api/v1/models; the chat id is `key`. */
export function lmStudioV1Catalog(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return null;
    const models = payload.models;
    if (!Array.isArray(models))
        return null;
    const ids = [];
    const loaded = new Set();
    const windows = new Map();
    for (const row of models) {
        if (!row || typeof row !== "object")
            continue;
        const item = row;
        if (item.type !== "llm" || typeof item.key !== "string" || !MODEL_ID.test(item.key))
            continue;
        const instances = Array.isArray(item.loaded_instances) ? item.loaded_instances : [];
        let contextWindow;
        for (const instance of instances) {
            if (!instance || typeof instance !== "object")
                continue;
            const config = instance.config;
            const length = config && typeof config === "object"
                ? finiteContext(config.context_length)
                : null;
            if (length !== null)
                contextWindow = contextWindow === undefined ? length : Math.min(contextWindow, length);
        }
        if (contextWindow === undefined) {
            const max = finiteContext(item.max_context_length);
            if (max !== null)
                contextWindow = max;
        }
        ids.push(item.key);
        if (instances.length > 0)
            loaded.add(item.key);
        if (contextWindow !== undefined)
            windows.set(item.key, contextWindow);
    }
    return { ids, loaded, windows };
}
export async function probeLocalInjects(env = process.env, fetchImpl = fetch) {
    const seenHosts = new Set();
    const hosts = LOCAL_HOSTS.filter((host) => {
        const key = host.baseUrl.replace(/\/$/, "");
        if (seenHosts.has(key))
            return false;
        seenHosts.add(key);
        return true;
    });
    const found = [];
    const pages = await Promise.all(hosts.map(async (host) => {
        const catalogUrl = `${host.baseUrl.replace(/\/$/, "")}/models`;
        const extraUrl = loadedProbeUrl(host);
        const v1Url = host.id === "lmstudio" ? `${anthropicBaseUrl(host)}/api/v1/models` : null;
        const [catalog, extra, nativePayload] = await Promise.all([
            timedJson(catalogUrl, env, host, fetchImpl),
            extraUrl ? timedJson(extraUrl, env, host, fetchImpl) : Promise.resolve(null),
            v1Url ? timedJson(v1Url, env, host, fetchImpl) : Promise.resolve(null),
        ]);
        const native = host.id === "lmstudio" ? lmStudioV1Catalog(nativePayload) : null;
        if (native)
            return { host, ids: native.ids, loaded: native.loaded, windows: native.windows };
        const catalogIds = catalog ? idsFromModelsPayload(catalog) : [];
        const extraIds = extra ? idsFromModelsPayload(extra) : [];
        const loaded = loadedIdsFromPayloads(host, catalog ?? extra, extra);
        const ids = [...new Set([...catalogIds, ...extraIds, ...loaded])];
        const windows = contextWindowsFromPs(extra);
        return { host, ids, loaded, windows };
    }));
    for (const { host, ids, loaded, windows } of pages) {
        for (const model of ids) {
            const contextWindow = windows.get(model);
            found.push({
                id: encodeInjectId(host.id, model),
                host: host.id,
                model,
                label: `${model} (${host.label})`,
                loaded: loaded.has(model),
                ...(contextWindow ? { contextWindow } : {}),
            });
        }
    }
    return found;
}
export async function mergeLocalInject(catalog, env = process.env, fetchImpl = fetch) {
    const vitest = env.VITEST ?? process.env.VITEST;
    const probe = env.OPENMAUSBOT_PROBE_LOCAL_INJECT ?? process.env.OPENMAUSBOT_PROBE_LOCAL_INJECT;
    if (vitest === "true" && probe !== "1")
        return catalog;
    // An engine's own config lists whatever it was last told to run, which may be a name that carries a window.
    catalog = { ...catalog, options: catalog.options.filter((option) => !isContextName(option.id)) };
    const extras = await probeLocalInjects(env, fetchImpl);
    if (!extras.length)
        return catalog;
    const liveApiIds = new Set(extras.map((extra) => extra.model));
    const options = catalog.options
        .filter((option) => decodeInjectId(option.id) || !option.custom || !liveApiIds.has(option.id))
        .map((option) => ({ ...option }));
    const seen = new Set(options.map((option) => option.id));
    for (const extra of extras) {
        const existing = options.find((option) => option.id === extra.id);
        if (existing) {
            if (extra.loaded)
                existing.loaded = true;
            if (extra.contextWindow)
                existing.contextWindow = extra.contextWindow;
            continue;
        }
        seen.add(extra.id);
        options.push({
            id: extra.id,
            label: extra.label,
            custom: true,
            ...(extra.loaded ? { loaded: true } : {}),
            ...(extra.contextWindow ? { contextWindow: extra.contextWindow } : {}),
        });
    }
    return { default: catalog.default, options };
}
export function applyOpenAIInject(env, modelId) {
    const inject = decodeInjectId(modelId);
    if (!inject)
        return { model: modelId ?? null, injected: false };
    const host = localHost(inject.host);
    if (!host)
        return { model: modelId ?? null, injected: false };
    const key = hostApiKey(host, env);
    env.OPENAI_BASE_URL = host.baseUrl;
    env.OPENAI_API_KEY = key;
    return { model: inject.model, injected: true };
}
export function applyClaudeInject(env, modelId) {
    const inject = decodeInjectId(modelId);
    if (!inject)
        return { model: modelId ?? null, injected: false };
    const host = localHost(inject.host);
    if (!host)
        return { model: modelId ?? null, injected: false };
    const key = hostApiKey(host, env);
    env.ANTHROPIC_BASE_URL = anthropicBaseUrl(host);
    env.ANTHROPIC_AUTH_TOKEN = key;
    env.ANTHROPIC_API_KEY = key;
    env.ANTHROPIC_MODEL = inject.model;
    const window = injectedContextWindow(modelId);
    if (window)
        env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(window);
    return { model: inject.model, injected: true };
}
