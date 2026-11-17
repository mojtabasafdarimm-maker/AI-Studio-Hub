import { titleCaseModelId } from "../../contracts.js";
import { execCli } from "../../procs.js";
import { createAcpDriver } from "./core.js";
import { CURSOR_STANDALONE } from "./cursor-release.js";
import { discoverAcpModels } from "./custom-model-catalog.js";
import { bundledEngineCatalog } from "../../model-manifest/bundled.js";
import { currentEngineCatalog } from "../../model-manifest/manifest.js";
import { ENGINE_MODEL_ID } from "../../model-manifest/schema.js";
import { capAnswerEcho, formatQuestionAnswers, MAX_QUESTIONS, parseChoices, parseProtocolAskQuestions, pickedOptionLabels, questionAnswersById, repeatsQuestionText, } from "../../../shared/ask-question.js";
/** Cursor keeps two model namespaces: `cursor-agent models` and `--model` use flat slugs (`auto`,
 * `gpt-5.3-codex`), while the ACP session advertises parameterised ids (`default[]`,
 * `grok-4.7[context=256k,reasoning_effort=high,fast=true]`) and set_model accepts only those (-32602
 * otherwise). `auto` is `default[]`. Null when nothing matches. */
export function resolveCursorAcpModelId(available, wanted) {
    return matchCursorAcpModel(available, wanted)?.modelId ?? null;
}
const EFFORT_SLUG = /^(.+)-(minimal|low|medium|high|xhigh|max)$/;
function cursorAcpParams(id) {
    const params = new Map();
    const body = /\[(.*)\]\s*$/.exec(id)?.[1] ?? "";
    for (const pair of body.split(",")) {
        const [key, value] = pair.split("=").map((part) => part?.trim().toLowerCase());
        if (key && value !== undefined)
            params.set(key, value);
    }
    return params;
}
/** `exact` is false when an effort slug settled for another variant: the session advertises one per base. */
export function matchCursorAcpModel(available, wanted) {
    const want = wanted.trim().toLowerCase();
    if (!want)
        return null;
    const ids = available.filter((m) => typeof m?.modelId === "string" && m.modelId);
    if (!ids.length)
        return null;
    const base = (id) => id.split("[")[0].trim().toLowerCase();
    const found = (modelId, exact = true) => ({ modelId, exact });
    const exact = ids.find((m) => m.modelId.toLowerCase() === want);
    if (exact)
        return found(exact.modelId);
    // A plain slug means Standard (fast=false); a `-fast` slug is the fast=true variant of its base.
    const isFast = (id) => cursorAcpParams(id).get("fast") === "true";
    const sameBase = ids.filter((m) => base(m.modelId) === want);
    const byBase = sameBase.find((m) => !isFast(m.modelId)) ?? sameBase[0];
    if (byBase)
        return found(byBase.modelId);
    const fastSlug = want.endsWith("-fast");
    const stem = fastSlug ? want.slice(0, -"-fast".length) : want;
    if (fastSlug) {
        const fast = ids.find((m) => base(m.modelId) === stem && isFast(m.modelId));
        if (fast)
            return found(fast.modelId);
    }
    // `cursor-agent models` puts effort in the slug (`grok-4.7-high-fast`); the session names it a
    // parameter (`reasoning_effort=high`, or `effort=`/`reasoning=` on other bases).
    const effortSlug = EFFORT_SLUG.exec(stem);
    if (effortSlug) {
        const [, effortBase, effort] = effortSlug;
        const effortOf = (id) => {
            const params = cursorAcpParams(id);
            return params.get("reasoning_effort") ?? params.get("effort") ?? params.get("reasoning");
        };
        const variants = ids.filter((m) => base(m.modelId) === effortBase && (!fastSlug || isFast(m.modelId)));
        const sameEffort = variants.find((m) => effortOf(m.modelId) === effort && isFast(m.modelId) === fastSlug);
        if (sameEffort)
            return found(sameEffort.modelId);
        const closest = variants.find((m) => isFast(m.modelId) === fastSlug) ?? variants[0];
        if (closest)
            return found(closest.modelId, false);
    }
    const byName = ids.find((m) => (m.name ?? "").trim().toLowerCase() === want);
    if (byName)
        return found(byName.modelId);
    if (want === "auto" || want === "default") {
        const dflt = ids.find((m) => base(m.modelId) === "default");
        if (dflt)
            return found(dflt.modelId);
    }
    return null;
}
export const STATIC_CURSOR_MODELS = bundledEngineCatalog("cursor");
const currentCursorModels = () => currentEngineCatalog("cursor");
/** Without parameterizedModelPicker Cursor (CLI 2026.10.19) offers only `composer-2.5[fast=true]`, so a
 * `composer-2.5` bot bills as Fast; with it, Fast is a separate `fast` config option. */
