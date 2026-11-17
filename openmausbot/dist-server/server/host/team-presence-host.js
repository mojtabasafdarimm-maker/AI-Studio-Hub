// Who is here on a Team Cloud, wired for the server (docs/team-cloud.md "Who is here"): the server's set of open event
// streams lives here, and each team session's stream in it counts its person here (team-presence.ts). POST
// /api/presence/here says which conversation a window shows, and the frames go out on the streams themselves, outside
// the replay buffer: presence is now or never.
// Security: the one rule is `reads`. A conversation counts only when more than one person can read it (a bot's shared
// chat, a group chat) and the person can; anything else, a private chat above all, is taken as "no conversation", so
// nobody, an admin included, learns that it is open, which bot it is with or that it exists.
import { ownerEmail } from "../../shared/bot-owner.js";
import { PRESENCE_HERE_PATH } from "../../shared/team-presence.js";
import { audienceMember } from "../audience.js";
import { PASS } from "../routes/table.js";
import { deliverSseFrame } from "../sse-fanout.js";
import { createTeamPresence, realClock } from "../team-presence.js";
const TAB = /^[\w-]{1,64}$/;
const THREAD_ID = /^[\w-]{1,100}$/;
const PEOPLE_GAP_MS = 1_000;
/** The person a team session speaks for; null for anything else (the server itself, a move-in sign-in). */
function teamPerson(session) {
    return session?.membershipAuthority === "team" && session.email && !session.moveIn ? ownerEmail(session.email) : null;
}
const frameOf = (frame) => `data: ${JSON.stringify(frame)}\n\n`;
/** Sends a presence frame, cutting loose a stream that cannot take it, as every other frame does. */
function send(stream, frame) {
    if (deliverSseFrame(stream, "presence", frame) === "disconnected")
        stream.close();
}
/** `streams` is the server's set of open event streams: adding one counts its person here, deleting it starts their
 * grace. */
export function createTeamPresenceHost(deps) {
    const { people } = deps;
    /** More than one person can read it: never a conversation that is someone's own, nor one with someone's own bot. */
    function shared(threadId) {
        if (audienceMember(deps.audienceOf(threadId)) !== null && !deps.sharedWithOne?.(threadId))
            return false;
        const store = deps.store();
        const group = store.groupByThread(threadId);
        const bots = group ? group.memberIds.map((id) => store.bot(id)) : [store.botByThread(threadId)];
        return bots.length > 0 && bots.every((bot) => !!bot && !bot.defaultBot?.person);
    }
    function reads(email, threadId) {
        const role = people?.list().find((person) => person.email === email)?.role;
        if (!role || !shared(threadId))
            return false;
        return deps.visibleTo(role === "member" ? { kind: "member", email } : { kind: "all", email }).thread(threadId);
    }
    function sendTo(emails, frame) {
        const text = frameOf(frame);
        for (const stream of streams) {
            const email = teamPerson(stream.person);
            if (email !== null && (emails === null || emails.has(email)))
                send(stream, text);
        }
    }
    function emit(event) {
        switch (event.type) {
            case "person":
                return sendTo(null, { kind: "team.presence", email: event.email, here: event.here });
            case "thread":
                return sendTo(new Set(event.people), { kind: "thread.presence", threadId: event.threadId, people: event.people });
        }
    }
    const clock = deps.clock ?? realClock;
    const presence = people ? createTeamPresence({ reads, emit, clock, graceMs: deps.graceMs ?? (Number(process.env.OMB_TEAM_PRESENCE_GRACE_MS) || undefined) }) : null;
    let peopleTimer;
    people?.onChange((email, change) => {
        if (change === "left")
            presence?.forget(email);
        peopleTimer ??= clock.later(() => { peopleTimer = undefined; deps.broadcast({ kind: "team.people" }); }, PEOPLE_GAP_MS);
    });
    const routes = async ({ req, res, path, method, auth, json, readBody }) => {
        if (path !== PRESENCE_HERE_PATH)
            return PASS;
        if (method !== "POST")
            return json(res, 405, { error: "POST only" });
        if (!presence)
            return json(res, 404, { error: "not found" });
        const body = await readBody(req, 4096);
        const given = body && typeof body === "object" && !Array.isArray(body) ? body : {};
        const threadId = typeof given.threadId === "string" && THREAD_ID.test(given.threadId) ? given.threadId : null;
        if (typeof given.tab !== "string" || !TAB.test(given.tab))
            return json(res, 400, { error: "Send this window's tab id." });
        const email = auth.kind === "session" ? teamPerson(auth.session) : null;
        if (email !== null && auth.kind === "session")
            presence.window(email, `${auth.session.id}:${given.tab}`, threadId);
        return json(res, 200, { ok: true });
    };
    const streams = new (class extends Set {
        add(stream) {
            super.add(stream);
            const email = teamPerson(stream.person);
            if (email !== null)
                presence?.streamOpened(email);
            return this;
        }
        delete(stream) {
            if (!super.delete(stream))
                return false;
            const email = teamPerson(stream.person);
            if (email !== null)
                presence?.streamClosed(email);
            return true;
        }
    })();
    return {
        routes,
        streams,
        /** What the people list says of someone: whether they are here now. Undefined off a team. */
        of: presence ? (email) => ({ here: presence.here(email) }) : undefined,
        /** Whether this person has the conversation open in a window now. */
        looking(email, threadId) {
            return presence?.viewers(threadId).includes(email) === true;
        },
        close() {
            presence?.close();
            peopleTimer?.cancel();
        },
    };
}
