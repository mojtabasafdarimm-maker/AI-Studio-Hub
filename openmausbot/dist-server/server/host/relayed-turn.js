// A bot carries on in one of its conversations from a line someone else sent there (a teammate's answer, passed back
// from their inbox): the line starts its turn now, or waits behind the one running there, as a person's message would.
import { admit } from "../admission.js";
import { escapeNotes, OUTSIDE } from "../peer-provenance.js";
import { AUTHORITY, fromNote, personWho } from "../provenance-label.js";
import { queueSteeredMessage } from "../steer-queue.js";
import { failedTurnTool } from "../../shared/failed-turn.js";
export function relayedTurn(deps) {
    return (botId, threadId, text, from, relay) => {
        const peerAsk = { botId: from.botId, name: from.name };
        const who = relay.name ?? "someone";
        const prompt = `${fromNote(relay.kind === "assistant" ? `${who}'s assistant (bot)` : personWho(who), "answer", AUTHORITY.info)}\n${escapeNotes(text)}`;
        const decision = admit("direct", {}, deps.state(botId, threadId));
        if (decision.action === "queue") {
            queueSteeredMessage(botId, threadId, text, { prompt, ...(decision.reason ? { reason: decision.reason } : {}), peerAsk, origin: OUTSIDE, relay });
            return;
        }
        const userMessage = deps.store.appendMessage(threadId, { role: "user", kind: "text", text, peerAsk, relay });
        void deps.startTurn(botId, prompt, { threadId, peerAsk, origin: OUTSIDE, userMessage }).catch((error) => {
            deps.store.appendMessage(threadId, { role: "bot", kind: "activity", tool: failedTurnTool(`this conversation could not carry on — ${error instanceof Error ? error.message : String(error)}`, { text: { key: "chat.notice.relayCouldNotContinue", params: { error: error instanceof Error ? error.message : String(error) } } }) });
        });
    };
}
