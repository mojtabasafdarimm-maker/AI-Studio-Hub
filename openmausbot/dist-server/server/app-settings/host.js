// The app_settings tool for one turn: find, get and set over the registry, where the entry's tier is the whole policy.
// Writes happen only in the owner's own turn and apply at once with Undo, a secret never passes through the bot, and an
// owner-only setting is only explained.
import { randomUUID } from "node:crypto";
import { isSettingsCardId, SETTINGS_CARD_IDS } from "../../shared/app-settings.js";
import { appendDecision } from "../decision-log.js";
import { UNDO_STALE } from "../direct-apply.js";
import { serverLine } from "../server-lines.js";
import { cardElsewhere, cardNotInRoom, cardShownStatus, SETTINGS_CARDS } from "./cards.js";
import { findPlaces, placePath, placesList } from "./places.js";
import { findSettings, personOnly } from "./registry.js";
export const TOOL = "app_settings";
export const WRITE_BUDGET = 10;
const THEME_ACTIONS = ["theme", "set_theme", "add_theme_asset", "theme_history", "undo_theme"];
const FIND_LIMIT = 8;
const NOT_SET = "not set";
const text = (value) => value || NOT_SET;
const said = ({ before, after }) => (before === undefined ? after : `${text(before)} → ${text(after)}`);
/** The tool sends every value as text so strict-schema providers accept it; numbers, true/false and JSON are read back
 * from it when the text alone does not fit the setting. A JSON object or list is judged as itself. */
