export const takesFrame = (threadFrames, form) => form === undefined || (form === "thread") === threadFrames;
/** A change to one thread of a bot is sent as the bot with that thread alone (`tasksPartial`) to streams that asked for
 * it. Any other stream gets the whole bot, as before; with none open, the whole bot is not built at all. */
export function createBotFrames(deps) {
    let wholeSkippedAt = 0;
    return {
        send(bot, threadId, extra = {}) {
            if (threadId === undefined || !bot.tasks?.some((task) => task.threadId === threadId)) {
                deps.broadcast({ kind: "bot", bot: { ...deps.wire(bot), ...extra } });
                return;
            }
            deps.broadcast({ kind: "bot", bot: { ...deps.wire(bot, threadId), ...extra }, tasksPartial: true }, { frames: "thread" });
            if (deps.wholeListeners())
                deps.broadcast({ kind: "bot", bot: { ...deps.wire(bot), ...extra } }, { frames: "whole" });
            else
                wholeSkippedAt = deps.lastSeq();
        },
        /** A stream that takes only whole frames cannot resume across one that was never built: it loads everything again. */
        resumable: (since, threadFrames) => threadFrames || wholeSkippedAt <= since,
    };
}
