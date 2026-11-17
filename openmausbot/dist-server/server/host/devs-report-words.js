import { serverLine } from "../server-lines.js";
export const sentLine = (reportId, contact, language) => contact
    ? serverLine(language, "server.reports.sentReply", { report: reportId, contact }) : serverLine(language, "server.reports.sent", { report: reportId });
export const laterLine = (reportId, contact, language) => contact
    ? serverLine(language, "server.reports.sentLaterReply", { report: reportId, contact }) : serverLine(language, "server.reports.sentLater", { report: reportId });
export function notYetLine(outcome, language) {
    const minutes = outcome.retryAfterMs ? Math.max(1, Math.ceil(outcome.retryAfterMs / 60_000)) : 0;
    const why = serverLine(language, outcome.why === "limited" ? "server.reports.why.limited" : outcome.why === "offline" ? "server.reports.why.offline" : "server.reports.why.busy");
    const when = minutes ? serverLine(language, minutes === 1 ? "server.reports.when.minute" : "server.reports.when.minutes", { count: minutes })
        : serverLine(language, "server.reports.when.soon");
    return serverLine(language, "server.reports.notYet", { why, when });
}
export const refusedLine = (detail, language) => serverLine(language, "server.reports.refused", { detail: detail.replace(/[.\s]+$/, "") });
export const fullLine = (count, language) => serverLine(language, "server.reports.full", { count });
export const droppedLine = (language) => serverLine(language, "server.reports.dropped");