const CURSOR_CLIENT_META = { parameterizedModelPicker: true };
const SLUG = ENGINE_MODEL_ID.cursor;
const EXEC_TIMEOUT_MS = 8_000;
const nonBlank = (value) => Boolean(value?.trim());
function firstJsonValue(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return null;
    try {
        return JSON.parse(trimmed);
    }
    catch {
        // CLIs sometimes print a banner before the payload.
    }
    const start = trimmed.search(/[{[]/);
    if (start < 0)
        return null;
    for (let end = trimmed.length; end > start + 1; end--) {
        const slice = trimmed.slice(start, end).trim();
        if (!slice.endsWith("}") && !slice.endsWith("]"))
            continue;
        try {
            return JSON.parse(slice);
        }
        catch { }
    }
    return null;
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function labelFor(id, explicit) {
    const trimmed = explicit?.trim();
    return trimmed || titleCaseModelId(id, /[-_./]+/);
}
function pushModel(options, seen, id, label, custom = false) {
    if (!SLUG.test(id) || seen.has(id))
        return;
    seen.add(id);
    options.push({ id, label: labelFor(id, label), ...(custom ? { custom: true } : {}) });
}
function withUnseen(first, rest) {
    const merged = first.map((option) => ({ ...option }));
    const seen = new Set(merged.map((option) => option.id));
    for (const option of rest) {
        if (seen.has(option.id))
            continue;
        seen.add(option.id);
        merged.push(option);
    }
    return merged;
}
export function decodeCursorModelCatalog(payload) {
    const records = Array.isArray(payload)
        ? payload
        : Array.isArray(asRecord(payload)?.models)
            ? asRecord(payload).models
            : Array.isArray(asRecord(payload)?.data)
                ? asRecord(payload).data
                : Array.isArray(asRecord(payload)?.modelIds)
                    ? asRecord(payload).modelIds
                    : [];
    if (!records.length)
        return null;
    const options = [];
    const seen = new Set();
    for (const row of records) {
        if (typeof row === "string") {
            pushModel(options, seen, row);
            continue;
        }
        const rec = asRecord(row);
        if (!rec)
            continue;
        const id = rec.id ?? rec.modelId ?? rec.slug ?? rec.name;
        if (typeof id !== "string")
            continue;
        const label = (typeof rec.label === "string" && rec.label) ||
            (typeof rec.displayName === "string" && rec.displayName) ||
            (typeof rec.name === "string" && rec.name !== id ? rec.name : undefined);
        pushModel(options, seen, id, label || undefined);
    }
    if (!options.length)
        return null;
    const defaultId = (typeof asRecord(payload)?.default === "string" && seen.has(asRecord(payload).default)
        ? asRecord(payload).default
        : undefined) ??
        (seen.has(currentCursorModels().default) ? currentCursorModels().default : options[0].id);
    return { default: defaultId, options: withUnseen(currentCursorModels().options, options) };
}
function stripModelMarkers(label) {
    let cleaned = label.trim();
    let isDefault = false;
    let isCurrent = false;
    const defaultMatch = cleaned.match(/\s*\(default\)\s*$/i);
    if (defaultMatch) {
        isDefault = true;
        cleaned = cleaned.slice(0, defaultMatch.index).trim();
    }
    const currentMatch = cleaned.match(/\s*\(current\)\s*$/i);
    if (currentMatch) {
        isCurrent = true;
        cleaned = cleaned.slice(0, currentMatch.index).trim();
    }
    return { label: cleaned, isDefault, isCurrent };
}
/** Plain `cursor-agent models` text: one slug per line, optional `id - label`, `(default)` / `(current)` markers. */
export function decodeCursorModelText(text) {
    const options = [];
    const seen = new Set();
    let markedDefault;
    let markedCurrent;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#") || /^available\s+models?\b/i.test(line) || /^models?\b/i.test(line))
            continue;
        const stripped = line.replace(/^[\s*•-]+\s*/, "");
        const parts = stripped.split(/\s+[—–|:]\s+|\s+-\s+|\s{2,}/);
        const id = (parts[0] ?? "").trim();
        const rawLabel = parts.slice(1).join(" ").trim();
        const { label, isDefault, isCurrent } = stripModelMarkers(rawLabel);
        pushModel(options, seen, id, label || undefined);
        if (isDefault)
            markedDefault = id;
        if (isCurrent)
            markedCurrent = id;
    }
    if (!options.length)
        return null;
    const defaultId = (markedDefault && seen.has(markedDefault) ? markedDefault : undefined) ??
        (markedCurrent && seen.has(markedCurrent) ? markedCurrent : undefined) ??
        (seen.has(currentCursorModels().default) ? currentCursorModels().default : options[0].id);
    return { default: defaultId, options: withUnseen(currentCursorModels().options, options) };
}
function truthyAuthFlag(value) {
    if (value === true)
        return true;
    if (value === false)
        return false;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["true", "authenticated", "logged_in", "logged-in", "yes"].includes(normalized))
            return true;
        if (["false", "unauthenticated", "logged_out", "logged-out", "no"].includes(normalized))
            return false;
    }
    return null;
}
export function decodeCursorAuthStatus(payload) {
    const rec = asRecord(payload);
    if (!rec)
        return null;
    const auth = asRecord(rec.auth);
    const candidates = [
        rec.isAuthenticated,
        rec.authenticated,
        rec.loggedIn,
        rec.logged_in,
        auth?.isAuthenticated,
        auth?.authenticated,
        rec.status,
        auth?.status,
    ];
    for (const candidate of candidates) {
        const flag = truthyAuthFlag(candidate);
        if (flag !== null)
            return flag;
    }
    return null;
}
export function decodeCursorAuthText(text) {
    const normalized = text.trim().toLowerCase();
    if (!normalized)
        return null;
    if (/not (?:logged|signed) in|not authenticated|unauthenticated|logged out/.test(normalized))
        return false;
    if (/login successful|logged in|signed in|authenticated/.test(normalized))
        return true;
    return null;
}
function execText(run, cli, args, env) {
    return new Promise((resolve) => {
        run(cli, args, { timeout: EXEC_TIMEOUT_MS, env: env }, (err, stdout) => {
            if (err)
                return resolve(null);
            resolve(String(stdout ?? ""));
        });
    });
}
export async function probeCursorAuth(cli, env, run = execCli) {
    if (nonBlank(env.CURSOR_API_KEY) || nonBlank(env.CURSOR_AUTH_TOKEN))
        return true;
    for (const args of [["status", "--format", "json"], ["status"]]) {
        const stdout = await execText(run, cli, [...args], env);
        if (stdout == null)
            continue;
        const decoded = decodeCursorAuthStatus(firstJsonValue(stdout)) ?? decodeCursorAuthText(stdout);
        if (decoded !== null)
            return decoded;
    }
    return false;
}
/** `cursor-agent --version` prints its build alone (`2026.10.22-27dcf5f`); curl, run by an install command pasted as
 * the CLI path, answers `curl 7.88.1 (x86_64-pc-linux-gnu) …`. */
