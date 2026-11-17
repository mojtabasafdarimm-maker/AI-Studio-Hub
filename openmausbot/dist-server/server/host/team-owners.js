// A Team Cloud's bot owners, wired for the server: the people a bot can report to, whose a bot's asks are, and what a
// notification or Chief notice reaches. Off a team every answer here is the unrouted one.
import { botOwner } from "../../shared/bot-owner.js";
import { createAskRouting } from "../ask-routing.js";
import { setCreatedBy } from "../bot-owners.js";
import { personKey } from "../person-key.js";
import { createTeamPeople } from "../team-people.js";
const keyOf = (email) => personKey({ id: "", email });
export function createTeamOwners(deps) {
    const team = deps.team;
    const people = team ? createTeamPeople(deps.dataDir) : null;
    if (people) {
        for (const session of deps.sessions.list())
            if (session.email && session.teamRole)
                people.seen(session.email, session.teamRole);
        deps.sessions.onSessionIssued((session) => {
            if (session.membershipAuthority === "team" && session.email && session.teamRole)
                people.seen(session.email, session.teamRole);
        });
    }
    const routing = createAskRouting({ team: Boolean(team), audienceOf: deps.audienceOf, bot: (botId) => deps.store().bot(botId) ?? undefined, personKeyOf: keyOf,
        gone: (email) => people?.gone(email) ?? false });
    /** Whose a session's asks are: its person's, and an Admin's too when nobody owns the bot. */
    const viewer = (auth) => ({
        person: auth.kind === "session" && auth.session.email ? personKey(auth.session) : null,
        admin: auth.kind === "loopback" || auth.scopes.includes("admin"),
    });
    return {
        people,
        routing,
        viewer,
        /** Whether a stream frame reaches this person: a notification of an ask only the person it is for. */
        reaches: (ask, payload) => payload.kind !== "notify" || routing.notificationReaches(ask, (payload.notification ?? {})),
        /** What the Chief notices are told about owners; undefined off a team. */
        noticeRouting: team ? {
            askedPerson: routing.askedPerson,
            personOf: (chief) => { const owner = botOwner(chief); return owner ? keyOf(owner) : null; },
            startedBy: (threadId) => deps.starters.get(threadId),
            open: (threadId, person) => deps.starters.set(threadId, person),
        } : undefined,
        /** Today's and Needs you's question: is this ask the session's person's? Undefined off a team. */
        asks: team ? (auth, botId, threadId) => routing.asks(viewer(auth), botId, threadId) : undefined,
        /** The Admin said this member left: what reported to them goes to the Admins. */
        left(email) {
            people?.left(email);
        },
        /** Bots moved in before owners were recorded report to whoever moved them, unless they left. */
        backfill(moveIns) {
            for (const [botId, move] of Object.entries(moveIns))
                if (move.email && !people?.gone(move.email))
                    setCreatedBy(deps.store(), botId, move.email);
        },
    };
}
