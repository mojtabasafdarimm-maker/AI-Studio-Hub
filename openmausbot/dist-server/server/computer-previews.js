/** The panels' screen previews: one capture per computer at a time, shared by everyone watching it. A preview reads the
 * screen and changes nothing, so it never holds the computer's lifecycle lock, and taking control never waits for it. */
export function createComputerPreviews() {
    const inFlight = new Map();
    return {
        has: (computer) => inFlight.has(computer),
        get size() { return inFlight.size; },
        capture(computer, shoot) {
            const running = inFlight.get(computer);
            if (running)
                return running;
            const started = shoot().finally(() => inFlight.delete(computer));
            inFlight.set(computer, started);
            return started;
        },
    };
}
