import { freeFallback, rankAis } from "../shared/ai-ranking.js";
/** The shared ranking (shared/ai-ranking.ts), with an AI that answered its test ahead of one that didn't or wasn't tested.
 * OpenCode's free backup comes in only once every other AI didn't answer. */
const best = (instances, context) => {
    const ranked = rankAis(instances);
    const usable = (list) => list.find((instance) => context.answered?.(instance) === true)
        ?? list.find((instance) => context.answered?.(instance) !== false);
    return usable(ranked.filter((instance) => !freeFallback(instance))) ?? usable(ranked) ?? ranked[0];
};
/** The saved config's enabled switch and picker group win over what the driver reports. */
/** Every list a person or the server chooses a model from passes here, so a hidden provider drops out of all of them. */
export function withInstanceConfig(instances, configs) {
    return instances.filter((instance) => configs[instance.instanceId]?.hidden !== true).map((instance) => ({
        ...instance,
        enabled: configs[instance.instanceId]?.enabled ?? instance.enabled,
        ...(configs[instance.instanceId]?.access ? { access: configs[instance.instanceId].access } : {}),
    }));
}
/** A custom endpoint brings its own credential, so its sign-in state does not count. */
export function signedOut(instance) {
    return instance.snapshot.state === "available" && instance.access !== "custom" && instance.snapshot.authenticated === false;
}
export function readyToRun(instance, context = {}) {
    return instance.enabled !== false && instance.snapshot.state === "available" && context.refusal?.(instance) === undefined && !signedOut(instance);
}
const defaultModel = (instance) => instance.models.default.trim()
    ? instance.models.default
    : instance.models.options.find((model) => model.id.trim())?.id ?? "";
/** A saved choice is intentional: an unavailable provider sends new bots to setup, never silently to another provider. On
 * an enrolled desktop a working personal engine beats a Company one, so billing stays the person's choice. */
export function selectDefaultModelSelection(instances, preferred, context = {}) {
    if (preferred && (preferred.instanceId || preferred.model)) {
        const instance = instances.find((candidate) => candidate.instanceId === preferred.instanceId);
        if (instance?.snapshot.state !== "available" ||
            instance.enabled === false ||
            signedOut(instance) ||
            !preferred.model.trim() ||
            // A disallowed saved engine is unusable like an unavailable one: setup, never another provider.
            context.refusal?.(instance) !== undefined ||
            (preferred.variant !== undefined && !instance.capabilities?.modelVariants) ||
            !(instance.models.default === preferred.model || instance.models.options.some((model) => model.id === preferred.model))) {
            return { instanceId: "", model: "" };
        }
        const selection = { ...preferred };
        // A saved effort can outlive driver support: keep the model, let the provider use its default effort.
        if (selection.effort && !instance.capabilities?.effortLevels?.includes(selection.effort))
            delete selection.effort;
        return selection;
    }
    const available = instances.filter((instance) => instance.enabled !== false && instance.snapshot.state === "available" && context.refusal?.(instance) === undefined && defaultModel(instance));
    const ready = available.filter((instance) => readyToRun(instance, context));
    const company = context.company;
    const personal = company && instances.some((instance) => company(instance.instanceId))
        ? best(ready.filter((instance) => !company(instance.instanceId)), context)
        : undefined;
    const pick = personal ?? best(ready, context) ?? best(available, context);
    return { instanceId: pick?.instanceId ?? "", model: pick ? defaultModel(pick) : "" };
}
/** An explicit effort or variant wins; an engine without the level sends none rather than failing turn 1. */
export function withNewBotEffort(selection, effort, offered) {
    if (!effort || selection.effort !== undefined || selection.variant !== undefined || !offered?.includes(effort)) {
        return selection;
    }
    return { ...selection, effort };
}
