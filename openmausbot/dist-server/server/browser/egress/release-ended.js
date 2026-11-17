// Each agent-browser session's egress gate is a loopback listener of its own (gate.ts). A bot's browser that has ended
// (closed for sitting unused, restarted, or never reopened after a server restart) needs none until it opens again.
/** Releases the gate of every session whose browser no longer runs and that nothing uses; resolves to those released. */
export async function releaseEndedGates(checks) {
    const released = [];
    for (const session of checks.sessions()) {
        const env = checks.env(session);
        if (!env || checks.inUse(session) || checks.running(session, env))
            continue;
        await checks.release(session).catch(() => undefined);
        released.push(session);
    }
    return released;
}
