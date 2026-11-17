import { appendDecision } from "../decision-log.js";
import { json } from "../harness/http.js";
/** The person's answer to a team-memory, outside-write or "Send on your behalf?" card. */
export function createTrustAnswers(deps) {
    const { store, teamMemoryRequests, outsideWrites, outboundRequests } = deps;
    const DATA_DIR = deps.dataDir;
    function resolveAndSendTrust(res, threadId, requestId, behavior) {
        const remembered = teamMemoryRequests.resolve(threadId, requestId, behavior) ?? outsideWrites.resolve(threadId, requestId, behavior);
        if (remembered) {
            json(res, 200, remembered);
            return true;
        }
        const outboundCard = store.messagesFor(threadId).find((message) => message.card?.requestId === requestId && message.card.outboundRequest);
        if (outboundCard?.card?.outboundRequest) {
            const outboundBot = outboundCard.from?.botId ? store.bot(outboundCard.from.botId) : store.botByThread(threadId);
            const result = outboundRequests.resolve({ threadId, requestId, behavior });
            if (!result.claimed) {
                if (!outboundCard.card.answered) {
                    store.patchMessage(threadId, outboundCard.id, { card: { ...outboundCard.card, answered: "unavailable", dismissed: true } });
                }
                json(res, 200, { ok: true, outcome: "unavailable" });
                return true;
            }
            if (result.state === "already_settled") {
                json(res, 200, { ok: true, outcome: result.behavior === "allow" ? "allowed-once" : "rejected", alreadySettled: true });
                return true;
            }
            store.patchMessage(threadId, outboundCard.id, {
                card: { ...outboundCard.card, answered: result.state === "allowed" ? "allow" : "deny" },
            });
            appendDecision(DATA_DIR, {
                threadId, requestId, botId: outboundBot?.id, botName: outboundBot?.name,
                tool: outboundCard.card.tool, summary: outboundCard.card.subtitle,
                decision: result.state === "allowed" ? "user-approved" : "user-denied", source: "user",
            });
            json(res, 200, { ok: true, outcome: result.state === "allowed" ? "allowed-once" : "rejected" });
            return true;
        }
        return false;
    }
    return { resolveAndSendTrust };
}
