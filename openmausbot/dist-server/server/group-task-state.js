export function groupTasks(group) {
    return group?.dm ? [] : (group?.tasks ?? []);
}
export function activeGroupTask(group) {
    return group?.tasks?.find((task) => task.threadId === group.threadId);
}
export function groupTaskByThread(group, threadId) {
    return group?.dm ? undefined : group?.tasks?.find((task) => task.threadId === threadId);
}
export function mirrorActiveGroupTask(group, task) {
    Object.assign(group, { threadId: task.threadId, pinnedCwd: task.pinnedCwd, pinnedMessageId: task.pinnedMessageId,
        lastReadMessageId: task.lastReadMessageId });
}
export function migrateGroupTaskRead(group, active) {
    let changed = false;
    if (group.lastReadMessageId && !active.lastReadMessageId) {
        active.lastReadMessageId = group.lastReadMessageId;
        changed = true;
    }
    if (group.unread && !group.tasks?.some((task) => task.unread)) {
        active.unread = true;
        changed = true;
    }
    return changed;
}
export function syncGroupReadPatch(group, patch) {
    if (group.dm)
        return;
    const active = group.tasks?.find((task) => task.threadId === group.threadId);
    if (patch.unread !== undefined) {
        if (active)
            active.unread = patch.unread;
        group.unread = Boolean(group.tasks?.some((task) => task.unread));
    }
    if (patch.lastReadMessageId && active)
        active.lastReadMessageId = patch.lastReadMessageId;
}
export function setGroupTaskRead(group, task, unread, lastReadMessageId) {
    task.unread = unread;
    group.unread = Boolean(group.tasks?.some((candidate) => candidate.unread));
    if (!unread && lastReadMessageId) {
        task.lastReadMessageId = lastReadMessageId;
        if (task.threadId === group.threadId)
            group.lastReadMessageId = lastReadMessageId;
    }
}
export function refreshGroupUnread(group) {
    group.unread = Boolean(group.tasks?.some((task) => task.unread));
}
export function markGroupThreadUnreadAfterTurn(store, groupId, threadId, busyBotId) {
    store.patchGroup(groupId, { busyBotId });
    store.markGroupThreadUnread(groupId, threadId, true);
}
