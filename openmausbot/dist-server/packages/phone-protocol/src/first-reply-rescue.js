// A chat whose AI has said nothing yet, some seconds into the turn, gets one
// notice row with what the person can do about it. The row's tool name is a
// whole plain sentence, so a client that only prints tool names (the phones)
// still reads it; this payload is what lets the desktop draw its buttons.
/** The waiting row's words, for clients that print the tool name. */
export function firstReplyWaitingName(botName, ai) {
    return `notice: ${botName} hasn't heard back from ${ai} yet.`;
}
/** The same row once its turn ended without an answer: history, true as it stands. */
export function firstReplyOverName(botName, ai) {
    return `notice: ${botName} didn't hear back from ${ai}.`;
}
/** The same row once the AI's first output arrived. */
export function firstReplySettledName(ai) {
    return `notice: ${ai} answered after a slow start.`;
}
