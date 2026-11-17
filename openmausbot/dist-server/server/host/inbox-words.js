import { redactParams, redactSecretsInText } from "../../shared/redact.js";
import { formatServerText } from "../../shared/server-text.js";
import { clean } from "../records-block.js";
export const INBOX_WHY = {
    "brief.inbox.ask": "Asks you to {ask}.",
    "brief.inbox.due": "due {deadline}.",
    "brief.inbox.amount": "about {amount}.",
    "brief.inbox.askDue": "Asks you to {ask}, due {deadline}.",
    "brief.inbox.askAmount": "Asks you to {ask}, about {amount}.",
    "brief.inbox.dueAmount": "due {deadline}, about {amount}.",
    "brief.inbox.askDueAmount": "Asks you to {ask}, due {deadline}, about {amount}.",
};
const KEYS = [undefined, "ask", "due", "askDue", "amount", "askAmount", "dueAmount", "askDueAmount"];
export function inboxWhy(details) {
    const ask = typeof details?.ask === "string" && details.ask.trim() ? clean(redactSecretsInText(details.ask), 120).replace(/^to\s+/i, "") : "";
    const deadline = typeof details?.deadline === "string" ? redactSecretsInText(details.deadline) : undefined;
    const amount = typeof details?.amount === "number" ? details.amount.toLocaleString("en-US") : undefined;
    const parts = [ask ? `Asks you to ${ask}` : "", deadline === undefined ? "" : `due ${deadline}`, amount === undefined ? "" : `about ${amount}`].filter(Boolean);
    const why = redactSecretsInText(parts.length ? clean(`${parts.join(", ")}.`, 240) : "");
    const name = KEYS[(ask ? 1 : 0) + (deadline === undefined ? 0 : 2) + (amount === undefined ? 0 : 4)];
    if (!name)
        return { why };
    const key = `brief.inbox.${name}`;
    const params = redactParams({ ...(ask ? { ask } : {}), ...(deadline === undefined ? {} : { deadline }), ...(amount === undefined ? {} : { amount, amountValue: String(details.amount) }) });
    return formatServerText(INBOX_WHY[key], params) === why ? { why, whyText: { key, params } } : { why };
}
export function inboxNoteWords(why, text, waiting) {
    if (!why || !text || !Object.hasOwn(INBOX_WHY, text.key) || Object.values(text.params ?? {}).some((value) => typeof value !== "string"))
        return undefined;
    const params = text.params && redactParams(text.params);
    if (formatServerText(INBOX_WHY[text.key], params) !== why)
        return undefined;
    return { key: waiting ? text.key.replace("brief.inbox.", "brief.inbox.waiting.") : text.key, ...(params ? { params } : {}) };
}
