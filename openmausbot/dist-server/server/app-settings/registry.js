import { z } from "zod";
import { credentialIsConfigured, CREDENTIAL_TARGETS, PROVIDER_CREDENTIAL_TARGETS } from "../../shared/credential-request.js";
import { WINDOW_PREFS } from "../../shared/app-settings.js";
import { defaultBotThreads, MAX_CONCURRENT_BOT_THREADS } from "../bot-thread-limits.js";
import { isClaudeBedrock } from "../claude-bedrock.js";
import { isClaudeEndpoint } from "../claude-endpoints.js";
import { isCodexEndpoint } from "../codex-endpoints.js";
import { MAX_MCP_CALL_TIMEOUT_MINUTES, MAX_ROOM_TURN_TIMEOUT_MINUTES, mcpCallTimeoutMinutes, MIN_MCP_CALL_TIMEOUT_MINUTES, MIN_ROOM_TURN_TIMEOUT_MINUTES, persistableInstanceConfigs, roomTurnTimeoutMinutes } from "../config.js";
import { BUILT_IN_DRIVERS } from "../drivers/builtIn.js";
import { endpointDisplayUrl, isAddedEndpoint, localServerAlreadyAdded } from "../openai-compat-endpoints.js";
import { callRoute } from "../routes/call-route.js";
import { placePath } from "./places.js";
import { botEntries } from "./registry-bots.js";
import { configEntries } from "./registry-config.js";
import { pictureEntries } from "./registry-pictures.js";
import { windowEntries } from "./registry-window.js";
/** A setting's value for a person or bot; empty when unset, so each edge can say "not set" in its own words. */
export const display = (value) => (value === undefined || value === null || value === "" ? "" : typeof value === "string" ? value : JSON.stringify(value));
const url = z.string().trim().max(2048).refine((text) => text === "" || /^https?:\/\/\S+$/.test(text), "an http(s) address, or empty to clear");
const KEY_WHERE = {
    onePasswordToken: "vault",
};
/** One plain line for a change only the person makes, in Settings. */
export const personOnly = (what, where) => `${what} is changed only by the person, in ${placePath(where)}. Tell them where in one line; do not try another way.`;
/** Security: a key never passes through the bot. A value naming a key, token, secret or password field is refused at
 * the boundary; `except` lets through a field that only names a saved key. */
export const withoutKeys = (schema, except = []) => z.record(z.string(), z.unknown())
    .refine((fields) => !Object.keys(fields).some((field) => !except.includes(field) && /key|token|secret|password/i.test(field)), "Never put a key or token in the value. Save it first with set on keys.<id> (a secure card asks the user), then name that id in keyFrom.")
    // The record check above already holds an object; the schema decides its shape.
    .pipe(schema);
const PROVIDER_KEY_SECTION = {
    openaiApiKey: "openai", anthropicApiKey: "anthropic", openrouterApiKey: "openrouter", mistralApiKey: "mistral", cerebrasApiKey: "cerebras",
    groqApiKey: "groq", greenferenceApiKey: "greenference", modelgoApiKey: "modelgo", metaApiKey: "meta", deepseekApiKey: "deepseek",
};
/** A local server takes no key; Settings sends the same stand-in for one. */
const LOCAL_SERVER = { ollama: { name: "Ollama", key: "ollama" }, lmstudio: { name: "LM Studio", key: "lm-studio" } };
const engineName = z.string().trim().min(1).max(80);
const engineUrl = z.string().trim().min(1).max(512);
/** Security: a key never passes through the bot. An engine that needs one names a key the person saved through the
 * secure card (`keyFrom`), and the server reads it at the moment the owner taps Change. */
