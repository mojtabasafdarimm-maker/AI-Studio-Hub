export const THREAD_MAPS_SWEEP_MS = 10 * 60_000;
export function createThreadMaps() {
    const maps = [];
    let timer;
    const forget = (threadId) => { for (const map of maps)
        map.delete(threadId); };
    /** Drops every entry whose conversation `keep` no longer wants: archived, deleted, and not running. */
    const sweep = (keep) => {
        for (const map of maps)
            for (const threadId of Array.from(map.keys()))
                if (!keep(threadId))
                    map.delete(threadId);
    };
    return {
        track(map) { maps.push(map); return map; },
        forget,
        sweep,
        start(keep, everyMs = THREAD_MAPS_SWEEP_MS) {
            if (timer)
                return;
            timer = setInterval(() => { try {
                sweep(keep);
            }
            catch (error) {
                console.warn("thread maps: sweep failed", error);
            } }, everyMs);
            timer.unref?.();
        },
        stop() { if (timer)
            clearInterval(timer); timer = undefined; },
        entries: () => maps.reduce((sum, map) => sum + Array.from(map.keys()).length, 0),
    };
}
/** A conversation's entries stay while it runs, is open (not archived) or belongs to a room; otherwise they go. */
export const keepThreadEntry = (store, busy) => (threadId) => {
    const bot = store.botByThread(threadId);
    if (!bot)
        return Boolean(store.groupByThread(threadId));
    if (busy(bot.id, threadId) || bot.threadId === threadId)
        return true;
    const task = store.taskByThread(bot.id, threadId);
    return task !== undefined && task.archivedAt === undefined;
};
