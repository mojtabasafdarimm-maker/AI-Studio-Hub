// Threads whose running turn the harness started for a teammate or its own upkeep, not for a person's message.
// Rewritten by every dispatch, so a peer turn that dies before it starts never silences the person's next turn.
const internalTurnThreads = new Set();
export function markInternalTurn(threadId) {
    internalTurnThreads.add(threadId);
}
export function clearInternalTurn(threadId) {
    internalTurnThreads.delete(threadId);
}
export function isInternalTurn(threadId) {
    return internalTurnThreads.has(threadId);
}
