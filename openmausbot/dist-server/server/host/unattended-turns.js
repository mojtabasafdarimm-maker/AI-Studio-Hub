import { chatNotice, failedNoticeTool } from "../chat-notices.js";
import { createLoopGuard } from "./loop-guard.js";
export const UNATTENDED_DEFAULTS = { maxMs: 4 * 60 * 60_000, maxRequests: 400, maxDenials: 5 };
const MIN_MS = 60_000;
const SWEEP_MS = 30_000;
function limit(raw, fallback, least) {
    const text = raw?.trim().toLowerCase();
    if (text === "off")
        return Number.POSITIVE_INFINITY;
    const value = Number(text || NaN);
    return Number.isSafeInteger(value) && value >= least ? value : fallback;
}
/** OMB_UNATTENDED_TURN_MAX_MS (from 60000), OMB_UNATTENDED_TURN_MAX_REQUESTS and OMB_UNATTENDED_TURN_MAX_DENIALS (from 1):
 * whole numbers, or `off` for no limit; anything else leaves the default. */
export function unattendedLimits(env = process.env) {
    return {
        maxMs: limit(env.OMB_UNATTENDED_TURN_MAX_MS, UNATTENDED_DEFAULTS.maxMs, MIN_MS),
        maxRequests: limit(env.OMB_UNATTENDED_TURN_MAX_REQUESTS, UNATTENDED_DEFAULTS.maxRequests, 1),
        maxDenials: limit(env.OMB_UNATTENDED_TURN_MAX_DENIALS, UNATTENDED_DEFAULTS.maxDenials, 1),
    };
}
/** A turn a person's own message started, or a continuation of one (a memory retry, a card's answer): attended, whatever
 * routine run or wait is also open in that chat. */
export const personDriven = (request) => request?.personLine === true || request?.origin?.kind === "user";
const fresh = (turnId) => ({ turnId, workedMs: 0, calls: new Set(), unnamedCalls: 0, inStep: false, tools: 0, denials: 0, stopped: false });
function over(turn, limits) {
    if (turn.denials >= limits.maxDenials)
        return { key: "chat.notice.unattendedDenied", params: { count: turn.denials } };
    const requests = Math.max(turn.calls.size + turn.unnamedCalls, turn.tools);
    if (requests >= limits.maxRequests)
        return { key: "chat.notice.unattendedRequests", params: { count: limits.maxRequests } };
    if (turn.workedMs >= limits.maxMs)
        return { key: "chat.notice.unattendedTooLong", params: { minutes: Math.round(limits.maxMs / 60_000) } };
    return undefined;
}
export function createUnattendedTurns(deps) {
    const now = deps.now ?? Date.now;
    const limits = deps.limits ?? (() => unattendedLimits());
    const loops = createLoopGuard({ ...deps, settings: (threadId) => deps.settings(deps.unattended(threadId)) });
    const turns = new Map();
    let sweptAt = now();
    const stop = (threadId, turn, text) => {
        turn.stopped = true;
        const cause = chatNotice(text.key, text.params);
        let stopping;
        try {
            stopping = Promise.resolve(deps.interrupt(threadId, cause));
        }
        catch {
            return;
        }
        (deps.log ?? console.info)(`[unattended-turn] stopped: thread=${threadId} ${text.key}`);
        deps.append(threadId, failedNoticeTool(text.key, text.params));
        void stopping.catch(() => { });
    };
    const check = (threadId, turn) => {
        if (turn.stopped || !deps.live(threadId) || deps.waiting(threadId) || !deps.unattended(threadId))
            return;
        const text = over(turn, limits());
        if (text)
            stop(threadId, turn, text);
    };
    const sweep = () => {
        const at = now(), passed = Math.max(0, at - sweptAt);
        sweptAt = at;
        for (const [threadId, turn] of turns) {
            if (!deps.live(threadId)) {
                turns.delete(threadId);
                continue;
            }
            if (deps.waiting(threadId))
                continue;
            turn.workedMs += passed;
            check(threadId, turn);
        }
    };
    const timer = deps.timer === false ? undefined : setInterval(sweep, SWEEP_MS);
    timer?.unref?.();
    const onEvent = (event) => {
        loops.onEvent(event);
        const { threadId } = event;
        if (event.type === "turn.completed" || event.type === "session.exited")
            return void turns.delete(threadId);
        if (event.type === "turn.started")
            return void turns.set(threadId, fresh(event.turnId));
        let turn = turns.get(threadId);
        if (!turn || (event.turnId !== undefined && turn.turnId !== undefined && turn.turnId !== event.turnId))
            turns.set(threadId, (turn = fresh(event.turnId)));
        if (event.type === "thread.token-usage.updated") {
            if (event.itemId !== undefined)
                turn.calls.add(event.itemId);
            else if (!turn.inStep) {
                turn.unnamedCalls += 1;
                turn.inStep = true;
            }
        }
        else if (event.type === "item.started" && event.itemType === "tool") {
            turn.tools += 1;
            turn.inStep = false;
        }
        else if (event.type === "request.resolved" && event.behavior === "deny" && event.source !== "system" && event.source !== "user")
            turn.denials += 1;
        else
            return;
        check(threadId, turn);
    };
    return {
        onEvent, sweep,
        settle: (threadId) => { loops.settle(threadId); turns.delete(threadId); },
        close: () => { if (timer)
            clearInterval(timer); },
    };
}