const engineChange = withoutKeys(z.discriminatedUnion("kind", [
    z.object({ kind: z.enum(["ollama", "lmstudio"]), name: engineName.optional(), url: engineUrl }).strict(),
    z.object({ kind: z.literal("openai-compat"), name: engineName, url: engineUrl, keyFrom: z.enum(PROVIDER_CREDENTIAL_TARGETS), models: z.array(z.string().trim().min(1).max(200)).max(64).optional() }).strict(),
    z.object({ kind: z.literal("bedrock"), name: engineName, awsProfile: z.string().trim().min(1).max(128), awsRegion: z.string().trim().min(1).max(40), model: z.string().trim().min(1).max(160) }).strict(),
    z.object({ kind: z.literal("remove"), instanceId: z.string().regex(/^[\w.-]{1,120}$/) }).strict(),
]), ["keyFrom"]);
/** The engines a bot may remove: added without a sign-in. Accounts and the built-in engines stay with the owner. */
const removableKind = (instanceId, entry) => isAddedEndpoint(instanceId, entry) ? "OpenAI-compatible server"
    : isClaudeBedrock(entry) ? "Claude on Amazon Bedrock" : isClaudeEndpoint(entry) ? "Claude endpoint" : isCodexEndpoint(entry) ? "Codex endpoint" : null;
