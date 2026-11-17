import { isContextName } from "./ollama-context.js";
export const OLLAMA_PORT = "11434";
/** Where `ollama serve` listens unless OLLAMA_HOST says otherwise. */
export const OLLAMA_LOCAL_URLS = ["http://127.0.0.1:11434", "http://localhost:11434"];
/** Ollama ignores the key; the OpenAI-compatible request still carries one. */
export const OLLAMA_PLACEHOLDER_KEY = "ollama";
export const OLLAMA_PULL_COMMAND = "ollama pull llama3.2";
/** The server's own address: the base URL without the /v1 the OpenAI-compatible routes sit under. */
export function ollamaOrigin(baseUrl) {
    return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}
export function onOllamaPort(url) {
    try {
        return new URL(url).port === OLLAMA_PORT;
    }
    catch {
        return false;
    }
}
const EMBEDDING = /embed|(?:^|[/:-])bge-|minilm/i;
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : undefined;
/** The chat models in an /api/tags answer, or null when the answer is not one. An embedding model answers no chat (its
 * name only counts where Ollama gives no family), and a name that carries a context window is the model it was made from. */
export function ollamaTags(payload) {
    const rows = payload && typeof payload === "object" ? payload.models : undefined;
    if (!Array.isArray(rows))
        return null;
    const seen = new Set();
    const models = [];
    for (const row of rows) {
        if (!row || typeof row !== "object")
            continue;
        const entry = row;
        const name = text(entry.name) ?? text(entry.model);
        const details = (entry.details && typeof entry.details === "object" ? entry.details : {});
        const families = [details.family, ...(Array.isArray(details.families) ? details.families : [])].filter((family) => typeof family === "string");
        if (!name || seen.has(name) || isContextName(name) || families.some((family) => /bert$/i.test(family)) || (!families.length && EMBEDDING.test(name)))
            continue;
        seen.add(name);
        const parameters = text(details.parameter_size), quantization = text(details.quantization_level);
        models.push({
            name,
            ...(typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size > 0 ? { bytes: entry.size } : {}),
            ...(parameters ? { parameters } : {}),
            ...(quantization ? { quantization } : {}),
        });
    }
    return models;
}
function thinkingControls(described) {
    const values = described && typeof described === "object" ? described.values : undefined;
    const choices = Array.isArray(values)
        ? values.flatMap((value) => value === false ? ["off"] : value === true ? ["on"] : text(value) ? [text(value)] : [])
        : [];
    return choices.length ? { choices, described: true } : { choices: ["off", "on"], described: false };
}
/** What /api/show says a model can do; empty when the server predates capabilities. */
export function showCapabilities(show) {
    const { capabilities, thinking } = (show && typeof show === "object" ? show : {});
    if (!Array.isArray(capabilities) || !capabilities.every((entry) => typeof entry === "string"))
        return {};
    const controls = capabilities.includes("thinking") ? thinkingControls(thinking) : undefined;
    return { tools: capabilities.includes("tools"), vision: capabilities.includes("vision"), ...(controls && controls.choices.length > 1 ? { thinking: controls } : {}) };
}
/** The `reasoning_effort` a thinking choice sends on /v1, undefined to leave the model's default. Ollama v0.12.6, which
 * lists no controls in /api/show, refuses a level on any model without named levels, so "on" stays unsent there. */
export function thinkingEffort(thinking, choice) {
    if (!thinking || !choice || !thinking.choices.includes(choice))
        return undefined;
    if (choice === "off")
        return "none";
    if (choice === "on")
        return thinking.described ? "high" : undefined;
    return choice;
}
/** False only for a model /api/show says cannot chat. */
function answersChats(show) {
    const capabilities = show && typeof show === "object" ? show.capabilities : undefined;
    return !Array.isArray(capabilities) || capabilities.includes("completion");
}
function nobodyListening(error) {
    const cause = error?.cause;
    if (cause?.code === "ECONNREFUSED")
        return true;
    return Array.isArray(cause?.errors) && cause.errors.length > 0 && cause.errors.every((entry) => entry.code === "ECONNREFUSED");
}
const timedOut = (error) => error?.name === "TimeoutError";
const answered = new Map();
/** Whether this server has answered as Ollama: /api/tags with a list and /api/version with a version (some other servers
 * imitate /api/tags alone). Undefined until asked; a failed version request alone doesn't undo a yes. */
