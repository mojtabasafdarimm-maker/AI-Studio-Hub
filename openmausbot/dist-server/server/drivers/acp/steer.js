/** The names an `available_commands_update` advertises, or null when it is not one. */
export function advertisedCommands(update) {
    const commands = update;
    if (commands?.sessionUpdate !== "available_commands_update" || !Array.isArray(commands.availableCommands))
        return null;
    return new Set(commands.availableCommands.flatMap((command) => typeof command?.name === "string" ? [command.name] : []));
}
/** `running`: the turn's own prompt is out, nothing stopped it, and its session offers the command. `send` carries
 * one session/prompt text and settles when the agent answers it, fails, or the turn ends. */
export function acpTurnSteering(support, running, send) {
    let answered = false;
    let markAnswered = () => { };
    const answeredSignal = new Promise((resolve) => { markAnswered = resolve; });
    const open = () => !answered && running();
    let flight = null;
    // One steer out at a time, so each answer belongs to the one steer that is out.
    let previous = Promise.resolve();
    let out = 0;
    const start = (text) => {
        const guidance = text.trim();
        if (!guidance || !open())
            return { outcome: Promise.resolve("refused"), done: Promise.resolve() };
        let decide = () => { };
        const outcome = new Promise((resolve) => { decide = resolve; });
        const own = { verdict: null, decide };
        flight = own;
        out += 1;
        // Answered first: the agent may run the words as its next prompt, which this turn now waits for.
        void answeredSignal.then(() => decide("indeterminate"));
        const done = send(`/${support.command} ${guidance}`).then(() => decide("indeterminate"), () => decide(own.verdict === null && open() ? "refused" : "indeterminate")).finally(() => {
            out -= 1;
            if (flight === own)
                flight = null;
        });
        return { outcome, done };
    };
    return {
        swallow(chunk) {
            const own = flight;
            const verdict = own ? support.answer(chunk) : null;
            if (!own || !verdict)
                return false;
            if (own.verdict === null) {
                own.verdict = verdict;
                own.decide(verdict === "refused" ? "refused" : open() ? "steered" : "indeterminate");
            }
            return true;
        },
        steer(text) {
            const started = previous.then(() => start(text));
            previous = started.then((one) => one.done);
            return started.then((one) => one.outcome);
        },
        promptAnswered() {
            answered = true;
            markAnswered();
            return out > 0 ? previous : null;
        },
    };
}
