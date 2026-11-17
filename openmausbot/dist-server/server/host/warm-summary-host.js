import { isContextMessage } from "../delta-context.js";
import { sinceFreshStart } from "../fresh-start.js";
import { backgroundTextSlots } from "../job-slots.js";
import { wakeHoldOf } from "../routine-due.js";
import { serverLine } from "../server-lines.js";
import { createWarmSummary, WARM_SUMMARY_MIN_TOKENS, WARM_SUMMARY_RETRY_MS } from "../warm-summary.js";
/** Claude Code summarizes at the start of a turn once its context passes about 0.81 of its window (162k of 200k measured
 * on a Team trial): from 0.8 the next turn would summarize anyway, so the warm summary starts almost at once. */
export const NATIVE_SOON_FRACTION = 0.8;
/** Kept word for word after a summary: the person's last two messages and everything since. */
export const KEPT_EXCHANGES = 2;
/** OpenMausBot's fold runs while idle once a conversation is this close to where the next turn would fold it. */
export const HARNESS_IDLE_FRACTION = 0.85;
/** While the person has a conversation in front of them, its engine process is kept this long past their last activity. */
export const PRESENCE_HOLD_MS = 10 * 60_000;
/** What the summary must keep: questions still waiting and the person's own words for what is current. */
export function summaryInstructions(messages) {
    const open = messages.filter((m) => m.kind === "options" && m.card?.requestType === "question" && !m.card.answered &&
        !m.card.dismissed && !m.card.expired && !m.card.stopped)
        .map((m) => [m.card.title, m.card.subtitle].filter((part) => part?.trim()).join(": ").replace(/\s+/g, " ").trim().slice(0, 300))
        .filter(Boolean).slice(-5);
    return [
        "Keep the person's latest requests, corrections and decisions in their own words, and every question still waiting for an answer, theirs and yours.",
        "Say which work is finished and which is still open.",
        ...(open.length ? [`Questions waiting for the person: ${open.map((q) => `"${q}"`).join("; ")}.`] : []),
    ].join(" ");
}
/** The handed state after a summary: the session holds everything before the last `KEPT_EXCHANGES` exchanges (in summary),
 * and those count as not seen yet, so the next turn sends them word for word. `exchanges`: how many were kept. */
