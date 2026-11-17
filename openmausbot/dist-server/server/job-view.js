import { createHash } from "node:crypto";
export const FINAL_JOB_STATES = new Set(["needs-input", "completed", "failed", "stalled", "idle"]);
const RESULT_CLIP = 280;
const NODES_SHOWN = 500;
const ended = (a) => a.status === "completed" || a.status === "failed" || a.status === "cancelled";
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const names = (rows, label) => {
    const unique = [...new Set(rows.map(label))];
    return unique.length > 3 ? `${unique.slice(0, 3).join(", ")} and ${unique.length - 3} more` : unique.join(", ");
};
export function jobView(input) {
    const nameOf = (botId) => input.nameOf(botId) ?? botId;
    // The reason never names or quotes work in a conversation the reader may not open.
    const shows = (row) => input.visible(row.assignee.destination.threadId);
    const label = (row) => shows(row) ? nameOf(row.assignee.botId) : "a teammate";
    const byId = new Map(input.rows.map((row) => [row.id, row]));
    const starts = new Set(input.scopes);
    const awaited = new Map();
    const counts = (row) => {
        const known = awaited.get(row.id);
        if (known !== undefined)
            return known;
        awaited.set(row.id, false);
        const parent = row.parentId ? byId.get(row.parentId) : undefined;
        const result = starts.has(row.id) || (row.reply !== "none" && parent !== undefined && !ended(parent) && counts(parent));
        awaited.set(row.id, result);
        return result;
    };
    const scoped = input.rows.filter((row) => starts.has(row.id));
    const live = input.scope === "turn"
        ? scoped.filter((row) => !ended(row) && row.status !== "waiting")
        : input.rows.filter((row) => !ended(row) && counts(row));
    const parked = live.filter((row) => row.status === "needs_input");
    const asking = live.filter((row) => row.status === "running" && input.activityOf(row) === "waiting-on-you");
    const { conversation } = input;
    const lead = scoped.at(-1);
    const leadName = lead ? nameOf(lead.assignee.botId) : conversation.kind === "room" ? "The room" : "The bot";
    let state;
    let reason;
    if (conversation.activity === "waiting-on-you" || parked.length || asking.length) {
        state = "needs-input";
        const first = parked[0] ?? asking[0];
        reason = !first ? `${leadName} is waiting for your answer in this conversation`
            : shows(first) ? `${nameOf(first.assignee.botId)} needs you: ${first.question ?? "an approval is waiting in its conversation"}`
                : "A teammate needs an answer in a conversation you cannot open";
    }
    else if (conversation.activity === "dead") {
        state = "failed";
        reason = `${leadName}'s engine stopped unexpectedly`;
    }
    else if (conversation.activity === "no-signal") {
        state = "stalled";
        reason = `No sign of progress from ${leadName}'s engine`;
    }
    else if (conversation.busy || conversation.queued > 0 || live.length) {
        state = "running";
        const teammates = live.filter((row) => !starts.has(row.id));
        reason = conversation.busy ? `${leadName} is working`
            : teammates.length ? `Waiting on ${plural(teammates.length, "teammate task", "teammate tasks")}: ${names(teammates, label)}`
                : conversation.queued > 0 ? "A message is waiting its turn"
                    : `${leadName} is about to continue`;
    }
    else if (!lead) {
        state = "idle";
        reason = "Nothing is running in this conversation";
    }
    else if (lead.status === "completed" || lead.status === "waiting") {
        state = "completed";
        const failed = input.rows.filter((row) => row.id !== lead.id && (row.status === "failed" || row.status === "cancelled"));
        reason = `${leadName} finished${failed.length ? `; ${plural(failed.length, "teammate task", "teammate tasks")} did not complete (${names(failed, label)})` : ""}`;
    }
    else {
        state = lead.outcome === "stalled" ? "stalled" : "failed";
        reason = `${leadName}'s work ended ${lead.status === "cancelled" || lead.outcome === "stopped" ? "because it was stopped" : `as ${lead.outcome ?? lead.status}`}${lead.outcomeDetail ? `: ${lead.outcomeDetail}` : ""}`;
    }
    const shown = input.rows.filter(shows);
    const listed = shown.slice(-NODES_SHOWN);
    const ordered = [...listed.filter((row) => starts.has(row.id)), ...listed.filter((row) => !starts.has(row.id))];
    const tally = { queued: 0, running: 0, waiting: 0, needsInput: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const row of input.rows) {
        if (row.status === "needs_input")
            tally.needsInput += 1;
        else if (row.status === "resume")
            tally.queued += 1;
        else
            tally[row.status] += 1;
    }
    const version = createHash("sha256").update(JSON.stringify([
        state, conversation.busy, conversation.activity ?? "", conversation.queued, asking.map((row) => row.id),
        input.rows.map((row) => [row.id, row.status, row.outcome ?? "", row.executions, row.question ?? ""]),
    ])).digest("base64url").slice(0, 16);
    const node = (row) => {
        const { destination } = row.assignee;
        const title = input.titleOf(row);
        const result = ended(row) || row.status === "waiting" || row.status === "needs_input" ? row.result : "";
        return {
            id: row.id, rootId: row.rootId, ...(row.parentId ? { parentId: row.parentId } : {}), depth: row.depth,
            botId: row.assignee.botId, botName: nameOf(row.assignee.botId), threadId: destination.threadId,
            ...(title ? { threadTitle: title } : {}), ...(destination.groupId ? { groupId: destination.groupId } : {}),
            status: row.status, ...(row.outcome ? { outcome: row.outcome } : {}), ...(row.outcomeDetail ? { outcomeDetail: row.outcomeDetail } : {}),
            ...(row.question ? { question: row.question } : {}), mode: row.mode, reply: row.reply,
            awaited: input.scope === "job" ? counts(row) : starts.has(row.id),
            createdAt: row.createdAt, ...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
            ...(row.finishedAt !== undefined ? { finishedAt: row.finishedAt } : {}), executions: row.executions,
            ...(result ? { result: input.full || result.length <= RESULT_CLIP ? result : `${result.slice(0, RESULT_CLIP)}…` } : {}),
        };
    };
    return {
        threadId: input.threadId, scope: input.scope, since: input.since, now: input.now, state, reason, version, conversation,
        roots: [...input.scopes], nodes: ordered.map(node), hidden: input.rows.length - shown.length, counts: tally,
        needsInput: [...parked, ...asking].filter((row) => input.visible(row.assignee.destination.threadId)).map((row) => ({
            id: row.id, botId: row.assignee.botId, botName: nameOf(row.assignee.botId), threadId: row.assignee.destination.threadId,
            question: row.question ?? "An approval is waiting in its conversation",
        })),
    };
}
