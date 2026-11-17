// A short message moved to the engine's quick model runs again on the bot's own model when the provider refuses the
// quick model (OpenAI answers 400 invalid_request_error for gpt-5.4-mini on a ChatGPT-account Codex). The retry keeps
// the first turn's id and the refusal never reaches the bus, so the conversation sees one turn with one reply. The
// refused model is kept per engine instance and never picked for a quick turn or background text there again.
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic.js";
const MODEL_REFUSED = /\b(?:400|404)\b|invalid_request_error|model_not_found|not supported|unsupported|not available|does not exist|may not exist|not have access|unknown model|invalid model|no such model|not found/i;
/** A model-unsupported or invalid-model answer that names `model`. */
export function refusesModel(message, model) {
    if (!message || !MODEL_REFUSED.test(message))
        return false;
    return [model, model.split("::").at(-1), model.split("/").at(-1)].some((name) => name && message.includes(name));
}
/** The retry's event under the shown turn's id; "dropped" for the retry's own turn.started; null for any other turn's event. */
export function retriedTurnEvent(turn, event) {
    if (!turn.turnId || !event.turnId || event.turnId === turn.turnId)
        return null;
    turn.retryTurnId ??= event.turnId;
    if (event.turnId !== turn.retryTurnId)
        return null;
    if (event.type === "turn.started")
        return "dropped";
    return { ...event, turnId: turn.turnId };
}
const NONE = new Set();
function load(file) {
    try {
        const rows = JSON.parse(readFileSync(file, "utf8"));
        if (!rows || typeof rows !== "object" || Array.isArray(rows))
            return new Map();
        return new Map(Object.entries(rows).flatMap(([instanceId, models]) => Array.isArray(models)
            ? [[instanceId, new Set(models.filter((model) => typeof model === "string"))]] : []));
    }
    catch {
        return new Map();
    }
}
export class QuickModelFallback {
    armed = new Map();
    refusedModels;
    deps;
    constructor(deps) {
        this.deps = deps;
        this.refusedModels = load(deps.file);
    }
    /** Quick models this engine instance refused. */
    refused(instanceId) {
        return this.refusedModels.get(instanceId) ?? NONE;
    }
    /** The quick model the thread's turn ran on, until that turn settles or runs again on the bot's own model. */
    routedModel(threadId) {
        const armed = this.armed.get(threadId);
        return armed && armed.phase !== "retrying" ? armed.quick.model : undefined;
    }
    sendTurn(engine, input, quick) {
        this.armed.delete(input.threadId);
        if (!quick)
            return engine.adapter.sendTurn(input);
        const armed = { engine, input, quick, phase: "quick", held: [] };
        this.armed.set(input.threadId, armed);
        return engine.adapter.sendTurn(input).then((sent) => {
            armed.turnId ??= sent.turnId;
            return sent;
        }, (error) => {
            if (this.armed.get(input.threadId) === armed)
                this.armed.delete(input.threadId);
            throw error;
        });
    }
    /** The bus's gate for adapter events: true when this took the event, to publish it changed, later or never. */
    take(event) {
        const armed = this.armed.get(event.threadId);
        if (!armed || !event.turnId)
            return false;
        if (armed.phase === "quick") {
            if (!armed.turnId && event.type === "turn.started")
                armed.turnId = event.turnId;
            if (event.turnId !== armed.turnId)
                return false;
            const refused = (event.type === "runtime.error" && refusesModel(event.message, armed.quick.model)) ||
                (event.type === "turn.completed" && !event.ok && refusesModel(event.stopReason, armed.quick.model));
            if (refused)
                armed.phase = "refused";
            else if (event.type === "turn.completed") {
                this.settle(armed, event);
                return true;
            }
            else
                return false;
        }
        if (armed.phase === "refused") {
            if (event.turnId !== armed.turnId)
                return false;
            armed.held.push(event);
            if (event.type === "turn.completed")
                this.retry(armed, event.stopReason === "interrupted");
            return true;
        }
        if (event.turnId === armed.turnId)
            return true;
        const kept = retriedTurnEvent(armed, event);
        if (kept === null)
            return false;
        if (kept === "dropped")
            return true;
        if (kept.type === "turn.completed")
            this.settle(armed, kept);
        else
            this.deps.publish(kept);
        return true;
    }
    /** Published before the turn is forgotten: the conversation reads routedModel() while it settles. */
    settle(armed, completed) {
        this.deps.publish(completed);
        if (this.armed.get(armed.input.threadId) === armed)
            this.armed.delete(armed.input.threadId);
    }
    giveUp(armed) {
        armed.phase = "refused";
        const completed = armed.held.pop();
        for (const event of armed.held)
            this.deps.publish(event);
        if (completed)
            this.settle(armed, completed);
    }
    retry(armed, interrupted) {
        const { threadId } = armed.input;
        if (interrupted || this.deps.stopped(threadId))
            return this.giveUp(armed);
        this.remember(armed.engine.instanceId, armed.quick.model);
        console.warn(`quick model ${armed.quick.model} refused on ${armed.engine.instanceId}: ${threadId} runs again on ${armed.quick.own.model}`);
        armed.phase = "retrying";
        try {
            armed.quick.onFallback();
        }
        catch (error) {
            console.warn(`quick model note left on ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
        }
        const { model, effort, variant } = armed.quick.own;
        // After the adapter that emitted the refusal has finished settling the quick turn.
        setImmediate(() => {
            if (this.armed.get(threadId) !== armed)
                return;
            armed.engine.adapter.sendTurn({ ...armed.input, model, effort, variant }).then((sent) => {
                armed.retryTurnId ??= sent.turnId;
                if (this.deps.stopped(threadId))
                    void armed.engine.adapter.interruptTurn(threadId).catch(() => { });
            }, (error) => {
                console.warn(`quick model retry on ${threadId} did not start: ${error instanceof Error ? error.message : String(error)}`);
                if (this.armed.get(threadId) === armed)
                    this.giveUp(armed);
            });
        });
    }
    remember(instanceId, model) {
        const models = this.refusedModels.get(instanceId) ?? new Set();
        if (models.has(model))
            return;
        models.add(model);
        this.refusedModels.set(instanceId, models);
        try {
            writeFileAtomic(this.deps.file, JSON.stringify(Object.fromEntries([...this.refusedModels].map(([id, refused]) => [id, [...refused]]))), { mode: 0o600 });
        }
        catch (error) {
            console.warn(`refused quick models not saved: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