export function answeredAsOllama(url) {
    return answered.get(ollamaOrigin(url));
}
/** Never throws. */
export async function probeOllama(url, options = {}) {
    const origin = ollamaOrigin(url);
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? 2_000;
    const headers = options.key ? { authorization: `Bearer ${options.key}` } : undefined;
    const ask = (path, init = {}) => fetchImpl(`${origin}${path}`, { ...init, headers: { ...headers, ...init.headers }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    let models;
    let version;
    try {
        const [tags, about] = await Promise.all([
            ask("/api/tags"),
            ask("/api/version").then((response) => response.ok ? response.json() : null).catch(() => null),
        ]);
        models = tags.ok ? ollamaTags(await tags.json().catch(() => null)) : null;
        version = text(about?.version);
    }
    catch (error) {
        if (nobodyListening(error))
            return { state: "not-running", url: origin, models: [] };
        return { state: "unreachable", url: origin, models: [], problem: timedOut(error) ? "timeout" : "network" };
    }
    if (models === null)
        answered.set(origin, false);
    else if (version)
        answered.set(origin, true);
    else if (!answered.has(origin))
        answered.set(origin, false);
    if (!models)
        return { state: "unreachable", url: origin, models: [], problem: "not-ollama" };
    if (options.capabilities) {
        const asked = await Promise.all(models.map(async (model) => {
            try {
                const response = await ask("/api/show", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: model.name }) });
                if (!response.ok)
                    return model;
                const show = await response.json();
                return answersChats(show) ? { ...model, ...showCapabilities(show) } : null;
            }
            catch {
                return model;
            }
        }));
        models = asked.filter((model) => model !== null);
    }
    return { state: models.length ? "ready" : "no-models", url: origin, ...(version ? { version } : {}), models };
}
/** What stops an Ollama from answering, for the engine list; null when it can, or when something else answers there. */
export function ollamaUnavailable(status, addedAsOllama = false) {
    switch (status.state) {
        case "ready": return null;
        case "no-models": return `Ollama has no models yet. Run \`${OLLAMA_PULL_COMMAND}\`, then check again.`;
        case "not-running": return `Ollama isn't running at ${status.url}. Open the Ollama app or run \`ollama serve\`.`;
        case "unreachable": return status.problem === "not-ollama" ? addedAsOllama ? `Something answers at ${status.url}, but it isn't Ollama.` : null
            : `Can't reach Ollama at ${status.url}${status.problem === "timeout" ? ": it did not answer in time" : ""}. Check the address and that this computer can reach it.`;
    }
}
const RANK = { ready: 0, "no-models": 1, unreachable: 2, "not-running": 3 };
/** Ollama on this computer, or at an address someone set: the first that runs, else the most telling answer. */
export async function findOllama(urls = [], options = {}) {
    const origins = [...new Set([...urls, ...(options.localUrls ?? OLLAMA_LOCAL_URLS)].map(ollamaOrigin))];
    const found = await Promise.all(origins.map((origin) => probeOllama(origin, options)));
    return found.reduce((best, status) => RANK[status.state] < RANK[best.state] ? status : best);
}
/** An OpenAI-compatible instance that is really Ollama: added as Ollama, it answered as Ollama, or it is on Ollama's port
 * and nothing there has answered otherwise. */
export function isOllamaServer(config) {
    const { url, catalog } = (config && typeof config === "object" ? config : {});
    if (catalog === "ollama")
        return true;
    if (catalog !== undefined || typeof url !== "string")
        return false;
    const answer = answeredAsOllama(url);
    return answer === true || (answer === undefined && onOllamaPort(url));
}
export function forgetOllamaAnswers() {
    answered.clear();
}
