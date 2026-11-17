import { clean, recordsBlock } from "../records-block.js";
import { PICKS_PER_TRIAGE } from "./check-plan.js";
import { clip } from "./text-clip.js";
export const PREP_MAX = 1_200;
const NEVER_ACT = "Never send, forward, reply, book, accept, decline, delete or change anything, and do not search the web or open links: read, and nothing else.";
function when(ms, timeZone) {
    try {
        return new Date(ms).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) }).replace(/\s+/g, " ");
    }
    catch {
        return new Date(ms).toISOString();
    }
}
export function emailRecords(emails) {
    return recordsBlock("Gmail", emails.map((email) => `id ${clean(email.id, 120)} · from ${clean(email.from, 160)} · subject ${clean(email.subject, 200)} · preview ${clean(email.preview, 300)}`));
}
export function meetingRecords(items, timeZone) {
    return recordsBlock("Google Calendar", items.map(({ key, event }) => {
        const people = event.attendees.filter((attendee) => !attendee.self)
            .map((attendee) => `${attendee.name ? `${clean(attendee.name, 80)} ` : ""}<${clean(attendee.email, 120)}>${attendee.organizer ? " (organizer)" : ""}`);
        return [`id ${clean(key, 300)}`, `title ${clean(event.title, 200)}`, `when ${when(event.start, timeZone)} to ${when(event.end, timeZone)}`,
            ...(event.location ? [`where ${clean(event.location, 200)}`] : []), `attendees ${people.join(", ")}`,
            ...(event.description ? [`invite text ${clean(event.description, 1_500)}`] : [])].join(" · ");
    }));
}
function runRecords(runs) {
    return recordsBlock("the person's other routines", runs.map((run) => `${clean(run.routineName, 80)} · ${run.status} · ${clean(run.status === "completed" ? run.output ?? "" : run.error ?? "", 400)}`));
}
/** A watch run: sort the new mail and prepare the meetings, answering in JSON. */
export function watchPrompt(input) {
    const { items } = input;
    return [
        input.instructions.trim(),
        "Your checks found what is below. Work only from these records and from reading the person's Gmail and Google Calendar.",
        ...(items.mail.length ? [
            "New emails. Pick the ones the person must not miss: one that needs a reply from them, one from someone they meet today, or one with a deadline. Judge from the sender, subject and preview.",
            emailRecords(items.mail),
        ] : []),
        ...(input.dismissedFrom.length ? [
            "The person recently dismissed important-email rows for mail from these senders. Do not pick mail like that unless it plainly needs them.",
            recordsBlock("the person's dismissals", input.dismissedFrom.map((from) => clean(from, 160))),
        ] : []),
        ...(items.prep.length ? [
            "Meetings with other people starting soon. For each, write a short prep: who they are, why the meeting exists, what is still open, and one next step. A meeting marked short starts very soon: three lines at most.",
            meetingRecords(items.prep, input.timeZone),
            ...(items.prep.some((one) => one.short) ? [`Short: ${items.prep.filter((one) => one.short).map((one) => clean(one.key, 300)).join(", ")}`] : []),
        ] : []),
        NEVER_ACT,
        "Answer with one JSON object and nothing else.",
        `{"important": [{"id": "<an email id from the records>", "why": "<one sentence in your own words, first person, saying so when you are unsure>", "needsReply": <true when they must reply>}], "prep": [{"id": "<a meeting id from the records>", "brief": "<plain text, at most 150 words>"}]}`,
        `At most ${PICKS_PER_TRIAGE} important emails. When nothing matters and there is no meeting to prepare, answer {"quiet": true}.`,
    ].join("\n");
}
/** A routine of the person's own with checks: its instructions, then what the checks found, under the usual reply rules. */
export function checkedPrompt(input) {
    const { items } = input;
    return [
        input.instructions.trim(),
        "Since the last check, the routine's checks found:",
        ...(items.mail.length ? ["New emails:", emailRecords(items.mail)] : []),
        ...(items.prep.length ? ["Meetings with other people starting soon:", meetingRecords(items.prep, input.timeZone)] : []),
        ...(items.runs.length ? ["Other routines that finished:", runRecords(items.runs)] : []),
    ].join("\n");
}
function jsonObject(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start)
        return null;
    try {
        const value = JSON.parse(text.slice(start, end + 1));
        return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    }
    catch {
        return null;
    }
}
/** The watch run's answer, keeping only picks and preps of items it was given; null when it is not the JSON asked for. */
export function parseWatchResult(text, given) {
    const json = jsonObject(text);
    if (!json)
        return null;
    if (json.quiet === true && json.important === undefined && json.prep === undefined)
        return { quiet: true };
    if ((json.important !== undefined && !Array.isArray(json.important)) || (json.prep !== undefined && !Array.isArray(json.prep)))
        return null;
    if (json.important === undefined && json.prep === undefined)
        return null;
    const seen = new Set();
    const important = (json.important ?? []).flatMap((raw) => {
        const item = raw && typeof raw === "object" ? raw : {};
        if (typeof item.id !== "string" || seen.has(item.id) || !given.mail.has(item.id) || typeof item.why !== "string")
            return [];
        seen.add(item.id);
        return [{ id: item.id, why: clean(item.why, 240), needsReply: item.needsReply === true }];
    }).slice(0, PICKS_PER_TRIAGE);
    const prep = (json.prep ?? []).flatMap((raw) => {
        const item = raw && typeof raw === "object" ? raw : {};
        if (typeof item.id !== "string" || seen.has(item.id) || !given.prep.has(item.id) || typeof item.brief !== "string" || !item.brief.trim())
            return [];
        seen.add(item.id);
        return [{ id: item.id, brief: clip(item.brief, PREP_MAX) }];
    });
    return important.length || prep.length ? { quiet: false, important, prep } : { quiet: true };
}
