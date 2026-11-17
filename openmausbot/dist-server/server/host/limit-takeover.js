// When the AI a bot runs on reaches its usage limit, or is signed out, the bot carries on with another AI the person has
// set up until that limit resets or the AI is signed in again, without anyone being asked, and the person hears it once
// for that stretch. What is held (an engine's limit on the reset clock, one model's own limit, a sign-in that expired)
// is saved, so every new turn and thread of every bot starts on the AI that carries on, a restart included.
import { readFileSync } from "node:fs";
import { approvalModeFor, modelSwitchNeedsAsk } from "../../shared/approval-mode.js";
import { writeFileAtomic } from "../atomic.js";
import { recoveryCapabilityError } from "../automatic-recovery.js";
import { readyToRun, selectDefaultModelSelection } from "../default-model-selection.js";
import { engineFailureKind } from "../drivers/engine-errors.js";
import { classifyError } from "../drivers/retry.js";
import { billsEachUse, failoverLine, limitBackupAllowed, signedOutLine } from "../limit-failover.js";
import { LimitNotices, limitNoticeText, signedOutNoticeText } from "../limit-notices.js";
import { UNNAMED_LIMIT_MS } from "../limit-resets.js";
/** A model's own limit holds that model at most this long before it is tried again, in case its window ended early. */
export const MODEL_HOLD_MS = 6 * 60 * 60_000;
/** A signed-out AI is tried again by a new turn no sooner than this after its last refusal, in case it signed in again
 * some way this server did not see; a finished sign-in in the app, or a turn on it that works, ends the hold at once. */
export const SIGNED_OUT_RECHECK_MS = UNNAMED_LIMIT_MS;
/** A sign-out's first notice to a bot stands until the AI is signed in again or works. */
const SIGNED_OUT_STRETCH_MS = 30 * 24 * 60 * 60_000;
/** Refusals never end a sign-out's stretch, so the person is told again this often, once across all bots. */
export const SIGNED_OUT_REPEAT_MS = 24 * 60 * 60_000;
const EVERY_BOT = "every-bot";
/** A turn its AI stopped for want of a sign-in. ACP engines stop an account out of credit or with no active plan as
 * "auth_required" too; signing in again fixes neither, so those words are no sign-out. */
