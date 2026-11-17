// When a direct turn's end is news. A turn that hands work to teammates, or that a queued follow-up continues, is not
// the end of the job: its "done" is held, and the job's real end notifies instead. For a hand-off that is the review
// answer once the teammates' results are in. A review nobody held a "done" for (an incident review) stays quiet.
export function createDoneNotice(deps) {
    const owed = new Set();
    return {
        /** Called where a direct turn's "done" would be sent; `review` is the answer after teammates report. */
        atTurnEnd(turn) {
            if (turn.review && !owed.has(turn.threadId))
                return "quiet";
            if (turn.routine)
                return "notify";
            // A review that hands work off again (another round) is not the end either: the debt carries to the next review.
            if (turn.ok && deps.awaitingTeammates(turn.threadId)) {
                owed.add(turn.threadId);
                return "hold";
            }
            if (turn.review)
                return owed.delete(turn.threadId) && turn.ok ? "notify" : "quiet";
            return deps.queuedFollowUp(turn.botId, turn.threadId) ? "hold" : "notify";
        },
        /** A new person turn replaces whatever the last job owed: a hand-off that was stopped never pings later. */
        personTurnStarted(threadId) {
            owed.delete(threadId);
        },
        owes: (threadId) => owed.has(threadId),
    };
}
