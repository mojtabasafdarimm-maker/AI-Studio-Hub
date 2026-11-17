/** Whether a bot's run still has a turn of its own, working or able to carry on by itself: while it has, the run is
 * never started again beside it. Null for a run the host cannot tell this for (a room goal's, one with no conversation). */
export function runTurnLive(run, facts) {
    if (run.target !== "bot" || !run.threadId)
        return null;
    const { busy, settling, queued, pending, parked } = facts(run.threadId);
    return busy || settling || queued || pending || parked;
}
