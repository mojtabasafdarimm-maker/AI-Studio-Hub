/** A person's own work: their line, or a turn going on from what they just answered or chose. Answers from a bot or a default are bot work. */
export function createTurnOrder(deps) {
    return (threadId) => {
        const turn = deps.turn(threadId);
        if (turn?.kind === "person")
            return true;
        if (turn?.kind === "continuation" && turn.personLine && !deps.unattended(threadId))
            return true;
        return deps.roomLine(threadId) || deps.running(threadId).some((node) => node.answer !== undefined && !node.answeredBy);
    };
}
