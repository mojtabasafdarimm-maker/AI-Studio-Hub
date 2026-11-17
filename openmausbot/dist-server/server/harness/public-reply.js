import { redactSecretsInText } from "../redact.js";
import { visibleCoordinatorText } from "../group-goal-run.js";
/** A finished reply as its saved message holds it. */
export function savedReplyText(text) {
    return redactSecretsInText(text.includes("openmaus-goal>") ? visibleCoordinatorText(text) : text);
}
export function publicReplyEvent(event, speakerId) {
    if (event.type === "item.completed" && event.itemType === "assistant_text")
        return { ...event, text: savedReplyText(event.text) };
    if (event.type === "content.delta" && event.streamKind === "assistant_text" && speakerId)
        return { ...event, botId: speakerId };
    return event;
}
