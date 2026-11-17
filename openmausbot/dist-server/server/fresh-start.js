export function isFreshStart(message) {
    return message.kind === "compaction" && message.compaction?.fresh === true;
}
/** The part of a conversation path a provider may read: everything after the newest divider. */
export function sinceFreshStart(path) {
    return path.slice(path.findLastIndex(isFreshStart) + 1);
}
/** Writes the session state first: a divider with the old session still resumable would look fresh and not be. `rewound`
 * makes the next turn send sessionReset, so a process kept warm for this thread is closed rather than reused. */
export function startFresh(store, botId, threadId) {
    const task = store.taskByThread(botId, threadId);
    if (!task)
        return null;
    store.patchTask(botId, threadId, {
        rewound: true, resumeCursors: {}, appliedCompactionId: undefined, contextFloor: undefined, lastContextModel: undefined,
        ...(task.usage ? { usage: { ...task.usage, context: undefined } } : {}),
    });
    const path = store.activePath(threadId);
    const newest = path.at(-1);
    if (!newest || isFreshStart(newest))
        return null;
    return store.appendMessage(threadId, {
        role: "bot", kind: "compaction",
        compaction: { summary: "", firstKeptId: "", foldedThroughId: newest.id, tokensBefore: 0, by: "person", fresh: true },
    });
}
