/** Turns each bot took in one room round, keyed by that round's `spoken` set, so a repeat @mention is answered once per reply. */
const roundTurns = new WeakMap();
export function noteGroupTurn(spoken, botId) {
    spoken.add(botId);
    const turns = roundTurns.get(spoken) ?? new Map();
    turns.set(botId, (turns.get(botId) ?? 0) + 1);
    roundTurns.set(spoken, turns);
}
/** Snapshot now; the returned function counts the turns a bot has taken in this round since. */
export function turnsSince(spoken) {
    const before = new Map(roundTurns.get(spoken));
    return (botId) => (roundTurns.get(spoken)?.get(botId) ?? 0) - (before.get(botId) ?? 0);
}
