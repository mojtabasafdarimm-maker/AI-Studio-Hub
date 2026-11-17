// A routine's run that tried to hand work to a bot it may not reach. coordinate_bots refuses while the turn runs, and the
// model may say anything after, so the run keeps who it was refused and ends saying so plainly, instead of "completed":
// nothing arrived. The person who wrote the routine reads it in their inbox, whoever else the bot's failures reach.
import { namesTeammate, unreachableTeammate } from "../peer-roster.js";
import { serverLine } from "../server-lines.js";
export function createRefusedHandoffs(deps) {
    const refused = new Map();
    const toldWriter = new Map();
    function words(threadId, seen) {
        const language = deps.language(threadId), bot = seen[0].from.name;
        const named = (some) => some.map(({ target }) => target.name).join(", ");
        return serverLine(language, "server.runs.handoffApart", { bot, target: named(seen) });
    }
    return {
        /** A coordinate_bots call in a routine's run came back: remembers the bots it could not reach, and forgets one it has reached since. */
        settled(threadId, from, named, status) {
            if (!deps.runOf(threadId))
                return;
            const seen = refused.get(threadId) ?? new Map();
            for (const raw of named) {
                const target = status >= 400 ? unreachableTeammate(deps.bots(), from, raw, (bot) => deps.hides?.(from, bot) === true) : null;
                if (target)
                    seen.set(target.id, { target, from });
                if (status < 400)
                    for (const [id, was] of seen)
                        if (namesTeammate(was.target, raw))
                            seen.delete(id);
            }
            if (seen.size)
                refused.set(threadId, seen);
            else
                refused.delete(threadId);
        },
        /** The run in this conversation is ending well: what it must say instead, once; null when nothing was refused. */
        take(threadId) {
            const seen = [...refused.get(threadId)?.values() ?? []];
            if (!seen.length)
                return null;
            refused.delete(threadId);
            const said = words(threadId, seen);
            const run = deps.runOf(threadId), writer = run && deps.writerOf(run.routineId);
            const asked = run ? deps.askedPerson(run.botId, threadId) : null, inboxedAnyway = writer === asked && !deps.theirOwn(threadId, asked);
            if (run && writer && !inboxedAnyway && toldWriter.get(run.routineId) !== said) {
                toldWriter.set(run.routineId, said);
                const from = seen[0].from;
                deps.inbox().deliver(writer, {
                    kind: "notice", from: { name: from.name, botId: from.id }, origin: { botId: run.botId, threadId }, notify: "routine-failed",
                    title: serverLine(deps.language(threadId), "server.runs.handoffRefusedTitle", { bot: from.name }), text: said, quiet: writer === asked,
                });
            }
            return said;
        },
    };
}