export function keptAfterSummary(messages, session, before) {
    const context = messages.filter(isContextMessage);
    const users = context.flatMap((m, index) => m.role === "user" ? [index] : []);
    const cut = users.length >= KEPT_EXCHANGES ? users[users.length - KEPT_EXCHANGES] : 0;
    const through = cut > 0 ? context[cut - 1].id : undefined;
    const state = {
        session,
        ...(before?.config !== undefined ? { config: before.config } : {}),
        ...(before?.effort !== undefined ? { effort: before.effort } : {}),
        ...(through !== undefined ? { through } : {}),
        ids: [],
    };
    return { state, exchanges: through === undefined ? users.length : KEPT_EXCHANGES };
}
export function createWarmSummaryHost(deps) {
    const { store } = deps;
    const now = deps.now ?? Date.now;
    const native = async (target, control) => {
        const { threadId, botId, instanceId } = target;
        const compact = deps.instance(instanceId)?.adapter.cacheKeepWarm?.compact;
        const session = store.taskByThread(botId, threadId)?.resumeCursors[instanceId];
        if (!compact || typeof session !== "string")
            return { ok: false, reason: "the conversation has no session to summarize" };
        const result = await compact(threadId, { instructions: summaryInstructions(sinceFreshStart(store.activePath(threadId))), session, signal: control.signal });
        if (!result.ok)
            return { ok: false, reason: result.reason, retry: result.busy === true && !control.signal.aborted };
        deps.book(target, result);
        // Applied only to the conversation as it was: on the same session, and with no turn begun since (but the one waiting).
        const task = store.taskByThread(botId, threadId);
        if (task?.resumeCursors[instanceId] !== result.sessionBefore)
            return { ok: false, reason: "the conversation moved to another session" };
        if (control.signal.aborted || (!control.awaited() && deps.busy(botId, threadId)))
            return { ok: false, reason: "a turn started while summarizing" };
        const { state, exchanges } = keptAfterSummary(sinceFreshStart(store.activePath(threadId)), result.session, task.handedMessages?.[instanceId]);
        store.setResumeCursor(botId, instanceId, result.session, threadId);
        store.setHandedMessages(botId, threadId, instanceId, state);
        store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: serverLine(deps.language?.(threadId), "server.warmSummary.summarized"), ok: true } });
        deps.log?.(`warm summary ${threadId}: moved to its summarized session, keeping ${exchanges} exchange(s) word for word`);
        return { ok: true };
    };
    const warm = createWarmSummary({
        now,
        timeScale: Number(process.env.OMB_WARM_SUMMARY_TIME_SCALE) || 1,
        after: deps.after ?? ((ms, fn) => { const timer = setTimeout(fn, ms); timer.unref?.(); return { cancel: () => clearTimeout(timer) }; }),
        plan: (target, contextTokens) => {
            if (!deps.enabled() || store.groupByThread(target.threadId) || !store.taskByThread(target.botId, target.threadId))
                return null;
            const instance = deps.instance(target.instanceId);
            if (!instance)
                return null;
            if (!instance.adapter.cacheKeepWarm?.compact)
                return { way: "harness", soon: false };
            const at = deps.nativeCompactAt(target.instanceId);
            if (at === undefined || contextTokens === undefined || contextTokens < Math.min(WARM_SUMMARY_MIN_TOKENS, at / 2))
                return null;
            return { way: "native", soon: contextTokens >= at * NATIVE_SOON_FRACTION };
        },
        hold: ({ botId, threadId }) => {
            if (deps.busy(botId, threadId))
                return { reason: "the bot is busy", retry: true };
            if (deps.memoryShort())
                return { reason: "memory is short", retry: true };
            if (deps.queued(botId, threadId))
                return { reason: "a message is waiting for this conversation", retry: false };
            if (deps.coordinator.activeDirect(threadId) || deps.coordinator.awaitingTeammateThreads().has(threadId)) {
                return { reason: "a teammate is working on this conversation's request", retry: false };
            }
            if (deps.waits()?.all().some((w) => w.botId === botId && w.threadId === threadId && w.followUp !== undefined && w.ending?.status === "fired")) {
                return { reason: "a wait has fired and will carry on here", retry: false };
            }
            const routines = deps.routines();
            if (routines && wakeHoldOf(routines.listRoutines().filter((r) => r.botId === botId), routines.listRuns().filter((r) => r.botId === botId), now(), WARM_SUMMARY_RETRY_MS).hold) {
                return { reason: "a routine of this bot is about to run", retry: true };
            }
            return null;
        },
        // Each summary is an engine process (a fork, or the one-shot summary call): a few at once across bots, and one a turn
        // now waits on starts at once. One that had to wait looks again: the cache may have gone cold, or a turn begun, meanwhile.
        run: (target, plan, control) => {
            let waited = false;
            return (deps.slots ?? backgroundTextSlots).run(async () => {
                const stale = waited && !control.awaited() ? control.stale() : null;
                if (stale)
                    return { ok: false, reason: `${stale.reason} (after waiting for a free slot)`, retry: stale.retry };
                if (plan.way === "native")
                    return native(target, control);
                return await deps.fold(target, control.signal) ? { ok: true } : { ok: false, reason: "the conversation does not need a summary yet" };
            }, { signal: control.signal, urgent: control.awaited, onWait: () => { waited = true; } });
        },
        log: deps.log,
    });
    return {
        ...warm,
        /** The person has the conversation in front of them (opened it, or is active in the app with it open). */
        sawThread(threadId) {
            warm.seen(threadId);
            const bot = store.botByThread(threadId);
            const instanceId = bot ? store.taskByThread(bot.id, threadId)?.lastInstanceId : undefined;
            const hold = instanceId ? deps.instance(instanceId)?.adapter.cacheKeepWarm?.hold : undefined;
            if (hold)
                hold(threadId, Math.max(now() + PRESENCE_HOLD_MS, deps.keepWarmUntil(threadId) ?? 0));
        },
    };
}
