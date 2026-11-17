import { DEFAULT_OUTBOUND_POLICY } from "../shared/outbound.js";
import { HELD_NOTE } from "./auto-approve.js";
import { appendDecision } from "./decision-log.js";
import { buildNotification } from "./notify.js";
import { outboundCard } from "./outbound-requests.js";
import { turnWaitedOnPerson } from "./waiting-on-person.js";
/** How long a "Send on your behalf?" card waits on the person before it times out. */
export const OUTBOUND_HOLD_MS = 9 * 60_000;
/** The rule a send goes out under without the card, or null when it waits on the card. At Full access a bot with no
 * sending rule of its own sends without asking; a stored rule is kept exactly as set. */
function sendsWithoutAsking(rule, fullAccess, opaque) {
    if (fullAccess && rule === undefined)
        return "full-access";
    // A call it cannot inspect (code run) goes out under "allow" only at Full access, as it would with no rule.
    return (rule ?? DEFAULT_OUTBOUND_POLICY).policy === "allow" && (!opaque || fullAccess) ? "allow" : null;
}
export function createOutboundHold(deps) {
    const { store, outboundRequests, connectorThread, activeGroupTurnForBot, notify } = deps;
    const DATA_DIR = deps.dataDir;
    const { holdMs } = deps;
    return {
        async hold({ bot: currentSender, threadId, tool: outboundTool, calls: outboundCalls, opaque, fullAccess, active }) {
            const refuseOutbound = (text) => ({ ok: false, text });
            if (!sendsWithoutAsking(currentSender.outbound, fullAccess, opaque)) {
                const { app, calls, summary } = outboundCard(outboundCalls);
                const owner = connectorThread(currentSender.id, threadId);
                const held = outboundRequests.open({ botId: currentSender.id, threadId, tool: outboundTool, timeoutMs: holdMs });
                const card = store.appendMessage(threadId, {
                    role: "bot",
                    kind: "options",
                    ...(owner?.group ? { from: { botId: currentSender.id, name: currentSender.name, color: currentSender.color } } : {}),
                    card: {
                        title: "Send on your behalf?",
                        subtitle: summary,
                        options: ["Allow", "Deny"],
                        requestId: held.requestId,
                        tool: outboundTool,
                        held: HELD_NOTE["approval.held.outbound"],
                        heldCode: "approval.held.outbound",
                        outboundRequest: { tool: outboundTool, app, calls },
                    },
                });
                appendDecision(DATA_DIR, {
                    threadId, requestId: held.requestId, botId: currentSender.id, botName: currentSender.name,
                    tool: outboundTool, summary, decision: "card-shown", source: "outbound",
                });
                if (owner?.group) {
                    if (activeGroupTurnForBot(currentSender.id)?.threadId === threadId)
                        store.setActivity(currentSender.id, "waiting-on-you");
                }
                else if (store.taskByThread(currentSender.id, threadId)?.busy) {
                    store.setTaskActivity(currentSender.id, threadId, "waiting-on-you");
                }
                notify(buildNotification("approval", currentSender, threadId, summary, { avatarUrl: currentSender.avatarUrl }));
                const answer = await held.answer;
                outboundRequests.forget(held.requestId);
                if (active()) {
                    const waiting = store.bot(currentSender.id);
                    if (owner?.group) {
                        if (activeGroupTurnForBot(currentSender.id)?.threadId === threadId && turnWaitedOnPerson(waiting))
                            store.setActivity(waiting.id, "working");
                    }
                    else if (turnWaitedOnPerson(store.taskByThread(currentSender.id, threadId))) {
                        store.setTaskActivity(currentSender.id, threadId, "working");
                    }
                }
                if (answer !== "allow") {
                    if (answer === "timeout") {
                        const stale = store.messagesFor(threadId).find((message) => message.id === card.id);
                        if (stale?.card && !stale.card.answered) {
                            store.patchMessage(threadId, stale.id, { card: { ...stale.card, answered: "unavailable", dismissed: true } });
                        }
                    }
                    return refuseOutbound(answer === "timeout"
                        ? "OpenMausBot did not send this: nobody answered the approval in time. Ask the user before trying again."
                        : "OpenMausBot did not send this: the user declined. Do not retry it; ask the user what they would like instead.");
                }
                return { ok: true, approved: true };
            }
            return { ok: true, approved: false };
        },
        beforeDispatch({ bot: fresh, threadId, tool: outboundTool, opaque, fullAccess, approved }) {
            const rule = sendsWithoutAsking(fresh.outbound, fullAccess, opaque);
            if (rule) {
                appendDecision(DATA_DIR, { threadId, botId: fresh.id, botName: fresh.name, tool: outboundTool, decision: "auto-approved", source: "outbound", rule });
            }
            else if (!approved) {
                throw new Error("The outbound policy changed. Ask for approval again before sending.");
            }
        },
    };
}
