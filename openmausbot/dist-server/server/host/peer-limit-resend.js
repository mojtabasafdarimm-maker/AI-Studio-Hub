import { approvalModeFor } from "../../shared/approval-mode.js";
import { recoveryCapabilityError } from "../automatic-recovery.js";
import { limitBackupAllowed } from "../limit-failover.js";
import { turnLimitScope } from "../quota-switch.js";
/**
 * True when the failed turn left nothing behind: no tool call, no reply, no file. Its own failure row, the
 * engine's limit sentence (`stopError`, sometimes sent as reply text) and the hand-off's request card, written
 * just before the turn (sometimes in the same millisecond), do not count.
 */
export function nothingRan(rows, since, turnId, stopError) {
    const said = stopError?.trim();
    // The turn's digest is written after it ends and only sums it up.
    return !rows.some((row) => row.at >= since && row.role === "bot" && row.kind !== "digest" && row.roomRequest?.phase !== "request" && (!turnId || !row.turnId || row.turnId === turnId) && (row.kind === "activity" ? Boolean(row.tool?.itemId)
        : row.kind === "text" ? Boolean(row.text?.trim()) && row.text.trim() !== said
            : true));
}
/**
 * Resends a bot-to-bot turn once to the bot's backup AI when its own AI hit a usage limit before anything ran. The
 * resend keeps the turn's options as they were (sender, provenance, the hand-off it answers), so it never gains authority.
 */
