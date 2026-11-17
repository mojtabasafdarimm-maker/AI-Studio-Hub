import { harnessCapabilityLines } from "./harness-capabilities.js";
import { newId } from "./contracts.js";
import { UNDO_STALE } from "./direct-apply.js";
import { redactSecretsInText } from "./redact.js";
const MAX_REASON = 500;
const STALE = "This bot's default model changed after this card was prepared. Ask the bot to review it and propose again.";
const NO_SUCH_BOT = "That bot no longer exists";
export class ModelRequestError extends Error {
    status;
    constructor(message, status = 400) {
        super(message);
        this.name = "ModelRequestError";
        this.status = status;
    }
}
const sameSelection = (a, b) => a.instanceId === b.instanceId && a.model === b.model && a.effort === b.effort && a.variant === b.variant;
function reasonText(value) {
    if (typeof value !== "string")
        throw new ModelRequestError("reason is required");
    const trimmed = value.trim();
    if (!trimmed)
        throw new ModelRequestError("reason is required");
    if (trimmed.length > MAX_REASON)
        throw new ModelRequestError("reason must be 500 characters or fewer");
    return redactSecretsInText(trimmed);
}
function parseSelection(input) {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new ModelRequestError("model_selection must be an object with instanceId and model");
    }
    const value = input;
    if (typeof value.instanceId !== "string" || !value.instanceId.trim()) {
        throw new ModelRequestError("model_selection.instanceId is required");
    }
    if (typeof value.model !== "string" || !value.model.trim()) {
        throw new ModelRequestError("model_selection.model is required");
    }
    const selection = { instanceId: value.instanceId.trim(), model: value.model.trim() };
    if (value.effort !== undefined) {
        if (typeof value.effort !== "string" || !value.effort.trim())
            throw new ModelRequestError("model_selection.effort must be a level name");
        selection.effort = value.effort;
    }
    if (value.variant !== undefined) {
        if (typeof value.variant !== "string" || !value.variant.trim())
            throw new ModelRequestError("model_selection.variant must be a variant id");
        selection.variant = value.variant;
    }
    return selection;
}
export function modelCardCopy(args) {
    const title = args.crossBot
        ? "Change @" + args.targetName + "'s default AI and model?"
        : "Change " + args.targetName + "'s default AI and model?";
    const lines = args.crossBot
        ? ["Whose default model: @" + args.targetName, "Why: " + args.reason]
        : ["Why: " + args.reason];
    lines.push("Default AI and model: " + JSON.stringify(args.before) + " → " + JSON.stringify(args.selection));
    lines.push(...args.capabilityLines);
    lines.push("Default models apply to groups and new threads. Every existing thread keeps its current model and permissions.");
    lines.push("Nothing runs.");
    return { title, summary: title + " · default AI and model", detail: lines.join("\n") };
}
export class ModelRequestService {
    store;
    now;
    canPersist;
    autoApply;
    validateTarget;
    validateModel;
    driverCapabilities;
    constructor(options) {
        this.store = options.store;
        this.now = options.now ?? Date.now;
        this.canPersist = options.canPersist;
        this.autoApply = options.autoApply;
        this.validateTarget = options.validateTarget;
        this.validateModel = options.validateModel;
        this.driverCapabilities = options.driverCapabilities;
    }
    propose(args) {
        return this.prepare(args);
    }
    submit(args) {
        const proposal = this.prepare(args, true);
        return { ...proposal, state: proposal.result ? "applied" : "pending" };
    }
    prepare(args, submitted = false) {
        const reason = reasonText(args.reason);
        const selection = parseSelection(args.selection);
        const targetBotId = args.targetBotId?.trim() || args.botId;
        const target = this.store.bot(targetBotId);
        if (!target)
            throw new ModelRequestError(NO_SUCH_BOT, 404);
        const crossBot = targetBotId !== args.botId;
        if (crossBot && this.validateTarget) {
            const refusal = this.validateTarget(args.botId, targetBotId);
            if (refusal)
                throw new ModelRequestError(refusal, 403);
        }
        if (sameSelection(selection, target.modelSelection))
            throw new ModelRequestError("Nothing would change");
        if (this.validateModel) {
            const refusal = this.validateModel(selection, target);
            if (refusal)
                throw new ModelRequestError(refusal, 400);
        }
        const requestId = newId();
        const targetName = redactSecretsInText(target.name);
        const before = structuredClone(target.modelSelection);
        const capabilityLines = this.driverCapabilities
            ? harnessCapabilityLines(this.driverCapabilities(before.instanceId), this.driverCapabilities(selection.instanceId))
            : [];
        const payload = {
            version: 1,
            requestId,
            botId: args.botId,
            threadId: args.threadId,
            targetBotId,
            targetName,
            createdAt: this.now(),
            reason,
            selection,
            before,
        };
        const copy = modelCardCopy({ targetName, crossBot, before, selection, reason, capabilityLines });
        const grant = submitted ? this.autoApply?.(args.botId, args.threadId, targetBotId) ?? null : null;
        const automatic = grant !== null;
        const persistence = this.canPersist?.(args.botId, args.threadId, !automatic);
        if (persistence && !persistence.ok)
            throw new ModelRequestError(persistence.error, persistence.status);
        const messageInput = {
            role: "bot",
            kind: "options",
            card: {
                title: copy.title,
                subtitle: copy.detail,
                options: automatic ? [] : ["Confirm", "Cancel"],
                ...(automatic ? { dismissed: true } : {}),
                requestId,
                tool: "update_model",
                modelRequest: payload,
            },
        };
        if (args.from)
            messageInput.from = args.from;
        const message = this.store.appendMessage(args.threadId, messageInput);
        const proposal = { requestId, messageId: message.id, title: copy.title, summary: copy.summary, detail: copy.detail };
        if (!automatic)
            return proposal;
        const result = this.resolve({ botId: args.botId, threadId: args.threadId, requestId, behavior: "allow" });
        if (result.state === "applied") {
            if (!result.settlementPending)
                this.recordAutoApplied(args.threadId, message.id);
            return { ...proposal, result, appliedBy: grant };
        }
        throw new ModelRequestError(result.state === "invalid" ? result.error : "The model change could not be applied", result.state === "invalid" ? result.status : 409);
    }
    recordAutoApplied(threadId, messageId) {
        try {
            const card = this.store.messagesFor(threadId).find((candidate) => candidate.id === messageId)?.card;
            if (card?.modelRequest)
                this.store.patchMessage(threadId, messageId, { card: { ...card, autoApplied: true } });
        }
        catch {
        }
    }
    undo(args) {
        const message = this.store
            .messagesFor(args.threadId)
            .find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.modelRequest);
        const card = message?.card;
        const payload = card?.modelRequest;
        if (!message || !card || !payload)
            return { claimed: false };
        if (card.undone)
            return { claimed: true, state: "already_undone" };
        const cannot = (error, status = 409) => ({ claimed: true, state: "invalid", error, status });
        if (!card.autoApplied || card.answered !== "allow")
            return cannot("Only a change that applied on its own can be undone here.");
        if (payload.botId !== args.botId || payload.threadId !== args.threadId) {
            return cannot("This model change belongs to another conversation", 403);
        }
        const target = this.store.bot(payload.targetBotId);
        if (!target || !sameSelection(target.modelSelection, payload.selection)) {
            return { claimed: true, state: "invalid", error: UNDO_STALE, status: 409, stale: true };
        }
        if (this.validateModel) {
            const refusal = this.validateModel(payload.before, target);
            if (refusal)
                return cannot(refusal);
        }
        if (!this.store.applyModelDefault(target.id, payload.before))
            return cannot(NO_SUCH_BOT, 404);
        this.store.patchMessage(args.threadId, message.id, { card: { ...card, undone: true } });
        return { claimed: true, state: "undone", targetBotId: target.id };
    }
    resolve(args) {
        const message = this.store
            .messagesFor(args.threadId)
            .find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.modelRequest);
        const card = message?.card;
        const payload = card?.modelRequest;
        if (!message || !card || !payload)
            return { claimed: false, state: "not_found" };
        if (payload.requestId !== card.requestId) {
            return { claimed: true, state: "invalid", error: "This model request does not match its card", status: 409 };
        }
        if (args.behavior !== "allow" && args.behavior !== "deny") {
            return { claimed: true, state: "invalid", error: "Model confirmations must be confirmed or cancelled", status: 400 };
        }
        if (payload.botId !== args.botId || payload.threadId !== args.threadId) {
            return { claimed: true, state: "invalid", error: "This model request belongs to another conversation", status: 403 };
        }
        if (card.answered)
            return { claimed: true, state: "already_settled", behavior: card.answered };
        // Re-check authority before any settle path, outside the try, so the recovery catch cannot recast a refusal as applied.
        if (args.behavior === "allow" && payload.targetBotId !== payload.botId && this.validateTarget) {
            const refusal = this.validateTarget(payload.botId, payload.targetBotId);
            if (refusal)
                return { claimed: true, state: "invalid", error: refusal, status: 404 };
        }
        try {
            const target = this.store.bot(payload.targetBotId);
            if (!target)
                throw new ModelRequestError(NO_SUCH_BOT, 404);
            if (args.behavior === "deny") {
                this.store.patchMessage(args.threadId, message.id, { card: { ...card, answered: "deny", held: undefined } });
                return { claimed: true, state: "denied" };
            }
            if (sameSelection(payload.selection, target.modelSelection)) {
                const settled = this.store.patchMessage(args.threadId, message.id, {
                    card: { ...card, answered: "allow", held: undefined, modelRequest: { ...payload, appliedAt: payload.appliedAt ?? this.now() } },
                });
                if (!settled)
                    throw new ModelRequestError("This model confirmation card is no longer available", 409);
                return { claimed: true, state: "already_settled", behavior: "allow" };
            }
            if (!sameSelection(payload.before, target.modelSelection)) {
                throw new ModelRequestError(STALE, 409);
            }
            if (this.validateModel) {
                const refusal = this.validateModel(payload.selection, target);
                if (refusal)
                    throw new ModelRequestError(refusal, 409);
            }
            if (!this.store.applyModelDefault(target.id, payload.selection))
                throw new ModelRequestError(NO_SUCH_BOT, 404);
            const appliedAt = this.now();
            const settled = this.store.patchMessage(args.threadId, message.id, {
                card: { ...card, answered: "allow", held: undefined, modelRequest: { ...payload, appliedAt } },
            });
            if (!settled)
                throw new ModelRequestError("This model confirmation card is no longer available", 409);
            return { claimed: true, state: "applied", targetBotId: target.id };
        }
        catch (error) {
            const status = error instanceof ModelRequestError ? error.status : 400;
            const detail = error instanceof Error ? error.message : String(error);
            const applied = sameSelection(payload.selection, this.store.bot(payload.targetBotId)?.modelSelection ?? payload.before);
            const notice = card.dismissed && card.options.length === 0
                ? "Default model saved. Recording the operation receipt could not finish; the change will not be applied again."
                : "Default model saved. Confirm again to finish recording this decision; the change will not be applied again.";
            try {
                this.store.patchMessage(args.threadId, message.id, {
                    card: { ...card, held: applied ? notice : redactSecretsInText(detail).slice(0, 500) },
                });
            }
            catch { }
            if (applied)
                return {
                    claimed: true, state: "applied", targetBotId: payload.targetBotId,
                    settlementPending: true, message: notice,
                };
            return { claimed: true, state: "invalid", error: detail, status };
        }
    }
}