export const CURSOR_CLI_VERSION = /^\d{4}\.\d{1,2}\.\d{1,2}(?:-[0-9a-z]+)?\s*$/i;
/** `cursor-agent status --format json` (2026.10.22): `{"status":"unauthenticated","isAuthenticated":false,…}`. */
export function readCursorStatus(code, output) {
    const signedIn = code === 0 ? decodeCursorAuthStatus(firstJsonValue(output)) : null;
    return signedIn === true ? "signed-in" : signedIn === false ? "signed-out" : "unknown";
}
/** Never the CLI's own words: its output carries the sign-in request. */
function cursorLoginFailure(output) {
    if (/expired|timed? ?out/i.test(output))
        return "The Cursor sign-in link expired. Start sign-in again for a new link.";
    return "Cursor sign-in did not finish. Check the server's connection, then try again.";
}
/** `cursor-agent login` where the bots run: on a server it cannot open a browser, so it prints the link that finishes
 * the sign-in (NO_OPEN_BROWSER keeps it from trying) and waits; the person opens that link on any device. The login lands
 * in the server account's own Cursor home, which turns read. */
export const CURSOR_SIGN_IN = {
    provider: "cursor",
    product: "Cursor",
    account: "Cursor",
    homeEnv: "CURSOR_CONFIG_DIR",
    homeDir: ".cursor",
    loginArgs: ["login"],
    env: { NO_OPEN_BROWSER: "1" },
    install: "Install Cursor's CLI (https://cursor.com/docs/cli/installation) for the user running OpenMausBot, then try again.",
    failure: cursorLoginFailure,
    status: { args: ["status", "--format", "json"], read: readCursorStatus },
};
export function cursorCatalogFromSession(advertised) {
    const discovered = [];
    const bases = new Set();
    for (const model of advertised) {
        const raw = model.id.split("[")[0].trim();
        const id = raw.toLowerCase() === "default" ? currentCursorModels().default : raw;
        pushModel(discovered, bases, id, model.label.trim().toLowerCase() === id.toLowerCase() ? titleCaseModelId(id, /[-_]+/) : model.label);
    }
    if (!discovered.length)
        return null;
    const offered = currentCursorModels().options
        .filter((option) => option.id === currentCursorModels().default || bases.has(option.id.replace(/-fast$/, "")));
    return { default: currentCursorModels().default, options: withUnseen(offered, discovered) };
}
/** `cursor-agent models` (2026.10.22) lists only `auto` while session/new lists every model the account can use, so the
 * session answers first; the text list stands in for a CLI that cannot open one. */
