// Privacy invariants: the helper model is unset by default, never replaces an engine that can write the job itself, and
// never writes for a bot whose own engine is disallowed or whose helperModel switch is anything but absent or true.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { helperModelAllowed } from "../shared/wire.js";
import { backgroundTextSlots } from "./job-slots.js";
import { refusesModel } from "./quick-model-fallback.js";
import { fastModelFor } from "./turn-route.js";
/** config.json `helper`: a connected instance and optionally one of its models. Stored config only, so a settings
 * request cannot set it; a mistyped entry reads as no helper rather than costing the whole config. */
export const helperStoredShape = {
    helper: z.object({
        instanceId: z.string().trim().max(200).optional(),
        model: z.string().trim().max(500).optional(),
    }).optional().catch(undefined),
};
/** Goes into a CLI's argv: never a leading dash, no space or control character. */
const HELPER_MODEL_ID = /^[A-Za-z0-9][\x21-\x7e]*$/;
/** OMB_HELPER_INSTANCE / OMB_HELPER_MODEL win over the file; an empty OMB_HELPER_INSTANCE switches a saved helper off.
 * An invalid model switches the helper off rather than writing with a model the person did not name. */
export function helperSelection(cfg, env = process.env) {
    const instanceId = (env.OMB_HELPER_INSTANCE ?? cfg.helper?.instanceId)?.trim();
    if (!instanceId)
        return null;
    const model = (env.OMB_HELPER_MODEL ?? cfg.helper?.model)?.trim();
    if (!model)
        return { instanceId };
    return HELPER_MODEL_ID.test(model) ? { instanceId, model } : null;
}
/** Jobs someone is waiting on, and the representative, which must never get tools, run only on a one-off text call:
 * generateMemoryText starts a whole agent process. */
