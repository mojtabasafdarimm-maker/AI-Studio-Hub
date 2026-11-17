import { redactSecretsInText } from "./redact.js";
// ACP permission kinds and the drivers' generic names say nothing about which tool asked.
const GENERIC_TOOLS = new Set(["edit", "tool", "mcp", "other", "permissions", "read", "fetch", "search", "delete", "move", "think"]);
const SHELL_TOOLS = new Set(["shell", "bash", "execute"]);
const plain = (text, max) => {
    const line = redactSecretsInText(text).replace(/\s+/g, " ").trim();
    return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};
function approvalSubject(tool, summary) {
    const named = tool.startsWith("mcp__") ? tool.split("__").slice(2).join("__") : tool;
    const what = plain(summary, 120) || named || "an action";
    if (SHELL_TOOLS.has(named.toLowerCase()))
        return `to run “${what}”`;
    return named && !GENERIC_TOOLS.has(named.toLowerCase()) ? `to use ${plain(named, 80)}` : `for “${what}”`;
}
export function askOf(event, now) {
    const approval = event.requestType === "permission" && !event.questions?.length;
    return {
        ...(event.requestId ? { requestId: event.requestId } : {}),
        approval,
        subject: approval ? approvalSubject(event.tool, event.summary) : plain(event.summary, 500),
        since: now,
    };
}
/** What the run's card and the Routines log show while it waits. */
export function waitingFor(ask) {
    return ask.approval ? `Waiting for your approval ${ask.subject}` : ask.subject || undefined;
}
/** Ends the run's wait on the person. Returns why the run stops when an approval closed with nobody's answer. */
export function settleAsk(run, event, now) {
    const ask = run.asked;
    if (!ask || (event && ask.requestId && event.requestId && event.requestId !== ask.requestId))
        return null;
    run.waitedMs = (run.waitedMs ?? 0) + Math.max(0, now - ask.since);
    delete run.asked;
    return ask.approval && event?.source === "timeout" ? `Stopped: nobody answered the approval ${ask.subject}` : null;
}
/** Time the run has worked: waiting on the person never counts toward its limit. */
export function activeMs(run, now) {
    return now - (run.startedAt ?? now) - (run.waitedMs ?? 0) - (run.asked ? Math.max(0, now - run.asked.since) : 0);
}