export function createSettingsRegistry(deps) {
    const cfg = deps.cfg;
    const names = (ids) => ids.map((id) => deps.bots().find((bot) => bot.id === id)?.name ?? id).join(", ");
    const writable = (spec) => ({
        ...spec, tier: "safe", read: spec.read ?? (() => display(spec.current())), current: spec.current,
        write: spec.write, ...(spec.describe ? { describe: spec.describe } : {}),
    });
    const config = (patch) => (value) => deps.saveConfig(patch(value));
    const windowPref = (id, label, help, where, synonyms, allowed, line) => writable({
        id, label, help, where, synonyms, value: WINDOW_PREFS[id], allowed,
        current: () => deps.window.read(id), write: async (value) => deps.window.write(id, value),
        ...(line ? { describe: (value) => { const refusal = line.refusal?.(value); return refusal ? { refusal } : { change: line.says(value) }; } } : {}),
    });
    const enumOf = (values) => values.join(", ");
    const pinned = () => deps.bots().filter((bot) => bot.pinned).map((bot) => bot.id);
    const groups = () => Object.fromEntries(deps.sections().map((section) => [section, deps.bots().filter((bot) => bot.section === section).map((bot) => bot.id)]));
    const safe = [
        windowPref("appearance.skin", "Skin", "The window's built-in look; \"system\" follows the computer's light or dark mode. A custom look (any colours, fonts, CSS, pictures) is a theme: use action theme.", "theme", ["theme", "dark mode", "light mode", "colors", "look"], enumOf(WINDOW_PREFS["appearance.skin"].options)),
        windowPref("appearance.advanced", "Advanced mode", "Advanced shows every setting and tool; Simple keeps the everyday ones.", "advanced-mode", ["simple mode", "advanced mode", "interface mode"], "true or false"),
        windowPref("appearance.font", "Font", "The app's typeface.", "tool-calls", ["typeface", "typography"], enumOf(WINDOW_PREFS["appearance.font"].options)),
        windowPref("appearance.chatWidth", "Chat width", "How wide the chat column is.", "tool-calls", ["layout", "column", "wide"], enumOf(WINDOW_PREFS["appearance.chatWidth"].options)),
        windowPref("general.sendKey", "Send key", "Which key sends a message in the composer.", "send-key", ["enter", "typing", "keyboard", "shortcut"], enumOf(WINDOW_PREFS["general.sendKey"].options)),
        windowPref("general.notificationSounds", "Notification sounds", "Play a sound when a bot needs you or finishes.", "notifications", ["sound", "sounds", "mute", "alerts", "notifications"], "true or false"),
        writable({
            id: "general.language", label: "Language", help: "The app's language, as a tag such as en, de or pt-br; empty follows the computer.", where: "language",
            synonyms: ["locale", "translation"], value: z.string().trim().max(16).regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})*$|^$/i, "a language tag such as en or pt-br"), allowed: "a language tag such as en, de, ja, pt-br, zh-tw; empty to follow the computer",
            current: () => cfg().language ?? "", write: config((language) => ({ language })),
        }),
        writable({
            id: "bots.order", label: "Bot order", help: "The order bots are listed in the sidebar and on phones. Send bot ids from list_bots; bots you leave out keep their places.", where: "sidebar",
            synonyms: ["reorder", "sidebar order", "sort bots", "move bot", "arrange"], value: z.array(z.string().regex(/^[\w-]+$/)).min(1).max(100), allowed: "an array of bot ids in the wanted order",
            current: () => deps.bots().map((bot) => bot.id), read: () => names(deps.bots().map((bot) => bot.id)), write: (botIds) => deps.reorderBots(botIds),
        }),
        writable({
            id: "bots.pinned", label: "Pinned bots", help: "Which bots are pinned to the top of the sidebar. Send every bot id that should be pinned, including ones already pinned; the rest are unpinned.", where: "sidebar",
            synonyms: ["pin", "pinned", "unpin", "favorite", "favourite", "top", "star"], value: z.array(z.string().regex(/^[\w-]+$/)).max(100), allowed: "an array of the bot ids to pin; an empty array unpins every bot",
            current: pinned, read: () => names(pinned()),
            write: async (botIds) => {
                const unknown = botIds.find((id) => !deps.bots().some((bot) => bot.id === id));
                if (unknown)
                    return `No bot has the id ${unknown}. Use list_bots for the ids.`;
                for (const bot of deps.bots()) {
                    if (Boolean(bot.pinned) === botIds.includes(bot.id))
                        continue;
                    const refusal = await deps.pinBot(bot.id, botIds.includes(bot.id));
                    if (refusal)
                        return refusal;
                }
                return null;
            },
        }),
        writable({
            id: "bots.groups", label: "Sidebar groups", help: "Which bots sit in which sidebar group (department). Send an object of group name to bot ids; a bot in no listed group is ungrouped.", where: "sidebar",
            synonyms: ["group", "groups", "department", "departments", "section", "sections", "team", "folder"],
            value: z.record(z.string().trim().min(1).max(60), z.array(z.string().regex(/^[\w-]+$/)).max(100)), allowed: "an object: group name → array of bot ids",
            current: groups,
            read: () => {
                const grouped = Object.entries(groups()).map(([section, ids]) => `${section}: ${names(ids) || "(empty)"}`);
                const loose = deps.bots().filter((bot) => !bot.section).map((bot) => bot.id);
                return [...grouped, ...(loose.length ? [`ungrouped: ${names(loose)}`] : [])].join("; ");
            },
            write: async (wanted) => {
                const listed = new Set(Object.values(wanted).flat());
                const loosen = deps.bots().filter((bot) => bot.section && !listed.has(bot.id)).map((bot) => bot.id);
                for (const [name, botIds] of Object.entries(wanted)) {
                    const refusal = await deps.groupBots(name, botIds);
                    if (refusal)
                        return refusal;
                }
                return loosen.length ? deps.groupBots("", loosen) : null;
            },
        }),
        writable({
            id: "threads.maxConcurrentPerBot", label: "Threads per bot", help: "How many conversations one bot may work on at once.", where: "parallel",
            synonyms: ["concurrent", "parallel", "limit", "limits", "thread limit"], value: z.number().int().min(1).max(MAX_CONCURRENT_BOT_THREADS), allowed: `1 to ${MAX_CONCURRENT_BOT_THREADS}`,
            current: () => cfg().threads?.maxConcurrentPerBot ?? defaultBotThreads(), write: config((maxConcurrentPerBot) => ({ threads: { maxConcurrentPerBot } })),
        }),
        writable({
            id: "threads.eventLogRetentionDays", label: "Thread log retention", help: "Days a closed conversation's event logs are kept; null keeps them forever.", where: "storage",
            synonyms: ["cleanup", "clean up", "retention", "logs", "delete old", "storage"], value: z.number().int().min(1).max(3650).nullable(), allowed: "1 to 3650 days, or null to keep forever",
            current: () => cfg().threads?.eventLogRetentionDays ?? null, read: () => display(cfg().threads?.eventLogRetentionDays ?? "forever"),
            write: config((eventLogRetentionDays) => ({ threads: { eventLogRetentionDays } })),
        }),
        writable({
            id: "rooms.turnTimeoutMinutes", label: "Room turn timeout", help: "Minutes a bot's turn in a room may run before it is stopped.", where: "group-turns",
            synonyms: ["room", "channel", "timeout", "turn limit"], value: z.number().int().min(MIN_ROOM_TURN_TIMEOUT_MINUTES).max(MAX_ROOM_TURN_TIMEOUT_MINUTES), allowed: `${MIN_ROOM_TURN_TIMEOUT_MINUTES} to ${MAX_ROOM_TURN_TIMEOUT_MINUTES} minutes`,
            current: () => roomTurnTimeoutMinutes(cfg()), write: config((turnTimeoutMinutes) => ({ rooms: { turnTimeoutMinutes } })),
        }),
        writable({
            id: "mcp.callTimeoutMinutes", label: "MCP call timeout", help: "Minutes one MCP tool call may run.", where: "limits",
            synonyms: ["mcp", "tool timeout", "call timeout"], value: z.number().int().min(MIN_MCP_CALL_TIMEOUT_MINUTES).max(MAX_MCP_CALL_TIMEOUT_MINUTES), allowed: `${MIN_MCP_CALL_TIMEOUT_MINUTES} to ${MAX_MCP_CALL_TIMEOUT_MINUTES} minutes`,
            current: () => mcpCallTimeoutMinutes(cfg()), write: config((callTimeoutMinutes) => ({ mcp: { callTimeoutMinutes } })),
        }),
        writable({
            id: "bots.defaultModel", label: "Default model for new bots", help: "The engine and model a newly created bot starts on; existing bots keep theirs. Ids come from list_models.", where: "new-bots",
            synonyms: ["default model", "new bots", "model", "engine"], value: z.object({ instanceId: z.string().min(1).max(80), model: z.string().min(1).max(200) }), allowed: "{ instanceId, model } from list_models",
            current: () => cfg().defaultModelSelection, read: () => { const selection = cfg().defaultModelSelection; return selection ? `${selection.instanceId} / ${selection.model}` : ""; },
            write: config((defaultModelSelection) => ({ defaultModelSelection })),
        }),
    ];
    const provider = (id, label, synonyms, current, patch) => writable({
        id, label, help: `${label}: the address MausBot sends requests to. Empty uses the provider's own.`, where: "keys", synonyms: [...synonyms, "url", "base url", "endpoint", "address", "proxy"],
        value: url, allowed: "an http(s) address, or empty to clear", current: () => current() ?? "", write: config(patch),
    });
    const providers = [
        provider("providers.anthropic.url", "Anthropic address", ["anthropic", "claude"], () => cfg().anthropic?.url, (text) => ({ anthropic: { ...cfg().anthropic, url: text } })),
        provider("providers.xai.url", "xAI address", ["xai", "grok"], () => cfg().xai?.url, (text) => ({ xai: { ...cfg().xai, url: text } })),
        provider("providers.groq.url", "Groq address", ["groq"], () => cfg().groq?.url, (text) => ({ groq: { ...cfg().groq, url: text } })),
        provider("providers.meta.url", "Meta address", ["meta", "llama"], () => cfg().meta?.url, (text) => ({ meta: { ...cfg().meta, url: text } })),
        provider("providers.openaiCompat.url", "OpenAI-compatible address", ["openai compatible", "custom provider", "ollama", "lm studio", "openrouter"], () => cfg().openaiCompat?.url, (text) => ({ openaiCompat: { ...cfg().openaiCompat, url: text } })),
        writable({
            id: "providers.openaiCompat.model", label: "OpenAI-compatible model", help: "The model name sent to the OpenAI-compatible provider.", where: "keys",
            synonyms: ["openai compatible", "custom provider", "model name"], value: z.string().trim().max(200), allowed: "a model name, or empty to clear",
            current: () => cfg().openaiCompat?.model ?? "", write: config((model) => ({ openaiCompat: { ...cfg().openaiCompat, model } })),
        }),
        provider("voice.baseUrl", "Voice server address", ["tts", "voice", "speech", "chatterbox"], () => cfg().tts?.baseUrl, (text) => ({ tts: { ...cfg().tts, baseUrl: text } })),
    ];
    const secret = Object.keys(CREDENTIAL_TARGETS).map((credentialId) => {
        const target = CREDENTIAL_TARGETS[credentialId];
        return {
            id: `keys.${credentialId}`, label: target.label, help: target.description, synonyms: ["key", "api key", "token", "credential", target.label.split(" ")[0].toLowerCase()],
            where: KEY_WHERE[credentialId] ?? (PROVIDER_CREDENTIAL_TARGETS.includes(credentialId) ? "providers" : "keys"),
            tier: "secret", credentialId, read: () => (credentialIsConfigured(deps.credentials(), credentialId) ? "set" : ""),
        };
    });
    const instances = () => persistableInstanceConfigs(cfg());
    const savedKey = (id) => deps.credentials()[PROVIDER_KEY_SECTION[id]]?.key;
    const keyMissing = (id) => `Your ${CREDENTIAL_TARGETS[id].label} is not saved yet. Call set on keys.${id} with no value first (a secure card asks the user for it), then add the engine.`;
    const listEngines = () => deps.engines().map(({ instanceId, name, working }) => {
        const entry = instances()[instanceId];
        const url = isAddedEndpoint(instanceId, entry) ? endpointDisplayUrl(entry.config) : undefined;
        return `${instanceId}: ${name}${url ? ` at ${url}` : ""}${working ? "" : " (not working)"}${removableKind(instanceId, entry) ? "" : " (removed only in Settings)"}`;
    }).join("; ");
    const engines = writable({
        id: "engines", label: "AI engines", help: "The AI engines bots run on. get lists each one's id; set adds one, with Undo. Removing one deletes its setup and key, so only the person does that, in Settings.", where: "providers",
        synonyms: ["engine", "engines", "ai engine", "add engine", "remove engine", "provider", "providers", "ollama", "lm studio", "lmstudio", "bedrock", "endpoint", "local model"],
        value: engineChange,
        allowed: '{"kind":"ollama" or "lmstudio","url"} for a local server; {"kind":"openai-compat","name","url","keyFrom":"<a keys.* id, e.g. openrouterApiKey>","models"?:[...]}; '
            + '{"kind":"bedrock","name","awsProfile","awsRegion","model"}. Sign-in accounts (Claude, ChatGPT, Antigravity) are signed in by the user: show_card ai-sign-in puts that sign-in in the chat',
        current: () => ({ kind: "keep", instanceIds: deps.engines().map((engine) => engine.instanceId) }), read: listEngines,
        describe: (change) => {
            if (change.kind === "remove")
                return { refusal: personOnly("Removing an AI engine", "providers") };
            if (change.kind === "ollama" || change.kind === "lmstudio") {
                const duplicate = localServerAlreadyAdded(instances(), change.url);
                if (duplicate)
                    return { refusal: duplicate };
            }
            if (change.kind === "openai-compat") {
                if (!savedKey(change.keyFrom))
                    return { refusal: keyMissing(change.keyFrom) };
                return { change: `Add the engine "${change.name}" (OpenAI-compatible) at ${change.url}, sending it your saved ${CREDENTIAL_TARGETS[change.keyFrom].label}` };
            }
            if (change.kind === "bedrock")
                return { change: `Add the engine "${change.name}" (Claude on Amazon Bedrock), AWS profile ${change.awsProfile} in ${change.awsRegion}, model ${change.model}` };
            return { change: `Add the engine "${change.name ?? LOCAL_SERVER[change.kind].name}" (${LOCAL_SERVER[change.kind].name} on ${change.url})` };
        },
        write: async (change) => {
            if (change.kind === "keep") {
                for (const { instanceId } of deps.engines()) {
                    if (change.instanceIds.includes(instanceId) || !removableKind(instanceId, instances()[instanceId]))
                        continue;
                    const refusal = await deps.removeEngine(instanceId);
                    if (refusal)
                        return refusal;
                }
                return null;
            }
            if (change.kind === "remove")
                return personOnly("Removing an AI engine", "providers");
            if (change.kind === "bedrock")
                return deps.addEngine("claude-bedrock", { displayName: change.name, awsProfile: change.awsProfile, awsRegion: change.awsRegion, model: change.model });
            if (change.kind === "openai-compat") {
                const key = savedKey(change.keyFrom);
                return key ? deps.addEngine("openai-compat", { displayName: change.name, url: change.url, key, ...(change.models ? { models: change.models } : {}) }) : keyMissing(change.keyFrom);
            }
            const local = LOCAL_SERVER[change.kind];
            return deps.addEngine("openai-compat", { displayName: change.name ?? local.name, url: change.url, key: local.key, catalog: change.kind });
        },
    });
    const ownerOnly = (id, label, help, where, synonyms, read) => ({ id, label, help, where, synonyms, tier: "owner-only", read });
    const owner = [
        ownerOnly("cloud.account", "MausBot Cloud account", "The account this app is signed in with, and its plan.", "account", ["account", "sign in", "sign out", "plan", "billing", "subscription"], () => "managed in Settings"),
        ownerOnly("vault.logins", "Vault and logins", "Saved website logins and secrets bots may use.", "vault", ["vault", "password", "passwords", "login", "logins", "1password"], () => "managed in Settings"),
        ownerOnly("data.backups", "Backups", "Making a backup (it takes a password), restoring or deleting one, and the daily company backup (it takes a typed confirmation).", "backup-export", ["backup", "backups", "restore", "export", "import", "schedule"], () => "managed in Settings"),
        ownerOnly("phone.pairing", "Paired devices", "Pairing a phone or computer with a code, removing one, and what each paired device may do.", "pair", ["pair", "pairing", "qr", "code", "paired", "revoke", "remove device", "device access"], () => "managed in Settings"),
        ownerOnly("computer.lending", "Lending this computer", "Which folders and apps this computer lends to a Cloud or server; each grant is picked and confirmed in the desktop app's own dialogs.", "your-computers", ["lend", "lending", "share computer", "share folders", "pause sharing"], () => "managed in Settings"),
        ownerOnly("data.keepHere", "Keep bots on this computer", "Whether this computer's bots stay here or move to My Cloud; the desktop app takes it only from the person's own click.", "move", ["keep here", "move to cloud", "move back", "bring back"], () => "managed in Settings"),
        ownerOnly("appearance.sidebarPicture", "Sidebar picture", "The picture at the top of the sidebar; it is a file the person picks or removes.", "sidebar-picture", ["wallpaper", "background", "banner", "sidebar image", "picture"], () => "managed in Settings"),
        ownerOnly("account.organization", "Organization", "Joining or leaving a company's managed MausBot; it signs in through the company's portal.", "organization", ["organization", "organisation", "company", "managed"], () => "managed in Settings"),
        ownerOnly("people.signIn", "Who may sign in", "On a self-hosted server, the emails or @domains that may sign in, as admins or members. A change could lock someone out, or hand every setting to someone new.", "members", ["people", "members", "invite", "roles", "admins", "sign in access"], () => "managed in Settings"),
        ownerOnly("remote.domain", "Custom domain", "The web address this self-hosted server answers on. Changing it can cut off the address the person is using right now.", "domain", ["domain", "custom domain", "dns", "public url"], () => cfg().customDomain ?? ""),
        ownerOnly("remote.httpsAddress", "HTTPS address", "This computer's public HTTPS address for paired devices; turning it off can cut off the device the person is using now.", "tailscale", ["https", "public address"], () => "managed in Settings"),
    ];
    return [...safe, ...providers, engines, ...botEntries(deps, writable), ...pictureEntries(deps, writable), ...configEntries(deps, writable), ...windowEntries(windowPref), ...secret, ...owner];
}
export function findSettings(entries, query, limit = 8) {
    const words = query.toLowerCase().split(/[^a-z0-9.-]+/).filter((word) => word.length > 1);
    if (!words.length)
        return [];
    const phrase = words.join(" ");
    const scored = entries.map((entry) => {
        const label = entry.label.toLowerCase(), id = entry.id.toLowerCase();
        const synonyms = entry.synonyms.map((synonym) => synonym.toLowerCase());
        const loose = [entry.help, ...synonyms].join(" ").toLowerCase();
        const whole = id === phrase || label === phrase || synonyms.includes(phrase) ? 10 : 0;
        const score = words.reduce((sum, word) => sum + (id === word || label === word ? 6 : label.includes(word) || id.includes(word) ? 3 : loose.includes(word) ? 1 : 0), whole);
        return { entry, score };
    }).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((hit) => hit.entry);
}
/** The registry over the Settings window's own routes, called as the window calls them. */
export function routeBackedRegistry(deps) {
    const auth = { kind: "loopback", scopes: ["admin", "client"] };
    const refusal = async (reply) => {
        try {
            const { status, body } = await reply;
            return status < 300 ? null : String(body.error ?? `HTTP ${status}`);
        }
        catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
    };
    return createSettingsRegistry({
        cfg: deps.cfg, bots: () => deps.store.bots, sections: () => deps.store.sections, credentials: deps.credentials, window: deps.window, paused: deps.paused,
        saveConfig: (patch) => refusal(callRoute(deps.routes.config, { method: "PUT", path: "/api/config", body: patch, auth })),
        reorderBots: (botIds) => refusal(callRoute(deps.routes.botOrder, { method: "PUT", path: "/api/bots/order", body: { botIds }, auth })),
        pinBot: (botId, pinned) => refusal(callRoute(deps.routes.botPatch, { method: "PATCH", path: `/api/bots/${encodeURIComponent(botId)}`, body: { pinned }, auth })),
        patchBot: (botId, body) => refusal(callRoute(deps.routes.botPatch, { method: "PATCH", path: `/api/bots/${encodeURIComponent(botId)}`, body, auth })),
        call: (route, method, path, body) => refusal(callRoute(deps.routes[route], { method, path, ...(body ? { body } : {}), auth })),
        read: async (route, path) => {
            const reply = await callRoute(deps.routes[route], { method: "GET", path, auth }).catch(() => null);
            return reply && reply.status < 300 ? reply.body : null;
        },
        groupBots: (name, botIds) => refusal(callRoute(deps.routes.sections, { method: "POST", path: "/api/sidebar-sections", body: { name, botIds }, auth })),
        engines: () => deps.providers.instances().filter((instance) => instance.enabled).map((instance) => ({
            instanceId: instance.instanceId, working: deps.providers.lastSnapshot(instance.instanceId)?.state === "available",
            name: instance.displayName ?? BUILT_IN_DRIVERS.find((driver) => driver.driverKind === instance.driverKind)?.metadata.displayName ?? instance.instanceId,
        })),
        addEngine: (path, body) => refusal(callRoute(deps.routes.instances, { method: "POST", path: `/api/instances/${path}`, body, auth })),
        removeEngine: (instanceId) => refusal(callRoute(deps.routes.instances, { method: "DELETE", path: `/api/instances/${encodeURIComponent(instanceId)}`, auth })),
    });
}