const ONE_OFF_ONLY = new Set(["compaction", "setup-suggestions", "representative", "status-reply"]);
function ownCall(job, instance) {
    const call = ONE_OFF_ONLY.has(job) ? instance.generateText : instance.generateText ?? instance.generateMemoryText;
    return call?.bind(instance);
}
/** A turn or a person is waiting on these, so they start at once. */
const NEVER_QUEUED = new Set(["compaction", "representative", "status-reply"]);
/** A person sees these soon (a new bot's suggestions card): they wait ahead of memory upkeep and skill review. */
const SEEN_SOON = new Set(["setup-suggestions"]);
export function createSideJobs(deps) {
    // Logged once per change, not once per call.
    let said = null;
    const say = (line) => {
        if (line && line !== said)
            deps.log?.(`helper model: ${line}`);
        said = line;
    };
    const ownFallback = (bot, instance) => ({
        ...(bot.modelSelection.instanceId === instance.instanceId && bot.modelSelection.model ? { model: bot.modelSelection.model } : {}),
        refused: deps.smallModels.refused(instance.instanceId),
        onRefused: (model) => {
            deps.log?.(`small model ${model} refused on ${instance.instanceId}: background text runs on the bot's own model`);
            deps.smallModels.remember(instance.instanceId, model);
        },
    });
    /** The engine's fastest model by the quick-turn rule. Not for Claude: its one-off call already runs its own small model,
     * without thinking. */
    const quickModel = (bot, own) => {
        if (own.driverKind === "claudeAgent" || own.quickModelsUsable?.() === false)
            return {};
        const current = bot.modelSelection.instanceId === own.instanceId && bot.modelSelection.model ? bot.modelSelection.model : own.models.default;
        const model = fastModelFor(own.models, current, deps.smallModels.refused(own.instanceId));
        return model && (!deps.modelAllowed || deps.modelAllowed({ instanceId: own.instanceId, model })) ? { model } : {};
    };
    /** A refused quick model is remembered, so the next card skips it; there is no time left to retry this one. */
    const rememberRefusal = (write, own, model) => async (prompt, options) => {
        try {
            return await write(prompt, options);
        }
        catch (error) {
            if (refusesModel(error instanceof Error ? error.message : String(error), model))
                deps.smallModels.remember(own.instanceId, model);
            throw error;
        }
    };
    /** Every call checks the spend limit: one upkeep pass makes several in a row. */
    const booked = (job, bot, instance, call, trigger, fixed) => async (prompt, options) => {
        deps.assertWithinBudget();
        const threadId = `${job}-${randomUUID()}`;
        return call(prompt, {
            ...options,
            ...fixed(),
            onUsage: (usage) => deps.book({
                botId: bot.id,
                botName: bot.name,
                threadId,
                instanceId: instance.instanceId,
                driverKind: instance.driverKind,
                model: usage.model,
                input: usage.input ?? 0,
                output: usage.output ?? 0,
                ...(usage.cachedInput !== undefined ? { cachedInput: usage.cachedInput } : {}),
                costUsd: usage.costUsd ?? null,
                trigger,
            }, usage.input !== undefined && usage.output !== undefined, bot.threadId),
        });
    };
    /** Whatever the lookup throws reads as no helper: a helper never fails a job or the turn waiting on one. */
    function usableHelper() {
        try {
            return findHelper();
        }
        catch (error) {
            // A JSON error can quote the text it failed on.
            const why = error instanceof SyntaxError ? "invalid JSON" : error instanceof Error ? error.message : "unknown";
            say(`the helper could not be looked up (${why}), so bots whose engine has no one-off text call keep their fallback`);
            return null;
        }
    }
    function findHelper() {
        const helper = deps.helper();
        if (!helper) {
            say(null);
            return null;
        }
        const name = JSON.stringify(helper.instanceId);
        const unused = (why) => {
            say(`${why}, so bots whose engine has no one-off text call keep their fallback`);
            return null;
        };
        const instance = deps.instance(helper.instanceId);
        if (!instance)
            return unused(`the helper instance ${name} is not connected`);
        if (!instance.enabled)
            return unused(`the helper instance ${name} is switched off`);
        if (!instance.generateText)
            return unused(`the helper instance ${name} cannot make a one-off text call`);
        const refusal = deps.refusal(instance);
        if (refusal)
            return unused(`the helper instance ${name} is not used (${refusal})`);
        if (helper.model && deps.modelAllowed && !deps.modelAllowed({ instanceId: helper.instanceId, model: helper.model })) {
            return unused(`the helper model ${JSON.stringify(helper.model)} is not assigned to this workspace`);
        }
        say(`small writing jobs for bots whose engine has no one-off text call are written by ${name}${helper.model ? ` (${helper.model})` : ""}`);
        return { instance, call: instance.generateText.bind(instance), ...(helper.model ? { model: helper.model } : {}) };
    }
    const slots = deps.slots ?? backgroundTextSlots;
    const queued = (job, found) => found && !NEVER_QUEUED.has(job)
        ? { via: found.via, generateText: (prompt, { waiting, started, ...options } = {}) => slots.run(() => {
                started?.();
                return found.generateText(prompt, options);
            }, { signal: options.signal, interactive: SEEN_SOON.has(job), onWait: waiting }) }
        : found;
    function find(job, botId, at) {
        const bot = deps.bot(botId);
        const own = at.instance ?? (bot ? deps.instance(bot.modelSelection.instanceId) : null);
        if (!bot || !own || deps.refusal(own))
            return null;
        // The review's changes are written with the bot's own skill tools, whoever read the conversation.
        if (job === "skill-review" && own.adapter.capabilities.agentsMcp !== true)
            return null;
        const call = ownCall(job, own);
        if (call) {
            // The summary belongs to a turn that already passed the spend limit and is not booked on its own.
            if (job === "compaction")
                return { via: "engine", generateText: call };
            if (job === "setup-suggestions") {
                const quick = quickModel(bot, own);
                const write = booked(job, bot, own, call, { kind: "bot", botId: bot.id }, () => ({ fallback: ownFallback(bot, own), ...quick }));
                return { via: "engine", generateText: quick.model ? rememberRefusal(write, own, quick.model) : write };
            }
            return { via: "engine", generateText: booked(job, bot, own, call, { kind: "bot", botId: bot.id }, () => ({ fallback: ownFallback(bot, own) })) };
        }
        if (!helperModelAllowed(bot))
            return null;
        const helper = usableHelper();
        if (!helper)
            return null;
        return { via: "helper", generateText: booked(job, bot, helper.instance, helper.call, { kind: "helper", botId: bot.id, job }, () => (helper.model ? { model: helper.model } : {})) };
    }
    return {
        text: (job, botId, at = {}) => queued(job, find(job, botId, at)),
    };
}
