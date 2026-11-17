export function createRoomTurnLevels() {
    const levels = new Map();
    const key = (threadId, botId) => `${threadId}\u0000${botId}`;
    return {
        /** The release clears it when the turn ends, unless a newer turn replaced it. */
        dispatched(threadId, botId, level) {
            const entry = { level };
            levels.set(key(threadId, botId), entry);
            return () => {
                if (levels.get(key(threadId, botId)) === entry)
                    levels.delete(key(threadId, botId));
            };
        },
        forRequest(threadId, botId, own) {
            return levels.get(key(threadId, botId))?.level ?? own();
        },
    };
}
