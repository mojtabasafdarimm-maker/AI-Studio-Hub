// Never holds anything said on a call beyond the requests the bot already received.
// steer-queue.ts imports this at runtime, so it stays light: store and title machinery arrive as injected deps.
import { liveCallRowText } from "../shared/live-call.js";
export function spokenLineFields(via, callId) {
    if (via !== "call")
        return {};
    return callId ? { via, callId } : { via };
}
export function recordLiveCall(deps, input) {
    const { threadId, botName, record } = input;
    if (!deps.chatExists(record.botId, threadId))
        return null;
    return deps.appendMessage(threadId, {
        role: "bot",
        kind: "call",
        text: liveCallRowText(botName, record.seconds),
        call: record,
    });
}
/** `store.patchMessage` does not scrub what the engine wrote, so the title is scrubbed here too. */
export async function titleLiveCall(deps, input) {
    const record = input.row.call;
    if (!record || record.endReason === "shutdown")
        return;
    try {
        const excerpt = deps.excerpt(deps.messagesFor(input.threadId), record.callId);
        if (!excerpt)
            return;
        const title = await deps.title(record.botId, input.threadId, excerpt);
        if (!title)
            return;
        const current = deps.messagesFor(input.threadId).find((message) => message.id === input.row.id);
        if (!current?.call)
            return;
        deps.patchMessage(input.threadId, input.row.id, { call: { ...current.call, title: deps.scrub(title) } });
    }
    catch {
    }
}