export async function fetchCursorModels(cli, env, run = execCli) {
    const fromSession = await discoverAcpModels(env, cli, ["acp"], { variants: false, clientCapabilitiesMeta: CURSOR_CLIENT_META })
        .then((catalog) => cursorCatalogFromSession(catalog.options), () => null);
    if (fromSession)
        return fromSession;
    // Live CLI prints plain text (`slug - Label`); `--format json` is not supported yet.
    for (const args of [["models"], ["--list-models"]]) {
        const stdout = await execText(run, cli, [...args], env);
        if (stdout == null)
            continue;
        const fromText = decodeCursorModelText(stdout);
        if (fromText)
            return fromText;
        const fromJson = decodeCursorModelCatalog(firstJsonValue(stdout));
        if (fromJson)
            return fromJson;
    }
    return currentCursorModels();
}
export function classifyCursorError(error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    const code = error && typeof error === "object" ? error.code : undefined;
    const blob = `${code ?? ""} ${message}`.toLowerCase();
    if (code === -32000 ||
        /unauthoriz|unauthenticated|not signed in|not logged in|invalid api key|invalid_credentials|authentication required/.test(blob)) {
        return "invalid_credentials";
    }
    if (/inactive subscription|subscription.*(expired|inactive)|upgrade your (plan|subscription)/.test(blob)) {
        return "inactive_subscription";
    }
    return undefined;
}
/** Cursor's AskQuestion blocks on `cursor/ask_question` (cursor.com/docs/cli/acp; cursor-agent 2026.10.01, no sessionId).
 * Cursor answers by option id only, so a reply with any own words goes back whole as `skipped` with the answers as the
 * reason, which Cursor hands the model verbatim: a typed answer is never forced onto an option. */
