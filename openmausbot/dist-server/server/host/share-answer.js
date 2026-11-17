// Whether a bot's answer to one requester may also answer another requester's same request (the coordinator's
// shareAnswer): only where the same people see both requesters' conversations, and only when the bot works on both in
// the same folder, since a question about files is answered from the files there. A conversation's own private folder
// starts with nothing of either requester's, so two of those count as one.
import { sep } from "node:path";
export function createShareAnswer(deps) {
    const folder = (node) => {
        const pinned = deps.pinned(node.botId, node.threadId);
        const cwd = pinned === undefined ? deps.botFolder(node.botId) ?? null : pinned;
        return cwd && !cwd.startsWith(deps.privateFolders + sep) ? cwd : null;
    };
    return (first, joiner) => {
        const a = deps.askedFrom(first), b = deps.askedFrom(joiner);
        return a !== undefined && b !== undefined && deps.audienceOf(a) === deps.audienceOf(b) && folder(first) === folder(joiner);
    };
}
