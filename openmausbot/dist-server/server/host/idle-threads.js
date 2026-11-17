export function createIdleThreads(deps) {
    const { store } = deps;
    const engineHolds = (threadId) => deps.claims.get(threadId)?.phase === "dispatching" || deps.engineTurn(threadId);
    const held = (threadId) => deps.claims.has(threadId) || engineHolds(threadId);
    function free(botId, threadId) {
        if (held(threadId) || !store.taskByThread(botId, threadId)?.busy)
            return;
        deps.settle(botId, threadId);
        deps.releaseComputer(botId, threadId);
        store.setTaskActivity(botId, threadId, "idle");
        deps.drain();
    }
    return {
        free,
        /** The conversations shown working that nothing holds but, maybe, a watched turn. */
        unheld() {
            return store.bots.flatMap((bot) => store.tasks(bot.id).flatMap((task) => (task.busy && !held(task.threadId) ? [{ threadId: task.threadId, botId: bot.id }] : [])));
        },
        /** Read before a Stop's interrupt drops the thread's dispatch claim. What it returns frees the thread once interrupted,
         * unless an engine had the turn or another turn began meanwhile. */
        stopping(botId, threadId) {
            const generation = deps.generations.get(threadId);
            if (engineHolds(threadId))
                return () => { };
            return () => {
                if (deps.generations.get(threadId) === generation)
                    free(botId, threadId);
            };
        },
    };
}