export const CURSOR_ASK_QUESTION = {
    cancelled: { outcome: { outcome: "cancelled" } },
    parse(params) {
        const raw = params?.questions;
        if (!Array.isArray(raw) || raw.length > MAX_QUESTIONS)
            return null;
        const parsed = parseProtocolAskQuestions(raw.map((entry) => entry && typeof entry === "object"
            ? { id: entry.id, question: entry.prompt, options: entry.options, multiSelect: entry.allowMultiple === true }
            : entry));
        if (!parsed || repeatsQuestionText(parsed))
            return null;
        const rawOptions = new Map(raw.flatMap((entry) => entry && typeof entry.id === "string" && Array.isArray(entry.options) ? [[entry.id, entry.options]] : []));
        // Card labels are trimmed and capped: never guess when two options normalize alike.
        const optionId = (questionId, label) => {
            const matches = (rawOptions.get(questionId) ?? []).filter((option) => parseChoices([option], 1)?.[0] === label);
            const id = matches.length === 1 ? matches[0].id : null;
            return typeof id === "string" ? id : null;
        };
        const questions = parsed.map(({ question }) => question);
        return {
            questions,
            answered(message) {
                const byId = questionAnswersById(message, parsed);
                const answers = [];
                let ownWords = false;
                for (const { id, question } of parsed) {
                    const reply = byId[id];
                    if (reply === undefined)
                        continue;
                    const { labels, other } = pickedOptionLabels(reply, question);
                    const selectedOptionIds = labels.map((label) => optionId(id, label));
                    if (other !== undefined || selectedOptionIds.some((selected) => selected === null))
                        ownWords = true;
                    else
                        answers.push({ questionId: id, selectedOptionIds: selectedOptionIds });
                }
                if (ownWords) {
                    const reason = formatQuestionAnswers(questions, parsed.map(({ id }) => byId[id] ? [byId[id]] : []));
                    return { outcome: { outcome: "skipped", reason: capAnswerEcho(reason) } };
                }
                return answers.length ? { outcome: { outcome: "answered", answers } } : null;
            },
        };
    },
};
async function setCursorFast(request, sessionId, fast) {
    let reply;
    try {
        reply = (await request("session/set_config_option", { sessionId, configId: "fast", value: String(fast) }));
    }
    catch (e) {
        // -32602: the chosen model has no Fast variant, so there is nothing to switch.
        if (e.code !== -32602)
            throw e;
        return;
    }
    // Cursor can acknowledge the switch yet keep its default Fast variant, so only the echoed value counts.
    const confirmed = reply?.configOptions?.find((option) => option?.id === "fast")?.currentValue;
    if (confirmed !== String(fast)) {
        throw new Error(`Cursor did not confirm Fast ${fast ? "on" : "off"} (fast is ${confirmed === undefined ? "unreported" : JSON.stringify(confirmed)}), ` +
            "so the turn was not sent. Check that `cursor-agent` is current.");
    }
}
const support = (run) => ({
    driverKind: "cursorAgent",
    questionRequests: { "cursor/ask_question": CURSOR_ASK_QUESTION }, askTool: "AskQuestion",
    displayName: "Cursor",
    cliVersion: CURSOR_CLI_VERSION,
    get models() { return currentCursorModels(); },
    // Other coding agents can install a generic `agent` shim; `cursor-agent` is unambiguous.
    defaultCli: "cursor-agent",
    nativeSource: "cursor.acp",
    // Turns read this too: the sign-in runs where the bots run, from the app, never on the person's own computer.
    loginNote: "Cursor is not signed in where your bots run. Choose Cursor in the model picker and sign in from its card, or set CURSOR_API_KEY.",
    deviceSignIn: CURSOR_SIGN_IN,
    install: {
        command: {
            darwin: "curl https://cursor.com/install -fsS | bash",
            linux: "curl https://cursor.com/install -fsS | bash",
            win32: "irm 'https://cursor.com/install?win32=true' | iex",
        },
        docsUrl: "https://cursor.com/docs/cli/installation",
        signInCommand: "cursor-agent login",
        // On Linux, Settings installs Cursor's own pinned build: a Cloud has no terminal for its installer.
        standalone: CURSOR_STANDALONE,
    },
    // Global flags precede `acp`. `--approve-mcps` covers OpenMausBot's own servers from session/new.
    // `--force` / `--auto-review` are the documented tool-permission switches only.
    spawnArgs: (config, turn) => [
        ...(config.fullAuto ? ["--force"] : turn.approvalMode === "auto" ? ["--auto-review"] : []),
        "--approve-mcps",
        ...(turn.model ? ["--model", turn.model] : []),
        "acp",
    ],
    // Cursor keeps the first MCP registration for a process's life; a new agents bearer must start fresh.
    restartOnMcpChange: true,
    // Cursor advertises http MCP; OpenMausBot's own servers as endpoints avoid a stdio proxy under Cursor's client.
    ownMcpOverHttp: true,
    credentialEnv: ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"],
    resolveModels: (environment, config) => fetchCursorModels(config.cli || "cursor-agent", environment, run),
    // A key in the env already authenticates the session, and Cursor's cursor_login handler would then
    // delete the saved login and open a browser once the token expired, so it is not sent.
    pickAuthMethod: (methods, env) => nonBlank(env.CURSOR_API_KEY) || nonBlank(env.CURSOR_AUTH_TOKEN) ? null
        : methods.some((m) => m.id === "cursor_login") ? "cursor_login" : null,
    authFailure: "continue",
    isAuthenticated: (env, config) => probeCursorAuth(config.cli || "cursor-agent", env, run),
    classifyError: classifyCursorError,
    clientCapabilitiesMeta: CURSOR_CLIENT_META,
    async configureSession({ request, sessionId, turn, sessionModels, currentModelId, configOptions, notice }) {
        if (!turn.model)
            return;
        const fastOption = configOptions.some((option) => option?.id === "fast");
        const wantsFast = /-fast$/i.test(turn.model);
        const wanted = fastOption && wantsFast ? turn.model.slice(0, -"-fast".length) : turn.model;
        const match = matchCursorAcpModel(sessionModels ?? [], wanted);
        const modelId = match?.modelId ?? wanted;
        // A reused session already on this id rejects a second session/set_model. Fast is a separate option.
        if (currentModelId !== modelId) {
            try {
                await request("session/set_model", { sessionId, modelId });
            }
            catch (e) {
                const err = e;
                // -32601: no set_model, so the argv pin holds. -32602: not in this namespace; current CLIs
                // ignore argv `--model` in ACP, so the session keeps its starting model.
                if (err.code === -32601)
                    return;
                if (err.code === -32602) {
                    const current = sessionModels?.find((m) => m.modelId === currentModelId);
                    const running = current?.name ?? currentModelId;
                    notice(`Cursor did not accept ${turn.model} in this session, so it runs ${running ?? "its default model"}. ` +
                        "Choose another model for this bot to stop seeing this.");
                    return;
                }
                throw new Error(`Cursor rejected model "${turn.model}" (sent as "${modelId}") via session/set_model: ${err.message}. ` +
                    `Check that \`cursor-agent\` is current and that this account can use that model.`);
            }
        }
        // The sentence is about the model this conversation uses, including a later turn that does not call the setter.
        if (match && !match.exact) {
            notice(`Cursor offers ${modelId} rather than ${turn.model} in this session, so this conversation uses ${modelId}.`);
        }
        if (fastOption)
            await setCursorFast(request, sessionId, wantsFast);
    },
    buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
});
export function createCursorAgentDriver(run = execCli) {
    return createAcpDriver(support(run));
}
export const CursorAgentDriver = createCursorAgentDriver();