function parseValue(entry, value) {
    const direct = entry.value.safeParse(value);
    if (direct.success || typeof value !== "string")
        return direct;
    try {
        const json = JSON.parse(value);
        const read = entry.value.safeParse(json);
        return read.success || (typeof json === "object" && json !== null) ? read : direct;
    }
    catch {
        return direct;
    }
}
export function createAppSettings(deps) {
    const { store, entries } = deps;
    const undoable = new Map();
    const writes = new Map();
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const reply = (status, body) => ({ status, body });
    const refuse = (status, error) => reply(status, { error });
    const describe = (entry) => ({ id: entry.id, label: entry.label, tier: entry.tier, value: text(entry.read()), where: placePath(entry.where) });
    const from = (bot, threadId) => (deps.connectorThread(bot.id, threadId)?.group ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {});
    const spendWrite = (turn) => {
        const spent = writes.get(turn.generation) ?? 0;
        if (spent >= WRITE_BUDGET)
            return `This turn has already changed ${WRITE_BUDGET} settings. Ask the user to send a new message before changing more.`;
        writes.set(turn.generation, spent + 1);
        if (writes.size > 200)
            writes.delete(writes.keys().next().value);
        return null;
    };
    /** Applies the change, posts its applied card with Undo, and logs it in the decision log. */
    async function apply(turn, bot, entry, value, change) {
        const before = await entry.current(value);
        const was = entry.read();
        const refusal = await entry.write(value);
        if (refusal)
            return refuse(409, refusal);
        const after = entry.read();
        const shown = change === undefined ? { before: was, after } : { after: change };
        const requestId = randomUUID();
        const language = deps.language(turn.threadId);
        const notSet = (value) => value || serverLine(language, "server.appSettings.notSet");
        const appSettingRequest = { settingId: entry.id, label: entry.label, ...(shown.before === undefined ? {} : { before: shown.before }), after: shown.after, tier: entry.tier };
        store.appendMessage(turn.threadId, {
            role: "bot", kind: "options", ...from(bot, turn.threadId),
            card: { title: serverLine(language, "server.appSettings.changed", { label: entry.label }), subtitle: shown.before === undefined ? shown.after : `${notSet(shown.before)} → ${notSet(shown.after)}`,
                options: [], requestId, tool: TOOL, fixedOptions: true, appSettingRequest, answered: "allow", dismissed: true, autoApplied: true },
        });
        undoable.set(requestId, { entry, before, after });
        appendDecision(deps.dataDir, { threadId: turn.threadId, requestId, botId: turn.botId, botName: bot.name, tool: TOOL, summary: `${entry.id}: ${said(shown)}`, decision: "auto-approved", source: "app-settings" });
        const done = change === undefined ? `Changed ${entry.label} from ${text(was)} to ${text(after)}.` : `Done: ${change}. ${entry.label} now: ${text(after)}.`;
        return reply(200, { text: `${done} The user can undo it from the card in the conversation.` });
    }
    async function set(turn, body) {
        const entry = typeof body.id === "string" ? byId.get(body.id) : undefined;
        if (!entry)
            return refuse(404, `No setting with id ${JSON.stringify(body.id ?? null)}. Use action find first.`);
        const bot = store.bot(turn.botId);
        if (!bot)
            return refuse(404, "This bot no longer exists.");
        if (entry.tier === "owner-only")
            return refuse(403, personOnly(entry.label, entry.where));
        if (deps.guestDriven(turn.threadId) || deps.turnOwner(turn) === null)
            return refuse(403, "Settings change only in the owner's own conversation. This turn was not started by the owner here, so nothing changed; you may still read settings.");
        if (entry.tier === "secret") {
            if (body.value !== undefined)
                return refuse(400, `Never send a key or token as a value. Call set on ${entry.id} with no value: a secure card asks the user for it, and you never see it.`);
            const budget = spendWrite(turn);
            if (budget)
                return refuse(429, budget);
            const posted = await deps.requestCredential(bot, turn.threadId, { credentialId: entry.credentialId, reason: typeof body.reason === "string" ? body.reason : undefined });
            if (!posted.body.error && posted.body.alreadyConfigured === true)
                return reply(200, { text: `${entry.label} is already set. To replace it, the user changes it in ${placePath(entry.where)}.` });
            if (posted.status >= 300)
                return refuse(posted.status, String(posted.body.error ?? "The secure card could not be shown."));
            return reply(200, { text: `A secure card for ${entry.label} is ready in MausBot. End this turn now and say in one line that you are waiting for it; MausBot resumes you when the user saves it or declines. You never see the key.` });
        }
        const parsed = parseValue(entry, body.value);
        if (!parsed.success)
            return refuse(400, `${entry.label} takes ${entry.allowed}. ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
        if (entry.id === "bots.settings" && parsed.data.computer === "local" && deps.automated?.(turn)) {
            return refuse(403, `A routine or automation can't keep a bot on this computer. Nothing changed: say in one line that the person can choose This computer under “Where ${bot.name} works” in Bot's screen, or ask you in their own chat.`);
        }
        const described = entry.describe?.(parsed.data);
        if (described && "refusal" in described)
            return refuse(409, described.refusal);
        const budget = spendWrite(turn);
        if (budget)
            return refuse(429, budget);
        const picture = entry.fromFile ? await takePicture(turn, parsed.data) : { value: parsed.data };
        if ("refusal" in picture)
            return refuse(400, picture.refusal);
        const applied = await apply(turn, bot, entry, picture.value, described?.change);
        if (picture.stored && applied.status >= 300)
            deps.pictures?.discard(picture.stored);
        return applied;
    }
    /** A value naming a picture file by `path` goes on as the stored picture's `avatarUrl`; an empty path stays, to remove it. */
    async function takePicture(turn, value) {
        const { path, ...rest } = value;
        if (typeof path !== "string" || !path)
            return { value };
        if (!deps.pictures)
            return { refusal: "Pictures can't be set from a file here." };
        const taken = await deps.pictures.take(turn, path);
        return "refusal" in taken ? taken : { value: { ...rest, avatarUrl: taken.avatarUrl }, stored: taken.avatarUrl };
    }
    /** A theme is the person's whose own message began the work, never a teammate's or a guest's. */
    async function theme(turn, body) {
        const themes = deps.themes;
        if (!themes)
            return refuse(404, "Themes are not available on this server.");
        const bot = store.bot(turn.botId);
        if (!bot)
            return refuse(404, "This bot no longer exists.");
        const person = deps.guestDriven(turn.threadId) ? null : themes.person(turn);
        if (!person)
            return refuse(403, "A theme changes only for the person who asked, in their own conversation. This turn was not started by them here, so nothing changed.");
        if (body.action === "theme")
            return themes.overview(person, body.id);
        if (body.action === "theme_history")
            return themes.history(person);
        const asked = body.action === "set_theme" ? themes.wanted(person, body) : body.action === "undo_theme" ? themes.undo(person, body) : null;
        if (asked && "error" in asked)
            return refuse(400, asked.error);
        const budget = spendWrite(turn);
        if (budget)
            return refuse(429, budget);
        return asked ? apply(turn, bot, themes.entry(person), asked.wear, asked.change) : themes.addAsset(turn, person, body);
    }
    /** Shows a setting's own control in the conversation. Security invariant: the reply and the row carry fixed words and
     * the card's id only; the control's code, link and address never pass through here. */
    function showCard(turn, body) {
        if (!isSettingsCardId(body.card))
            return refuse(404, `No settings card ${JSON.stringify(body.card ?? null)}. Cards: ${SETTINGS_CARD_IDS.join(", ")}.`);
        const card = SETTINGS_CARDS[body.card];
        const bot = store.bot(turn.botId);
        if (!bot)
            return refuse(404, "This bot no longer exists.");
        if (deps.guestDriven(turn.threadId) || deps.turnOwner(turn) === null)
            return refuse(403, "A settings card shows only in the owner's own conversation, when they asked. This turn was not started by the owner here, so nothing was shown.");
        if (!deps.cards?.here(body.card))
            return reply(200, { text: cardElsewhere(card) });
        if (deps.connectorThread(bot.id, turn.threadId)?.group)
            return reply(200, { text: cardNotInRoom(card) });
        const budget = spendWrite(turn);
        if (budget)
            return refuse(429, budget);
        store.appendMessage(turn.threadId, { role: "bot", kind: "text", text: card.text, settingsCard: { id: body.card } });
        return reply(200, { text: cardShownStatus(card, deps.cards.on(body.card)) });
    }
    return {
        async handle(body, turn) {
            if (body.action === "find") {
                const query = typeof body.query === "string" ? body.query : "";
                const hits = findSettings(entries, query, FIND_LIMIT).map(describe);
                if (hits.length)
                    return reply(200, { text: JSON.stringify(hits) });
                const places = findPlaces(query);
                return reply(200, { text: `No setting you can change matches ${JSON.stringify(query)}.${places.length ? ` Where the person finds it in the app: ${places.join("; ")}.` : " Try other words, or use action places."}` });
            }
            if (body.action === "places") {
                const query = typeof body.query === "string" ? body.query.trim() : "";
                const places = query ? findPlaces(query) : [];
                return reply(200, { text: query ? (places.length ? places.join("\n") : `No place in the app matches ${JSON.stringify(query)}. Here is every place:\n${placesList()}`) : placesList() });
            }
            if (body.action === "get") {
                const entry = typeof body.id === "string" ? byId.get(body.id) : undefined;
                if (!entry)
                    return refuse(404, `No setting with id ${JSON.stringify(body.id ?? null)}. Use action find first.`);
                return reply(200, { text: JSON.stringify({ ...describe(entry), help: entry.help, ...("allowed" in entry ? { allowed: entry.allowed } : {}),
                        change: entry.tier === "owner-only" ? `only the person, in ${placePath(entry.where)}` : entry.tier === "secret" ? "set with no value opens a secure card" : "set applies at once, with Undo on the card" }) });
            }
            if (body.action === "set")
                return set(turn, body);
            if (body.action === "show_card")
                return showCard(turn, body);
            if (typeof body.action === "string" && THEME_ACTIONS.includes(body.action))
                return theme(turn, body);
            return refuse(400, `action must be find, get, set, show_card, places, ${THEME_ACTIONS.join(", ")}.`);
        },
        /** Undo on an applied card: restores the value read before the change, unless it changed since. */
        async undo(args) {
            const message = store.messagesFor(args.threadId).find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.appSettingRequest);
            const current = message?.card;
            if (!message || !current)
                return { claimed: false };
            if (current.undone)
                return { claimed: true, state: "already_undone" };
            const change = undoable.get(args.requestId);
            if (!change || current.answered !== "allow")
                return { claimed: true, state: "invalid", error: "This change can't be undone here.", status: 409 };
            if (change.entry.read() !== change.after)
                return { claimed: true, state: "invalid", error: UNDO_STALE, status: 409, stale: true };
            const refusal = change.before === undefined ? "The earlier value is not one that can be set back." : await change.entry.write(change.before);
            if (refusal)
                return { claimed: true, state: "invalid", error: refusal, status: 409 };
            undoable.delete(args.requestId);
            store.patchMessage(args.threadId, message.id, { card: { ...current, undone: true } });
            return { claimed: true, state: "undone" };
        },
    };
}
