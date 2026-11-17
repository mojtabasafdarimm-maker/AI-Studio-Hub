import { newId } from "./contracts.js";
import * as mdb from "./message-db.js";
import { buildTask } from "./task-record.js";
import { titleFromMessage } from "./thread-title.js";
function forkHistory(path, messageId) {
    const anchor = path.findIndex((message) => message.id === messageId);
    if (anchor < 0 || path[anchor]?.kind !== "text" || !["user", "bot"].includes(path[anchor].role))
        return null;
    return structuredClone(path.slice(0, anchor + 1));
}
function registerImportedFork(task, history, messageId, register) {
    mdb.importThread(task.threadId, history, messageId);
    try {
        register(task);
    }
    catch (error) {
        try {
            mdb.deleteThread(task.threadId);
        }
        catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "could not roll back the imported fork");
        }
        throw error;
    }
}
export function createGroupFork(source, path, messageId, register) {
    const history = forkHistory(path, messageId);
    if (!history)
        return null;
    const createdAt = Date.now();
    const task = {
        threadId: newId(),
        title: titleFromMessage(history.at(-1)?.text ?? ""),
        createdAt,
        updatedAt: createdAt,
        origin: { threadId: source.threadId, messageId },
        lastReadMessageId: messageId,
        ...(source.pinnedCwd !== undefined ? { pinnedCwd: source.pinnedCwd } : {}),
    };
    registerImportedFork(task, history, messageId, register);
    return task;
}
export function createBotFork(bot, source, path, messageId, approval, register) {
    const history = forkHistory(path, messageId);
    if (!history)
        return null;
    const task = buildTask(bot, titleFromMessage(history.at(-1)?.text ?? ""), source.projectId, undefined, undefined, source.modelSelection, source.cwd);
    // A fork starts with the source's effective permissions, including an Ask mask for an unconfirmed grant.
    task.approvalMode = approval.mode;
    task.autoApprove = approval.mode === "auto";
    task.alwaysAllow = structuredClone(approval.alwaysAllow);
    task.outside = source.outside;
    task.botApi = source.botApi;
    if (source.botApiAsOwner)
        task.botApiAsOwner = true;
    task.origin = { threadId: source.threadId, messageId };
    task.lastReadMessageId = messageId;
    registerImportedFork(task, history, messageId, register);
    return task;
}