export function createPeerLimitResend(deps) {
    const { store, registry } = deps;
    /** The thread's running bot-to-bot turn. */
    const running = new Map();
    /** Turns that met a limit before anything ran, until their resend is taken. */
    const claimed = new Map();
    /** A tracked turn's end that came before its dispatch named the turn, until the dispatch binds it. */
    const unbound = new Map();
    /** Generations whose thread settled before their turn's end was bound: the bind resends at once. */
    const settledEarly = new Set();
    /** At a turn's start: follows a relayed ask or a teammate's assignment, never the person's own, a routine's or a guest's. */
    function track(turn) {
        const { opts } = turn;
        if (opts.peerLimitResent || opts.computerSelectionContinuation || opts.goalRunId || opts.automationSource || opts.compactOnly
            || opts.coordination?.resumed || deps.guest(turn.threadId))
            return;
        if (opts.coordination ? !deps.handedOff(opts.coordination.id) : opts.cardContinuation || !(opts.peerAsk ?? turn.userMessage.peerAsk))
            return;
        running.set(turn.threadId, { ...turn, since: Date.now() });
        unbound.delete(turn.threadId);
    }
    /** At the turn's end, before its hand-off hears the outcome: keeps it for a resend only for a usage limit met before anything ran. */
    function ended(event, generation, capped) {
        const turn = running.get(event.threadId);
        if (turn?.generation !== generation)
            return;
        running.delete(event.threadId);
        unbound.delete(event.threadId);
        const settled = settledEarly.delete(generation);
        // Held only where the bot's own turn end resends it or reports the failure (never a room's thread).
        const stop = event.ok || capped || !store.botByThread(event.threadId) || !deps.quotaSwitchEnabled() ? undefined : deps.turnStops.read(event.threadId, event.turnId);
        const scope = stop && turnLimitScope(event, stop.flags, deps.turnStops.failureCause(event));
        if (!scope || scope === "signed-out" || !nothingRan(store.activePath(event.threadId), turn.since, event.turnId, stop?.error))
            return;
        claimed.set(event.threadId, { ...turn, scope, turnId: event.turnId, stopError: stop?.error });
        // The thread settled before the dispatch named this turn: resend now, once its hand-off has held the outcome.
        if (settled)
            setImmediate(() => resend(event.threadId));
    }
    /** A tracked thread's turn ended before its dispatch named the turn: kept until bound() gives its generation. */
    function endedUnbound(event, capped) {
        if (event.turnId && running.has(event.threadId))
            unbound.set(event.threadId, { event, capped });
    }
    /** The dispatch named the turn after it had already ended: judges that end as ended() would have. */
    function bound(threadId, turnId, generation) {
        const early = unbound.get(threadId);
        if (early?.event.turnId !== turnId)
            return;
        ended(early.event, generation, early.capped);
    }
    /** Keeps the failed attempt's outcome for its hand-off while the resend is pending; false when none is. */
    function hold(generation, outcome) {
        const turn = [...claimed.values()].find((candidate) => candidate.generation === generation);
        if (!turn)
            return false;
        turn.held ??= outcome;
        return true;
    }
    /** The claimed turn, once: whoever takes it resends it or settles its held outcome. */
    function take(threadId) {
        const turn = claimed.get(threadId);
        claimed.delete(threadId);
        return turn;
    }
    /** Once the turn has settled: resends a claimed turn on the backup AI; true when it will. Otherwise its hand-off hears the failure as before. */
    function resend(threadId, generation) {
        const turn = take(threadId);
        if (!turn) {
            // Settled before its end was bound to this generation: the bind resends instead.
            if (generation && running.get(threadId)?.generation === generation && unbound.has(threadId))
                settledEarly.add(generation);
            return false;
        }
        const giveUp = (detail) => {
            if (detail && store.taskByThread(turn.botId, threadId))
                store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: deps.failedLine(threadId, detail), ok: false } });
            if (turn.held)
                deps.settle(turn.generation, turn.held);
            return false;
        };
        if (deps.generation(threadId) !== turn.generation)
            return giveUp();
        setImmediate(() => {
            // Stop, deletion, a new send, or any replacement generation wins.
            const current = store.projectBotForTask(turn.botId, threadId);
            if (!current || deps.generation(threadId) !== turn.generation || deps.blocked(turn.botId, threadId)
                || (turn.latestUser && store.activePath(threadId).findLast(m => m.role === "user" && m.kind === "text")?.id !== turn.latestUser)
                // A file the turn made lands after its end was judged: anything it left by now still means no resend.
                || !nothingRan(store.activePath(threadId), turn.since, turn.turnId, turn.stopError))
                return giveUp();
            const from = current.modelSelection, instance = registry.get(from.instanceId);
            const backup = deps.takeover().backups(turn.botId, from, turn.scope, approvalModeFor(current)).find(candidate => {
                const target = registry.get(candidate.instanceId);
                return target?.enabled && (candidate.instanceId !== from.instanceId || candidate.model !== from.model)
                    && (candidate.instanceId === from.instanceId ? turn.scope !== "engine" : !instance || limitBackupAllowed(instance, target, deps.providerConfigs()[candidate.instanceId]));
            });
            if (!backup)
                return giveUp();
            const checked = deps.checkedTaskModelSwitch(current, backup, false, false, true);
            const target = checked.ok ? registry.get(checked.selection.instanceId) : null;
            const refusal = !checked.ok ? checked.error : !target || !target.enabled ? "The backup AI is unavailable."
                : !store.taskByThread(turn.botId, threadId)?.cwd ? "This older thread has no pinned working folder. Choose its backup manually."
                    : deps.policyModelRefusal(target) ?? (instance ? recoveryCapabilityError({ driverKind: instance.driverKind, capabilities: instance.adapter.capabilities }, { driverKind: target.driverKind, capabilities: target.adapter.capabilities }) : undefined);
            if (refusal || !checked.ok)
                return giveUp(refusal);
            try {
                deps.assertWithinBudget();
                store.switchTaskModel(turn.botId, threadId, checked.selection, false, false, { ...deps.hostedModels?.resetTask(from, checked.selection), rewound: true });
            }
            catch (error) {
                return giveUp(error instanceof Error ? error.message : String(error));
            }
            for (const tool of deps.takeover().carriedOn(current, threadId, from, checked.selection, { scope: turn.scope }))
                store.appendMessage(threadId, { role: "bot", kind: "activity", tool });
            deps.release(turn.generation);
            void deps.startTurn(turn.botId, turn.text, { ...turn.opts, threadId, userMessage: turn.userMessage, editedMessageId: undefined, peerLimitResent: true }).catch(error => {
                const detail = error instanceof Error ? error.message : String(error), why = `Could not resend this to the backup AI: ${detail}`;
                (turn.opts.coordination?.settle ?? turn.opts.onSettled)?.({ ok: false, text: turn.held ? `${turn.held.text} ${why}` : why });
                if (store.taskByThread(turn.botId, threadId))
                    store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: deps.failedLine(threadId, detail), ok: false } });
            });
        });
        return true;
    }
    return { track, ended, endedUnbound, bound, hold, resend };
}
