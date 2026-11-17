import { noticeFailure } from "../../chat-notices.js";
import { errorReplyFailure } from "../engine-errors.js";
/** A `tool_call` without a status is pending (ACP's default); a `tool_call_update` without one leaves the call as it was. */
export function trackRunningTool(current, update, defaultStatus) {
    if (typeof update.toolCallId !== "string" || !update.toolCallId)
        return;
    const status = update.status ?? defaultStatus;
    if (status === "completed" || status === "failed")
        current.runningTools.delete(update.toolCallId);
    else if (status === "pending" || status === "in_progress")
        current.runningTools.add(update.toolCallId);
}
/** How a settling turn ends, once its last text is out. A Stop the agent answers with end_turn (OpenCode does) is the
 * person's stop. A reply that is only a provider's error body fails the turn in plain words. Otherwise `end_turn` with
 * nothing to show is a lost turn: a provider may cut a reasoning-only stream and still answer end_turn. */
export function endTurn(current, ok, stopReason, ai) {
    const ended = ok && stopReason === null;
    const errorReply = ended && !current.state.stopped && !current.state.repliedText ? errorReplyFailure(ai, current.state.text) : null;
    if (!errorReply)
        current.flushAssistantText();
    if (ended && current.state.stopped)
        return { ok, stopReason: "cancelled" };
    if (errorReply) {
        const { stopReason: failed, ...error } = errorReply;
        return { ok: false, stopReason: failed, error };
    }
    if (ended && !current.state.producedItem)
        return { ok: false, stopReason: "empty_turn", error: noticeFailure("chat.notice.acpEmpty", { provider: ai }) };
    return { ok, stopReason };
}
