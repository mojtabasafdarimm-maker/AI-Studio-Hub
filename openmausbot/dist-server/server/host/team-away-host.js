import { personKey } from "../person-key.js";
import { PASS } from "../routes/table.js";
import { createTeamAway } from "./team-away.js";
import { roomUnreadFor, threadReadKey } from "./room-reads.js";
import { createTeamAwayEvents } from "./team-away-events.js";
export function createTeamAwayHost(deps) {
    const home = deps.cloudHome;
    if (!home?.team)
        return { delivered: () => { }, notified: () => { }, routes: (async () => PASS) };
    const windowMs = Number(process.env.OMB_TEAM_AWAY_WINDOW_MS);
    const away = createTeamAway({
        here: deps.here, language: deps.language, dataDir: deps.dataDir, adminOrigin: home.adminOrigin, machineId: home.machineId, secret: home.bootstrapSecret,
        member: (person) => deps.people().find((one) => one.leftAt === undefined && personKey({ id: "", email: one.email }) === person),
        log: (line) => console.log(`team cloud: ${line}`), ...(windowMs > 0 ? { windowMs } : {}),
    });
    const events = createTeamAwayEvents({ audienceOf: deps.audienceOf, store: deps.store, unseen: deps.unseen, noticed: away.noticed,
        unread: (person, threadId, groupId) => roomUnreadFor(deps.store.activePath(threadId), deps.readUpTo(groupId ?? threadReadKey(threadId), person), true) });
    return {
        delivered: events.delivered,
        notified: (original, routed, how) => { if (original)
            events.notified(original, routed, how); },
        routes: away.routes(deps.session),
    };
}
