// The first-reply rescue, for every engine: a turn whose AI has sent nothing at all (no text, thinking, tool call
// or progress) some seconds after it started gets one notice in its chat, which the desktop draws with "Switch AI"
// and "Connect your subscription". The notice settles once the AI's first output arrives, and is over (history,
// no live buttons) once its turn ends without one. Silence later in a turn stays the engine's own business (the ACP
// quiet watch speaks at 60 s and 180 s).
import { firstReplyOverName, firstReplySettledName, firstReplyWaitingName } from "../shared/first-reply-rescue.js";
import { openRescueMessages } from "./message-db.js";
export const DEFAULT_FIRST_REPLY_NOTICE_MS = 20_000;
/** OMB_FIRST_REPLY_NOTICE_MS, else 20 s; 0 turns the rescue off. */
export function firstReplyNoticeMs(env = process.env) {
    const raw = env.OMB_FIRST_REPLY_NOTICE_MS?.trim();
    if (!raw)
        return DEFAULT_FIRST_REPLY_NOTICE_MS;
    const ms = Number(raw);
    return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_FIRST_REPLY_NOTICE_MS;
}
/** What the AI itself sends, live progress included: any of these means it has answered, however little. */
const AI_OUTPUT = new Set([
    "content.delta", "item.started", "item.updated", "item.completed", "request.opened", "turn.progress",
]);
export function createFirstReplyRescue(deps) {
    const watches = new Map();
    closeLeftOpen(deps);
    const pause = (watch) => {
        if (watch.timer)
            clearTimeout(watch.timer);
        watch.timer = null;
    };
    const arm = (threadId, watch) => {
        pause(watch);
        const ms = firstReplyNoticeMs();
        if (ms <= 0)
            return;
        watch.timer = setTimeout(() => {
            watch.timer = null;
            try {
                post(threadId, watch);
            }
            catch (error) {
                console.error(`first-reply rescue: could not post in ${threadId}:`, error instanceof Error ? error.message : error);
            }
        }, ms);
        watch.timer.unref?.();
    };
    const post = (threadId, watch) => {
        if (watch.phase !== "waiting" || watches.get(threadId) !== watch)
            return;
        watch.phase = "over";
        if (deps.quiet(threadId) || !deps.live(threadId, watch.turnId))
            return;
        const speaker = deps.speaker(threadId);
        const group = speaker ? deps.store.groupByThread(threadId) : undefined;
        const owner = speaker ? deps.store.bot(speaker.botId) : deps.store.botByThread(threadId);
        const bot = owner && !group ? deps.botForThread(owner.id, threadId) ?? owner : owner;
        if (!bot)
            return;
        const instanceId = deps.runningEngine(threadId) ?? bot.modelSelection.instanceId;
        const ai = deps.engineName(instanceId);
        const request = group ? undefined : deps.requests.get(threadId);
        const requestMessageId = request && !request.stopped && request.turnId === watch.turnId ? request.messageId : undefined;
        const rescue = {
            botId: bot.id, threadId, turnId: watch.turnId, ...(requestMessageId ? { requestMessageId } : {}), instanceId, ai,
            ...(group ? { groupId: group.id } : {}),
        };
        const name = firstReplyWaitingName(bot.name, ai);
        const row = deps.store.appendMessage(threadId, {
            role: "bot", kind: "activity", turnId: watch.turnId,
            ...(speaker && group ? { from: { botId: speaker.botId, name: speaker.name, color: speaker.color } } : {}),
            tool: { name, ok: true, rescue },
        });
        watch.row = { messageId: row.id, botName: bot.name, rescue };
        watch.phase = "posted";
    };
    /** The AI answered (`settled`) or the turn ended without an answer (`over`): either way the row asks nothing now. */
    const close = (threadId, watch, how) => {
        pause(watch);
        const posted = watch.phase === "posted" ? watch.row : null;
        watch.phase = "over";
        if (!posted)
            return;
        const rescue = { ...posted.rescue, [how]: true };
        const name = how === "settled" ? firstReplySettledName(rescue.ai) : firstReplyOverName(posted.botName, rescue.ai);
        try {
            deps.store.patchMessage(threadId, posted.messageId, { tool: { name, ok: true, rescue } });
        }
        catch (error) {
            console.error(`first-reply rescue: could not close the notice in ${threadId}:`, error instanceof Error ? error.message : error);
        }
    };
    return {
        onEvent(event) {
            const watch = watches.get(event.threadId);
            if (event.type === "turn.started") {
                // A relaunch of the same turn keeps its watch: one notice per turn.
                if (!event.turnId || watch?.turnId === event.turnId)
                    return;
                if (watch)
                    close(event.threadId, watch, "over");
                const next = { turnId: event.turnId, timer: null, phase: "waiting", row: null };
                watches.set(event.threadId, next);
                arm(event.threadId, next);
                return;
            }
            if (!watch || (event.turnId !== undefined && event.turnId !== watch.turnId))
                return;
            if (AI_OUTPUT.has(event.type)) {
                close(event.threadId, watch, "settled");
                return;
            }
            switch (event.type) {
                case "runtime.error":
                    // The error row says what went wrong; the notice is history beside it.
                    close(event.threadId, watch, "over");
                    return;
                case "turn.wait_started":
                    // Waiting for the computer is not the AI's silence.
                    pause(watch);
                    return;
                case "turn.wait_ended":
                    if (watch.phase === "waiting")
                        arm(event.threadId, watch);
                    return;
                case "turn.completed":
                    close(event.threadId, watch, "over");
                    watches.delete(event.threadId);
                    return;
                default:
                    return;
            }
        },
    };
}
/** At start no turn runs, so a notice still open belongs to a turn the restart ended: it is history, with no live
 * buttons, told in the past for the clients that print its words. */
function closeLeftOpen(deps) {
    let open;
    try {
        open = (deps.leftOpen ?? openRescueMessages)();
    }
    catch (error) {
        console.error("first-reply rescue: could not read the notices left open:", error instanceof Error ? error.message : error);
        return;
    }
    for (const { threadId, message } of open) {
        const tool = message.tool;
        if (!tool?.rescue)
            continue;
        const botName = deps.store.bot(tool.rescue.botId)?.name;
        const name = botName ? firstReplyOverName(botName, tool.rescue.ai) : tool.name;
        try {
            deps.store.patchMessage(threadId, message.id, { tool: { ...tool, name, rescue: { ...tool.rescue, over: true } } });
        }
        catch (error) {
            console.error(`first-reply rescue: could not close a notice in ${threadId}:`, error instanceof Error ? error.message : error);
        }
    }
}
