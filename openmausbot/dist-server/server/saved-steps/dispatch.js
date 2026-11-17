import { allowsTool } from "../../shared/tool-scope.js";
import { newId } from "../contracts.js";
import { createChatToolApproval } from "../drivers/chat-tool-approval.js";
import { retriedTurnEvent } from "../quick-model-fallback.js";
import { requestKey } from "./key.js";
import { declinedReply, fallbackNote, replayedReply, runSteps } from "./replay.js";
import { personTextRequest, recipeFitsRequest, stepLabel } from "./rules.js";
const STOPPED = { kind: "stopped" };
const LOOKUPS = ["list_apps", "list_windows", "get_window_state"];
const COMPUTER_SERVER = "computer";
const REMEMBERED_REPLIES = 256;
const errorText = (error) => (error instanceof Error ? error.message : String(error));
export class SavedStepsDispatch {
    deps;
    runs = new Map();
    answered = new Map();
    unmarked = new Set();
    replayable = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    sendTurn(engine, request, input, start) {
        this.runs.delete(input.threadId);
        this.replayable.delete(input.threadId);
        if (request && this.replayHolds(request, input)) {
            this.replayable.set(input.threadId, { toolScope: input.toolScope });
            while (this.replayable.size > REMEMBERED_REPLIES)
                this.replayable.delete(this.replayable.keys().next().value);
        }
        if (request && request.turnText !== request.message.text) {
            if (!this.deps.taint(input.threadId))
                this.unmarked.add(input.threadId);
            return start(input);
        }
        const computer = input.integrations?.localComputer;
        const recipe = request && computer ? this.recipeFor(request, input) : undefined;
        if (!request || !computer || !recipe || !this.deps.taint(input.threadId))
            return start(input);
        const { threadId } = input;
        const run = {
            turnId: newId(), threadId, botId: request.botId, recipe, engine, controller: new AbortController(), phase: "replay", finished: Promise.resolve(),
            handOn: this.deps.withholdHandoff(threadId),
        };
        const asked = new Set();
        const approval = createChatToolApproval({
            signal: run.controller.signal,
            open: (ask) => {
                asked.add(ask.id);
                this.emit(run, {
                    type: "request.opened", requestType: "permission", requestId: ask.id, tool: ask.tool, summary: ask.summary,
                    approvalScope: "local-computer", allowSession: false,
                });
            },
            resolved: (ask, allowed, source) => this.emit(run, {
                type: "request.resolved", requestId: ask.id, behavior: allowed ? "allow" : "deny", source, approvalScope: "local-computer",
            }),
            openQuestion: () => { },
            resolvedQuestion: () => { },
        });
        this.runs.set(threadId, run);
        this.deps.engines.set(threadId, this.standIn(run, approval, asked));
        // After dispatch binds this turn id to the request, so no event of the replay comes before its turn is known.
        run.finished = new Promise((resolve) => {
            setImmediate(() => {
                this.replay(run, computer, input, start, approval).then(resolve, (error) => {
                    console.warn(`saved steps on ${threadId} ended early: ${errorText(error)}`);
                    run.controller.abort();
                    if (this.runs.get(threadId) === run && run.phase === "replay")
                        this.end(run, { kind: "error", message: errorText(error) });
                    resolve();
                });
            });
        });
        return Promise.resolve({ turnId: run.turnId });
    }
    /** The bus's gate for adapter events: true when this took the AI's event for a replay it handed over. */
    take(event) {
        const run = this.runs.get(event.threadId);
        if (!run || run.phase !== "fallback")
            return false;
        const kept = retriedTurnEvent(run, event);
        if (kept === null)
            return false;
        if (kept === "dropped")
            return true;
        if (kept.type === "turn.completed")
            this.forgetRun(run);
        this.deps.publish(kept);
        return true;
    }
    /** True when a turn of the thread's ending request sent more than its line and could not be marked; it must not save. Taking it forgets it. */
    takeUnmarked(threadId) {
        return this.unmarked.delete(threadId);
    }
    /** Whether the thread's latest turn met every condition for replaying this recipe, so "next time no AI" would hold. */
    wouldReplay(threadId, recipe) {
        const turn = this.replayable.get(threadId);
        return turn !== undefined && toolsAllowed(recipe, turn.toolScope);
    }
    /** True for the events of a replay still answering without the AI, its turn.completed included. */
    answering(event) {
        const run = this.runs.get(event.threadId);
        return run !== undefined && run.phase === "replay" && event.turnId === run.turnId;
    }
    /** The recipe that answered this turn with no AI. */
    replayed(threadId, turnId) {
        const answer = this.answered.get(threadId);
        return answer?.turnId === turnId ? answer.recipeId : undefined;
    }
    replayHolds(request, input) {
        return this.deps.enabled() && input.approvalMode === "full" && input.integrations?.localComputer?.scope === "local-computer"
            && request.placePicked && personTextRequest(request.message) && request.turnText === request.message.text;
    }
    recipeFor(request, input) {
        if (!this.replayHolds(request, input))
            return undefined;
        const text = request.turnText;
        const recipe = this.deps.recipes.find(request.botId, requestKey(text));
        return recipe && recipeFitsRequest(recipe, text) && toolsAllowed(recipe, input.toolScope) ? recipe : undefined;
    }
    standIn(run, approval, asked) {
        const { adapter } = run.engine;
        const standIn = {
            get provider() { return adapter.provider; },
            get capabilities() { return adapter.capabilities; },
            get cacheKeepWarm() { return adapter.cacheKeepWarm; },
            sendTurn: (input) => adapter.sendTurn(input),
            async interruptTurn(threadId, turnId) {
                if (run.phase === "fallback")
                    return adapter.interruptTurn(threadId, turnId);
                run.controller.abort();
                await run.finished;
            },
            respondToRequest: async (threadId, requestId, decision) => (asked.has(requestId)
                ? approval.answer(requestId, decision.behavior, decision.message)
                : adapter.respondToRequest(threadId, requestId, decision)),
            steer: async () => "refused",
            hasSession: (threadId) => adapter.hasSession(threadId),
            stopAll: () => adapter.stopAll(),
            onEvent: (listener) => adapter.onEvent(listener),
        };
        return Object.create(run.engine, { adapter: { value: standIn } });
    }
    async replay(run, computer, input, start, approval) {
        this.emit(run, { type: "turn.started" });
        const outcome = await this.runSteps(run, computer, approval);
        approval.close();
        if (outcome.kind === "failed")
            return this.fallBack(run, outcome, input, start);
        if (outcome.kind === "error")
            this.forget(run);
        this.end(run, outcome);
    }
    async runSteps(run, computer, approval) {
        const { signal } = run.controller;
        if (signal.aborted)
            return STOPPED;
        let caller;
        try {
            caller = await this.deps.openCaller(computer, signal);
        }
        catch (error) {
            if (signal.aborted)
                return STOPPED;
            const [first] = run.recipe.steps;
            return { kind: "failed", done: 0, total: run.recipe.steps.length, tool: first.tool, label: stepLabel(first), error: errorText(error) };
        }
        try {
            return await runSteps(run.recipe, this.turn(run), { caller, approval, publish: this.deps.publish, signal });
        }
        catch (error) {
            return signal.aborted ? STOPPED : { kind: "error", message: errorText(error) };
        }
        finally {
            await caller.close().catch(() => { });
        }
    }
    async fallBack(run, failed, input, start) {
        if (!failed.gate)
            this.forget(run);
        if (run.controller.signal.aborted || this.deps.stopped(run.threadId))
            return this.end(run, STOPPED);
        this.deps.engines.set(run.threadId, run.engine);
        const note = fallbackNote(failed);
        const noted = (text) => `${text}\n\n${note}`;
        const handed = { ...input, text: noted(input.text), ...(input.recoveryText !== undefined ? { recoveryText: noted(input.recoveryText) } : {}) };
        run.phase = "fallback";
        run.handOn(run.turnId);
        let sent;
        try {
            sent = await start(handed);
        }
        catch (error) {
            if (this.runs.get(run.threadId) === run)
                this.end(run, { kind: "error", message: errorText(error) });
            return;
        }
        run.retryTurnId ??= sent.turnId;
        if (this.deps.stopped(run.threadId))
            void run.engine.adapter.interruptTurn(run.threadId).catch(() => { });
    }
    end(run, outcome) {
        try {
            if (run.phase === "replay")
                this.markContextChanged(run);
            if (outcome.kind === "done") {
                this.answered.delete(run.threadId);
                this.answered.set(run.threadId, { turnId: run.turnId, recipeId: run.recipe.id });
                while (this.answered.size > REMEMBERED_REPLIES)
                    this.answered.delete(this.answered.keys().next().value);
                this.reply(run, replayedReply(run.recipe));
                this.emit(run, { type: "turn.completed", ok: true, stopReason: "end_turn" });
            }
            else if (outcome.kind === "declined") {
                this.reply(run, declinedReply(outcome));
                this.emit(run, { type: "turn.completed", ok: true, stopReason: "end_turn", denials: [`mcp__computer__${outcome.tool}`] });
            }
            else if (outcome.kind === "stopped") {
                this.emit(run, { type: "turn.completed", ok: false, stopReason: "interrupted" });
            }
            else {
                this.emit(run, { type: "runtime.error", message: outcome.message });
                this.emit(run, { type: "turn.completed", ok: false, stopReason: outcome.message });
            }
        }
        finally {
            this.forgetRun(run);
        }
    }
    markContextChanged(run) {
        try {
            this.deps.contextChanged(run.botId, run.threadId);
        }
        catch (error) {
            console.warn(`saved steps on ${run.threadId}: the conversation was not marked for the engine to read again: ${errorText(error)}`);
        }
    }
    forget(run) {
        try {
            this.deps.recipes.forget(run.botId, run.recipe.id);
        }
        catch (error) {
            console.warn(`saved steps ${run.recipe.id} for ${run.botId} not forgotten: ${errorText(error)}`);
        }
    }
    forgetRun(run) {
        if (this.runs.get(run.threadId) === run)
            this.runs.delete(run.threadId);
    }
    reply(run, text) {
        this.emit(run, { type: "item.completed", itemType: "assistant_text", itemId: newId(), text });
    }
    turn(run) {
        return { threadId: run.threadId, turnId: run.turnId, provider: run.engine.driverKind, providerInstanceId: run.engine.instanceId };
    }
    emit(run, event) {
        this.deps.publish({ eventId: newId(), createdAt: new Date().toISOString(), ...this.turn(run), ...event });
    }
}
function toolsAllowed(recipe, toolScope) {
    return [...LOOKUPS, ...recipe.steps.map((step) => step.tool)].every((name) => allowsTool(toolScope, { kind: "mcp", server: COMPUTER_SERVER, name }));
}
