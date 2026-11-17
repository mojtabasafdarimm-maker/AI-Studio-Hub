import { decodeInjectId } from "../local-inject.js";
import { acpModelOption, acpVariantOption, offeredModels } from "./config-options.js";
export class SessionModelControls {
    revision = 0;
    input;
    constructor(input) { this.input = input; }
    usesAgentDefault() {
        return this.input.selection?.agentDefault !== undefined
            && this.input.model() === this.input.selection.agentDefault;
    }
    modelOf(result) {
        const configId = this.input.selection?.configId ?? "model";
        if (this.input.selection?.allowLegacy)
            return acpModelOption(result, configId)?.currentValue ?? null;
        const option = (Array.isArray(result?.configOptions) ? result.configOptions : [])
            .find((entry) => entry?.id === configId);
        return typeof option?.currentValue === "string" ? option.currentValue : null;
    }
    receive(result, replace = false) {
        if (!replace && !Array.isArray(result?.configOptions) && !result?.models)
            return;
        const state = replace ? result : { ...this.input.state(), ...result };
        this.input.store(state);
        this.revision++;
        if (!this.input.variants)
            return;
        const model = this.input.model();
        const nativeModel = this.usesAgentDefault() ? model : this.modelOf(state) ?? model;
        if (!nativeModel)
            return;
        const option = acpVariantOption(state);
        this.input.report(nativeModel === model ? this.input.reportedModel() ?? nativeModel : nativeModel, {
            options: option?.options ?? [],
            ...(option?.currentValue !== undefined ? { currentValue: option.currentValue } : {}),
        });
    }
    confirms(model) {
        if (!model || this.usesAgentDefault())
            return true;
        const selected = this.modelOf(this.input.state());
        return selected === model || (selected === null && this.input.selection?.unsetIds?.includes(model) === true);
    }
    variant(value) {
        if (!this.input.variants)
            throw new Error(`${this.input.displayName} does not support model variants`);
        const option = acpVariantOption(this.input.state());
        if (!option || !option.options.some((entry) => entry.id === value)) {
            throw new Error(`${this.input.displayName} does not advertise variant ${value} for this model`);
        }
        return option;
    }
    async select(request, sessionId, timeoutMs) {
        const wanted = this.input.model();
        let selected = this.modelOf(this.input.state());
        if (!wanted || this.usesAgentDefault() || wanted === selected)
            return selected;
        const configId = this.input.selection?.configId ?? "model";
        const option = this.input.selection?.allowLegacy ? acpModelOption(this.input.state(), configId) : undefined;
        if (option && option.configId === undefined) {
            if (!option.options.some((entry) => entry.id === wanted)) {
                throw new Error(`${this.input.displayName} does not advertise model ${wanted}`);
            }
            const before = this.revision;
            await request("session/set_model", { sessionId, modelId: wanted }, timeoutMs, (response) => {
                if (response?.models || Array.isArray(response?.configOptions))
                    this.receive(response, true);
                if (this.revision === before) {
                    // ACP's legacy set_model succeeds with an empty result; it does not confirm the new model's thought options.
                    this.receive({ models: { availableModels: option.options.map(({ id, label }) => ({ modelId: id, name: label })), currentModelId: wanted } }, true);
                }
            });
        }
        else {
            await request("session/set_config_option", { sessionId, configId: option?.configId ?? configId, value: wanted }, timeoutMs, (response) => this.receive(response));
        }
        selected = this.modelOf(this.input.state());
        if (!this.confirms(wanted)) {
            throw new Error(`${this.input.displayName} did not switch to ${wanted} (still ${selected ?? "unknown"})`);
        }
        return selected ?? wanted ?? null;
    }
}
/** The model this turn asks the live session for, before the setter runs: a legacy id the driver maps
 * onto the session's catalog, or the driver's fallback for a model the session no longer offers. */
export function pickSessionModel(support, input) {
    const { session, requested, catalog } = input;
    let { turn, variant, reportedModel } = input;
    const offered = offeredModels(session.sessionConfigResult, input.configId);
    const normalized = support.normalizeSessionSelection?.(turn, offered) ?? turn;
    if (normalized !== turn) {
        turn = normalized;
        variant = turn.variant;
    }
    const wanted = turn.model;
    const accountModels = support.sessionModelEnv && !session.launchModel && offered.length ? new Set(offered) : null;
    // A pooled process missing a catalog model predates the catalog: fail and respawn, never run another (the catalog holds picker ids; `wanted` may be the resolved wire id, so check both).
    const staleProcess = Boolean(support.fallbackModel && wanted && !input.launchedThisTurn && offered.length
        && !offered.includes(wanted) && catalog.options.some((option) => option.id === wanted || option.id === requested.model));
    let notice = null;
    let noticeText;
    // A local injected model is never swapped for the account's fallback.
    if (support.fallbackModel && offered.length && !decodeInjectId(requested.model)
        && !staleProcess && (!wanted || !offered.includes(wanted))) {
        const fallback = support.fallbackModel(session.sessionConfigResult, catalog.default);
        if (fallback && fallback !== wanted && offered.includes(fallback)) {
            const noticeKey = wanted ? `${wanted}\n${fallback}` : null;
            if (noticeKey && session.fallbackNotice !== noticeKey) {
                session.fallbackNotice = noticeKey;
                noticeText = { key: "chat.notice.acpModelFallback", params: { displayName: support.displayName, wanted: wanted, fallback } };
                notice = `${support.displayName} no longer offers ${wanted}, so this conversation uses ${fallback}. ` +
                    "Choose another model for this bot to stop seeing this.";
            }
            turn = { ...turn, model: fallback };
            reportedModel = fallback;
            variant = undefined;
        }
    }
    return { turn, variant, reportedModel, accountModels, staleProcess, notice, ...(noticeText ? { noticeText } : {}) };
}
