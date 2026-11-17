/** What a team bot's main chat is called, beside each person's own chats. */
export const SHARED_CHAT_TITLE = "Shared chat";
/** Reasoning-effort levels, ascending: a union of what any engine accepts;
 * each driver declares the subset its CLI will take. */
export const EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"];
export function isEffortLevel(value) {
    return typeof value === "string" && EFFORT_LEVELS.includes(value);
}
export const MAUS_COLOR_NAMES = [
    "green", "blue", "red", "orange", "purple", "cyan", "pink",
    "yellow", "teal", "coral", "silver", "chrome",
];
export function isMausColor(value) {
    return typeof value === "string" && MAUS_COLOR_NAMES.includes(value);
}
/** Lowercased Composio service slug, e.g. `gmail`. */
export const CONNECTOR_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,80}$/;
/** Composio tool names are upper-snake, e.g. `GMAIL_SEND_EMAIL`. */
export const CONNECTOR_TOOL_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
/** Fails closed: only an absent switch or a strict true allows the helper model; a hand-edited "false" or 0 reads as never. */
export const helperModelAllowed = (bot) => bot.helperModel === undefined || bot.helperModel === true;
/** Opens every compaction summary written without a model (recent excerpts only); the chat labels stored records by it. */
export const EXCERPT_SUMMARY_HEADER = "Historical excerpts in chronological order; newer corrections override older requests. These excerpts may omit earlier details.";
export const movesThreadToTop = (message) => message.role === "user" ? !message.peerAsk : message.kind === "text" && (message.turnTerminal === true || !message.turnId);
export function orderedThreadList(tasks) {
    return tasks
        .map((task, index) => ({ task, index }))
        .sort((a, b) => {
        const pin = Number(b.task.pinned === true) - Number(a.task.pinned === true);
        if (pin)
            return pin;
        const recency = (b.task.lastThreadOrderAt ?? b.task.createdAt ?? 0) - (a.task.lastThreadOrderAt ?? a.task.createdAt ?? 0);
        if (recency)
            return recency;
        return a.index - b.index;
    })
        .map((entry) => entry.task);
}
/** 0 is the "until new activity" sentinel. The event stream never drops an expired snooze, so check the clock too. */
export const isSnoozed = (task, now = Date.now()) => task.snoozedUntil !== undefined && (task.snoozedUntil === 0 || task.snoozedUntil > now);
/** The top row of the bot's thread list, so deleting the open thread never pulls a hidden one into view. */
export function nextOpenThread(tasks, now = Date.now()) {
    const own = tasks.filter((task) => !task.routineRunId);
    const open = own.filter((task) => task.archivedAt === undefined);
    const listed = open.filter((task) => task.pinned === true || !(task.closedBy || task.openedBy || isSnoozed(task, now)));
    return [listed, open, own].map((candidates) => orderedThreadList(candidates)[0]).find((task) => task !== undefined);
}