export function signedOutStop(stopReason, said) {
    return stopReason === "auth_required" && !(said && (engineFailureKind(said) === "credits" || classifyError({ text: said }).reason === "quota"));
}
export function createLimitTakeover(deps) {
    const now = deps.now ?? Date.now;
    const notices = new LimitNotices(deps.file, now);
    const heldModels = new Map();
    /** Each signed-out AI and when it last refused a turn for that. */
    const signedOut = new Map();
    /** What each thread's turn said in its last setup error, until that turn ends. */
    const setupSaid = new Map();
    const modelKey = (selection) => `${selection.instanceId}\u0000${selection.model}`;
    const signedOutKey = (instanceId) => `signed-out\u0000${instanceId}`;
    const incidentKey = (botId) => `incident\u0000${botId}`;
    /** The notice and incident key of what refused: the account on an engine, a sign-in, or one model. */
    const limitedKey = (from, scope) => scope === "engine" ? from.instanceId
        : scope === "signed-out" ? signedOutKey(from.instanceId) : modelKey(from);
    /** What a restart left held, without what has run out. */
    const load = (file) => {
        let saved;
        try {
            saved = JSON.parse(readFileSync(file, "utf8"));
        }
        catch {
            return;
        }
        for (const [key, hold] of Object.entries(saved?.models ?? {})) {
            if (Number.isFinite(hold?.until) && hold.until > now() && (hold.scope === "model" || hold.scope === "credits"))
                heldModels.set(key, hold);
        }
        for (const [instanceId, at] of Object.entries(saved?.signedOut ?? {})) {
            if (Number.isFinite(at) && at > now() - SIGNED_OUT_STRETCH_MS)
                signedOut.set(instanceId, at);
        }
    };
    if (deps.holdsFile)
        load(deps.holdsFile);
    const save = () => {
        if (!deps.holdsFile)
            return;
        const holds = { models: Object.fromEntries(heldModels), signedOut: Object.fromEntries(signedOut) };
        try {
            writeFileAtomic(deps.holdsFile, JSON.stringify(holds), { mode: 0o600 });
        }
        catch (error) {
            console.error(`limit takeover: could not save holds: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    const modelHeld = (selection) => {
        const held = heldModels.get(modelKey(selection));
        if (!held)
            return null;
        if (held.until > now())
            return held;
        heldModels.delete(modelKey(selection));
        save();
        return null;
    };
    const holdModel = (selection, scope, resetsAt) => {
        const at = now(), named = resetsAt !== undefined && resetsAt > at ? resetsAt : undefined;
        heldModels.set(modelKey(selection), { until: Math.min(named ?? at + UNNAMED_LIMIT_MS, at + MODEL_HOLD_MS), ...(named ? { resetsAt: named } : {}), scope });
        save();
    };
    /** A new turn on this AI goes to another one: it refused a sign-in within the re-check interval, or its status says
     * it is still signed out. */
    const signedOutHeld = (instanceId) => {
        const at = signedOut.get(instanceId);
        return at !== undefined && (now() - at < SIGNED_OUT_RECHECK_MS || deps.signedOutNow?.(instanceId) === true);
    };
    const noteSignedOut = (instanceId) => {
        const first = !signedOut.has(instanceId);
        signedOut.set(instanceId, now());
        save();
        if (first)
            deps.signedOutNoticed?.(instanceId);
    };
    /** The AI is signed in again, or a turn on it worked: every bot's next turn may use it, and its next sign-out is told. */
    const signedIn = (instanceId) => {
        if (!signedOut.delete(instanceId))
            return;
        save();
        notices.endedEverywhere(signedOutKey(instanceId));
    };
    const usable = (engines, current, selection, scope, approval) => {
        const engine = engines.find((candidate) => candidate.instanceId === selection.instanceId);
        if (!engine || !readyToRun(engine, deps.context) || deps.blockedUntil(engine.instanceId, selection.model) !== null || modelHeld(selection) !== null)
            return false;
        if (engine.instanceId !== current.instanceId) {
            if (signedOutHeld(engine.instanceId))
                return false;
            // Another sign-in to the same plan never carries a limit (that rotates accounts); it may stand in for one signed out.
            if (scope !== "signed-out" && !limitBackupAllowed(current, engine, deps.configs()[engine.instanceId]))
                return false;
            // The same rule as switching by hand: a level the other AI has no such mode for needs the person first.
            if (approval && modelSwitchNeedsAsk(approval, current.driverKind, engine.driverKind))
                return false;
        }
        if (recoveryCapabilityError(current, engine))
            return false;
        return engine.models.default === selection.model || engine.models.options.some((model) => model.id === selection.model);
    };
    /** The AIs that may carry on while `from` is limited or signed out, best first: for one model's limit the same AI's own
     * default model, then the backups the person chose, then (for a limit) the AI MausBot would pick for a new bot among
     * the rest that draw on a plan. One that bills each use spends the person's money, so it carries on only as a backup
     * they chose; a signed-out AI's turns go only to a backup they chose. `approval`: the thread's level, when known. */
    function backups(botId, from, scope = "engine", approval) {
        const engines = deps.engines();
        const current = engines.find((engine) => engine.instanceId === from.instanceId);
        if (!current)
            return [];
        const out = [];
        const add = (selection) => {
            if (selection.instanceId === from.instanceId && (scope === "engine" || scope === "signed-out" || selection.model === from.model))
                return;
            if (out.some((known) => known.instanceId === selection.instanceId && known.model === selection.model))
                return;
            if (usable(engines, current, selection, scope, approval))
                out.push({ instanceId: selection.instanceId, model: selection.model });
        };
        if (scope === "model" || scope === "credits")
            add({ instanceId: current.instanceId, model: current.models.default });
        for (const selection of scope === "signed-out" ? deps.signedOutChosen?.(botId) ?? deps.chosen(botId) : deps.chosen(botId))
            add(selection);
        if (scope === "signed-out")
            return out;
        const others = engines.filter((engine) => engine.instanceId !== from.instanceId && engine.access !== "api" && !billsEachUse(deps.configs()[engine.instanceId])
            && usable(engines, current, { instanceId: engine.instanceId, model: engine.models.default }, scope, approval));
        const pick = selectDefaultModelSelection(others, undefined, deps.context);
        if (pick.instanceId && pick.model)
            add(pick);
        return out;
    }
    const label = (selection, from) => (selection.instanceId === from.instanceId
        ? `${deps.engineName(selection.instanceId)} ${selection.model}` : deps.engineName(selection.instanceId));
    /** What refused, as the person knows it: the AI, or for one model's own limit that AI's model. */
    const refusedName = (from, scope) => (scope === "model" || scope === "credits"
        ? `${deps.engineName(from.instanceId)} ${from.model}` : deps.engineName(from.instanceId));
    /** Once for this stretch of `from`'s limit or sign-out, and for a sign-out again every SIGNED_OUT_REPEAT_MS: which AI carries
     * on for `bot` meanwhile, or that it waits. The words told, or null when there is nothing to say now. */
    const tell = (bot, from, facts) => {
        const scope = facts.scope ?? "engine";
        const signOut = scope === "signed-out";
        const first = notices.first(bot.id, limitedKey(from, scope), signOut ? now() + SIGNED_OUT_STRETCH_MS : facts.resetsAt);
        const scheduled = signOut && notices.due(EVERY_BOT, limitedKey(from, scope), SIGNED_OUT_REPEAT_MS);
        if (!first && !scheduled)
            return null;
        const backup = facts.backup ? { backup: label(facts.backup, from) } : {};
        const stuck = signOut && !facts.backup ? (deps.botsOn?.(from.instanceId) ?? []).filter((one) => backups(one.id, one.modelSelection, "signed-out", approvalModeFor(one)).length === 0).map((one) => one.name) : [];
        const text = signOut ? signedOutNoticeText({ engine: refusedName(from, scope), bot: bot.name, where: deps.where ?? "on this computer", ...backup, ...(stuck.length ? { stuck } : {}) })
            : limitNoticeText({ engine: refusedName(from, scope), bot: bot.name, ...(facts.resetsAt ? { resetsAt: facts.resetsAt } : {}), ...(scope === "credits" ? { credits: true } : {}), ...backup });
        deps.tell(bot, text);
        return text;
    };
    /** A conversation of `botId` moved from `from` to `to` because `from` was limited or signed out; it goes back once
     * that ends. */
    const moved = (botId, threadId, from, to, resetsAt, scope) => {
        deps.record({ botId, threadId, from, to, resetsAt: resetsAt ?? null, at: now(), ...(scope === "signed-out" ? { why: "signed-out" } : {}) });
    };
    /** A turn on `selection` worked for this bot: its engine's next limit is a new stretch, and it is plainly signed in. */
    const worked = (botId, selection) => {
        for (const who of [botId, incidentKey(botId)]) {
            notices.ended(who, selection.instanceId);
            notices.ended(who, modelKey(selection));
        }
        if (heldModels.delete(modelKey(selection)))
            save();
        signedIn(selection.instanceId);
    };
    return {
        backups,
        /** This model alone, held by its own limit; null when it is not. */
        modelHeld,
        /** This model's own limit refused a turn: it is held until the reset the limit named, an hour when it named none,
         * and at most MODEL_HOLD_MS. */
        holdModel,
        /** The AI refused a turn because it is signed out. */
        noteSignedOut,
        signedIn,
        /** Whether a conversation moved off this signed-out AI waits before going back: until it is signed in again or a
         * turn on it works. */
        stillSignedOut: (instanceId) => signedOut.has(instanceId),
        /** Before a turn on `selection`: what holds that AI, when another AI can take the turn instead, so it starts there
         * with no refused turn first. Null when nothing holds it, or when nothing could carry on and the AI is tried as
         * usual. `recovering`: Automatic recovery has backups of its own for a limit. */
        heldAtStart(bot, selection, recovering = false) {
            const engineUntil = deps.blockedUntil(selection.instanceId, selection.model);
            const model = engineUntil === null ? modelHeld(selection) : null;
            const scope = engineUntil !== null ? "engine" : model ? model.scope : signedOutHeld(selection.instanceId) ? "signed-out" : null;
            if (!scope)
                return null;
            const carries = (deps.enabled?.() ?? true) && backups(bot.id, selection, scope, approvalModeFor(bot)).length > 0;
            if (!carries && !(recovering && scope !== "signed-out"))
                return null;
            const resetsAt = scope === "engine" ? deps.resetAt?.(selection.instanceId, selection.model) ?? undefined : model?.resetsAt;
            return { scope, ...(resetsAt && resetsAt > now() ? { resetsAt } : {}) };
        },
        /** Every runtime event of a bot's thread, with the model its turn ran on: a model's own limit holds that model, a
         * refused sign-in holds the AI, and a turn that works ends what held it. */
        noteRuntimeEvent(botId, selection, event) {
            if (event.type === "runtime.error" && event.setup)
                setupSaid.set(event.threadId, event.message);
            const said = event.type === "turn.completed" || event.type === "session.exited" ? setupSaid.get(event.threadId) : undefined;
            if (said !== undefined)
                setupSaid.delete(event.threadId);
            if (!selection)
                return;
            if (event.type === "runtime.error" && (event.limit === "model" || event.limit === "credits")) {
                for (const model of event.limitModels?.length ? event.limitModels : [selection.model])
                    holdModel({ ...selection, model }, event.limit, event.limitResetsAt);
            }
            else if (event.type === "turn.completed" && event.ok)
                worked(botId, selection);
            else if (event.type === "turn.completed" && signedOutStop(event.stopReason, said))
                noteSignedOut(selection.instanceId);
        },
        tell,
        moved,
        /** A turn refused at its start (a limit, or a sign-out) runs on `to` now: the conversation goes back once that ends,
         * the person hears it once, and these are the rows its conversation shows: one line, and for a sign-out told here,
         * the notice whose Sign in fixes it. */
        carriedOn(bot, threadId, from, to, facts) {
            moved(bot.id, threadId, from, to, facts.resetsAt, facts.scope);
            const told = tell(bot, from, { ...facts, backup: to });
            const line = facts.scope === "signed-out" ? signedOutLine(refusedName(from, facts.scope), label(to, from))
                : failoverLine(refusedName(from, facts.scope), label(to, from), facts.resetsAt);
            return [{ name: `recovery: ${line}`, ok: true, ...(facts.scope === "signed-out" ? { nameCode: "chat.notice.failoverSignedOut", nameParams: { from: refusedName(from, facts.scope), to: label(to, from) } } : {}) }, ...(told && facts.scope === "signed-out" ? [{ name: `notice: ${told}`, ok: true, setup: true }] : [])];
        },
        /** True once per bot for each stretch of this limit or sign-out: the one incident its Chief is told about, not one per
         * refused turn. */
        firstIncident(botId, from, scope = "engine", resetsAt) {
            return notices.first(incidentKey(botId), limitedKey(from, scope), scope === "signed-out" ? now() + SIGNED_OUT_STRETCH_MS : resetsAt);
        },
        worked,
    };
}
