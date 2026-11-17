/** The longest the move waits on any one thing that is not a turn answering now. */
export const WAIT_CEILING_MS = 30 * 60_000;
/** A hand-off on its way. "waiting" (on the person, or on teammates whose own work is counted by itself) never is. */
const UNDER_WAY = new Set(["source", "queued", "running", "resume"]);
/** What the move waits for now, or null when it may freeze this computer. Each call times every thing it finds, so a
 * thing found once and still there a ceiling later no longer holds the move, unless it is a turn answering now. */
export function createMoveWaits(deps) {
    const seen = new Map();
    return () => {
        const now = (deps.now ?? Date.now)();
        const bots = new Map(deps.bots().map((bot) => [bot.id, bot]));
        const rooms = new Map(deps.rooms().map((room) => [room.id, room]));
        const found = [];
        for (const bot of bots.values()) {
            const wait = { name: bot.name, what: "bot" };
            if (deps.answering(bot.id))
                found.push({ key: `answering:${bot.id}`, wait, answering: true });
            else if (deps.turn(bot.id))
                found.push({ key: `turn:${bot.id}`, wait });
        }
        for (const run of deps.runs()) {
            if (run.status !== "running")
                continue;
            const bot = bots.get(run.botId), room = run.groupId === undefined ? undefined : rooms.get(run.groupId);
            if (bot)
                found.push({ key: `run:${run.id}`, wait: { name: bot.name, what: "bot" } });
            else if (room)
                found.push({ key: `run:${run.id}`, wait: { name: room.name, what: "room" } });
        }
        for (const room of rooms.values())
            if (deps.roomWorking(room.id))
                found.push({ key: `room:${room.id}`, wait: { name: room.name, what: "room" } });
        for (const node of deps.handoffs()) {
            const bot = bots.get(node.botId);
            if (bot && UNDER_WAY.has(node.status) && deps.exists(node))
                found.push({ key: `handoff:${node.id}`, wait: { name: bot.name, what: "bot" } });
        }
        if (deps.signingIn())
            found.push({ key: "sign-in", wait: { name: "", what: "sign-in" } });
        const keys = new Set(found.map((held) => held.key));
        for (const key of seen.keys())
            if (!keys.has(key))
                seen.delete(key);
        for (const key of keys)
            if (!seen.has(key))
                seen.set(key, now);
        const holding = found.filter((held) => held.answering || now - seen.get(held.key) < WAIT_CEILING_MS);
        return (holding.find((held) => held.answering) ?? holding[0])?.wait ?? null;
    };
}
