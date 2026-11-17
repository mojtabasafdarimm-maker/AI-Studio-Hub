// Which note a person's line carries in this conversation: on a place several people sign in to, each person's line in a
// chat more than one of them can write in is named; a member's private chat and a one-person place keep the bare line.
import { labelledLine } from "../peer-provenance.js";
import { AUTHORITY, fromNoteWith, routineWho } from "../provenance-label.js";
import { speakerOf } from "../replies.js";
const ROUTINE_RUNS = new Set(["schedule", "manual", "startup"]);
export function createLineLabels(deps) {
    const lineLabels = (threadId) => {
        const name = deps.userName(threadId);
        return { shared: deps.sharedChat(threadId), name: (line) => speakerOf(name, line), role: (line) => deps.teamRole(line.sender?.id) };
    };
    return {
        lineLabels,
        /** A line about to wait or join a running turn: its note goes with it, so a batch keeps each person's name. */
        personPrompt: (threadId, sender, text) => labelledLine({ role: "user", sender }, text, lineLabels(threadId)),
        routineRunNote: (threadId, source) => ROUTINE_RUNS.has(source)
            ? `${fromNoteWith(routineWho(deps.routineName(threadId)), "run", AUTHORITY.behalf, "no one is present")}\n` : "",
    };
}
