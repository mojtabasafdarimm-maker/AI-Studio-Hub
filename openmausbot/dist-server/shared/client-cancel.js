// A turn the person stopped, or a client abort, is not a failure. Some
// providers still finish the turn by saying so in assistant text ("The
// request was cancelled by the client.") or by raising that sentence as
// runtime.error. Both are the whole message or nothing: a real error that
// merely mentions a cancellation stays an error.
import { failedTurnCause } from "./failed-turn.js";
const STOPPED_PREFIX = "stopped:";
/** Activity name for a stopped turn. The word after the prefix is what a
 * phone that prints tool names shows; the desktop localizes it. */
export const STOPPED_TURN_NAME = `${STOPPED_PREFIX} Stopped`;
/** Activity name for a turn the person ended with Stop: the words after the
 * prefix are what a phone shows; the desktop says it in the reader's language. */
export const PERSON_STOPPED_TURN_NAME = `${STOPPED_PREFIX} You stopped this.`;
export function isStoppedTurnName(name) {
    return name.startsWith(STOPPED_PREFIX);
}
const HARNESS_PREFIX = /^provider returned a(?: streaming)? completion error:\s*/i;
// Whole message, case-insensitive. Extra words after the sentence do not match.
const CLIENT_CANCEL = [
    /^context\s+canceled\.?$/i,
    /^(?:context\s+canceled)?\s*the\s+request\s+was\s+cancell?ed\s+by\s+the\s+client\.?$/i,
    /^(?:(?:the|this)\s+)?operation\s+was\s+aborted\.?$/i,
    /^(?:the\s+)?request\s+was\s+aborted\.?$/i,
    /^the\s+user\s+aborted\s+a\s+request\.?$/i,
];
/** The abort sentence when `text` is only a client abort, including the
 * harness wrapper around one (`provider returned a completion error: …`). */
export function clientCancellation(text) {
    const body = text.trim().replace(HARNESS_PREFIX, "").trim();
    return body && CLIENT_CANCEL.some((pattern) => pattern.test(body)) ? body : null;
}
export function isClientCancellation(text) {
    return clientCancellation(text) !== null;
}
export function assistantTranscript(text) {
    return isClientCancellation(text) ? { kind: "stopped" } : { kind: "text", text };
}
export function errorTranscript(message) {
    return isClientCancellation(message) ? { kind: "stopped" } : { kind: "error", message };
}
/** A stored row the chat should read as a stop: the new activity, a legacy
 * assistant bubble that is only the abort sentence, or a legacy error row
 * whose cause is that sentence. A person's own message is never one, and a
 * bubble that also carries files stays a bubble so the files remain. */
export function isCancelledTranscriptRow(message) {
    if (message.role === "user")
        return false;
    if (message.kind === "text") {
        return !message.attachments?.length && isClientCancellation(message.text ?? "");
    }
    if (message.kind === "activity" && message.tool) {
        return isStoppedTurnName(message.tool.name) || isClientCancellation(failedTurnCause(message.tool.name) ?? "");
    }
    return false;
}
