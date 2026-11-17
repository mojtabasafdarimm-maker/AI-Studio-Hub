import { inboxWhy } from "./inbox-words.js";
import { deciderReady } from "../decider/index.js";
import { inboxTriageRequest, INBOX_TRIAGE_TIMEOUT_MS } from "../decider/inbox-triage.js";
import { INBOX_FIELDS, INBOX_TEXT_MAX } from "../extractor/contract.js";
import { extractorReady } from "../extractor/index.js";
import { clean, defuse } from "../records-block.js";
import { PICKS_PER_TRIAGE } from "./check-plan.js";
const EXTRACT_TIMEOUT_MS = 6_000;
const AT_ONCE = 4;
/** One email as the extraction model reads it: cleaned, never more than the relay takes. */
export function inboxText(email) {
    const text = `From: ${clean(email.from, 200)}\nSubject: ${clean(email.subject, 300)}\n\n${defuse(email.preview).trim()}`;
    return Array.from(text).slice(0, INBOX_TEXT_MAX).join("");
}
/** A one-line why in plain code, from what the extraction read; never a model's own sentence. Empty when it read nothing
 * worth saying: the card already says "Waiting on your reply" or "Important". */
export function pickWhy(details) {
    return inboxWhy(details).why;
}
async function inBatches(items, size, work) {
    const out = [];
    for (let start = 0; start < items.length; start += size)
        out.push(...await Promise.all(items.slice(start, start + size).map(work)));
    return out;
}
export function createInboxTriage(deps) {
    return {
        /** Decisions are on and their inbox job too: the helper models sort the mail, not an AI turn. */
        ready: () => deciderReady(deps.config(), "inboxTriage"),
        /** The picks among `emails`, most likely first; null when any decision failed, so the batch waits. */
        async triage(emails, dismissedFrom) {
            const reads = extractorReady(deps.config());
            const judged = await inBatches(emails, AT_ONCE, async (email) => {
                const read = reads ? await deps.extractor.extract("inboxTriage", INBOX_FIELDS, { text: inboxText(email) }, { timeoutMs: EXTRACT_TIMEOUT_MS }) : null;
                const details = read?.ok ? Object.fromEntries(Object.entries(read.values).filter(([, value]) => value !== null)) : undefined;
                const { state, question } = inboxTriageRequest({ email, ...(details ? { details } : {}), dismissedFrom });
                const decided = await deps.decider.choose("inboxTriage", state, question, { timeoutMs: INBOX_TRIAGE_TIMEOUT_MS });
                // Too large for the relay is too large every time: that email is skipped, never asked about again.
                if (!decided.ok && decided.reason === "too_large")
                    return { email, details, verdict: "skip", keep: 0 };
                return decided.ok ? { email, details, verdict: decided.answers.choice, keep: 1 - (decided.answers.probabilities.skip ?? 0) } : null;
            });
            if (judged.some((one) => one === null))
                return null;
            return judged
                .flatMap((one) => (one && one.verdict !== "skip" ? [one] : []))
                .sort((a, b) => b.keep - a.keep)
                .slice(0, PICKS_PER_TRIAGE)
                .map((one) => ({ id: one.email.id, ...inboxWhy(one.details), needsReply: one.verdict === "reply" }));
        },
    };
}
