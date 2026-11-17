// A Team Cloud's routines and the audience rule (docs/team-cloud.md "Routines"): the person whose private chat a routine
// lives in (routine-home.ts), whether a bot's turn may know of it, who its runs and results chats are opened as (its
// person's for a private one, the team's for one of a shared place, whoever made it), what a person may point it at,
// and what happens to a leaver's routines (team-member-left.ts). Off a team every answer here is the plain one.
import { basename } from "node:path";
import { RESULTS_JUST_ME } from "../../shared/routines.js";
import { isOwnResultsChat } from "../automation-destinations.js";
import { CLOUD_NOBODY_KEY, CLOUD_OUTSIDE_KEY } from "../cloud-sharing.js";
import { personKey } from "../person-key.js";
import { routineHome } from "../routine-home.js";
export const NO_SUCH_TRIGGER = "No trigger with that id belongs to this bot. Call trigger_info without trigger_id to see its ids.";
export function createTeamRoutines(deps) {
    /** The person whose private chat a routine lives in on a Team Cloud; null anywhere else. */
    const home = (routine) => (deps.team ? routineHome(routine, deps) : null);
    /** A turn's bot tools reach a private routine only in its person's own conversations. */
    const inTurn = (routine, threadId) => {
        const person = home(routine);
        return person === null || person === deps.privateTo(threadId);
    };
    /** A routine whose writer left runs as `to`'s (a person key; null: nobody's, whose asks go to the Admins), and stops
     * reporting into a chat of the person who left. */
    const hand = (id, left, to) => {
        const writer = to ?? CLOUD_NOBODY_KEY;
        deps.authors?.forget(id);
        deps.authors?.wrote(id, writer);
        const routine = deps.routines()?.listRoutines().find((candidate) => candidate.id === id);
        if (routine?.resultsThreadId && deps.privateTo(routine.resultsThreadId) === left)
            deps.withWriter(writer, () => deps.routines().update(id, { resultsThreadId: null }));
    };
    const field = (body, key) => (body && typeof body === "object" ? body[key] : undefined);
    return {
        home,
        inTurn,
        /** On a team, who a routine's chats are opened as: its person for a private one; the team (nobody, or outside work)
         * for one of a shared place, whoever made it, so everyone who reads that place reads its runs. Null off a team. */
        opener(routine) {
            if (!deps.team)
                return null;
            return home(routine) ?? (deps.authors?.writer(routine.id) === CLOUD_OUTSIDE_KEY ? CLOUD_OUTSIDE_KEY : CLOUD_NOBODY_KEY);
        },
        /** A routine's results follow where it lives: one reporting into a chat whose audience is not its own (a private
         * routine's into a shared chat, or a shared one's into the chat it once opened privately for its writer) gets a new
         * results chat of its own audience at its next run. */
        reportsElsewhere(routine) {
            return deps.team && Boolean(routine.resultsThreadId) && deps.privateTo(routine.resultsThreadId) !== home(routine);
        },
        /** Why this routine body is refused: on a team, another person's own MausBot is no bot of theirs (any chat they read
         * may take its results; the visibility gate refuses another person's); off a team, the Cloud's rule for results. */
        bodyRefusal(auth, body) {
            const botId = field(body, "botId"), results = field(body, "resultsThreadId");
            if (!deps.team) {
                const refused = typeof results === "string" ? deps.threadRefusal(auth, results) : null;
                return refused ? { status: 403, error: refused } : null;
            }
            const own = typeof botId === "string" ? deps.ownBot?.(botId) : null;
            return own && (auth.kind !== "session" || own !== personKey(auth.session)) ? { status: 404, error: "no such bot" } : null;
        },
        /** "Just me" made concrete: the person's own private chat with the bot, else a new one named for the routine.
         * Security invariant: a new routine for a bot that names no audience is its writer's alone, as a new conversation
         * is; only the person's own choice (the shared chat, or an older app's null) makes one the team's. */
        justMe(auth, body, routineId) {
            if (!deps.team || auth.kind !== "session")
                return body;
            const person = personKey(auth.session), named = field(body, "botId");
            const unsaid = !routineId && field(body, "resultsThreadId") === undefined && typeof named === "string" &&
                (field(body, "target") ?? "bot") === "bot" && deps.ownBot?.(named) !== person;
            if (field(body, "resultsThreadId") !== RESULTS_JUST_ME && !unsaid)
                return body;
            const existing = routineId ? deps.routines()?.listRoutines().find((routine) => routine.id === routineId) : undefined;
            const botId = typeof field(body, "botId") === "string" ? field(body, "botId") : existing?.botId;
            if (!botId)
                return body;
            const name = typeof field(body, "name") === "string" ? field(body, "name") : existing?.name ?? "Routine";
            const mine = deps.tasks(botId).find((task) => !task.routineRunId && deps.privateTo(task.threadId) === person && !isOwnResultsChat(name, task));
            const threadId = mine?.threadId ?? deps.openChat(botId, name, person);
            return { ...body, resultsThreadId: threadId ?? RESULTS_JUST_ME };
        },
        /** Why a bot's change to a trigger by id is refused in this conversation: one that lives in someone else's private chat. */
        hiddenTrigger(request, threadId) {
            const id = request.kind === "schedule" ? request.proposal?.routineId : undefined;
            const named = id ? deps.routines()?.listRoutines().find((routine) => routine.id === id) : undefined;
            return named && !inTurn(named, threadId) ? NO_SUCH_TRIGGER : null;
        },
        /** The leave clean-up's part in routines. */
        leaving: {
            routines: () => (deps.routines()?.listRoutines() ?? []).map((routine) => ({ id: routine.id, name: routine.name, botId: routine.botId, home: home(routine),
                writer: deps.authors?.writer(routine.id), files: (routine.attachments ?? []).map((file) => basename(file.path)) })),
            deleteRoutine: (id) => { const routine = deps.routines()?.listRoutines().find((candidate) => candidate.id === id); if (routine) {
                deps.routines().removeForBot(routine.botId, id);
                deps.authors?.remove(id);
            } },
            handRoutine: hand,
        },
    };
}
