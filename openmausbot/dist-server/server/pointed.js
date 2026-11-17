// What the person pointed at in a bot's page, handed to the bot with their message. Every field is the page's own
// word (its scripts can describe any element any way), so it reaches the model only inside a records block.
import { z } from "zod";
import { POINT_LIMITS, pointedLabel } from "../shared/app-frame/point.js";
import { appRow } from "./chat-apps.js";
import { clean, recordsBlock } from "./records-block.js";
import { userError } from "./user-errors.js";
const part = z.object({
    appId: z.string().regex(/^[\w-]{1,128}$/),
    rev: z.number().int().min(0).max(1_000_000),
    tag: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
    role: z.string().max(40),
    text: z.string().max(POINT_LIMITS.text * 2),
    selector: z.string().min(1).max(POINT_LIMITS.selector * 2),
    html: z.string().max(POINT_LIMITS.html * 2),
    note: z.string().max(POINT_LIMITS.note * 2).optional(),
}).strict();
const parts = z.array(part).min(1).max(POINT_LIMITS.perMessage);
const BAD = `pointed must list 1 to ${POINT_LIMITS.perMessage} parts of a page in this conversation.`;
const NOTE = "While writing this message the person pointed at parts of your page. To change them, call show_html with that page's app_id.";
/** Security invariant: a pick's words reach the model only through recordsBlock. null when nothing was pointed at. */
export function preparePointed(store, threadId, value) {
    if (value === undefined || value === null)
        return null;
    const parsed = parts.safeParse(value);
    if (!parsed.success)
        return { ok: false, status: 400, error: BAD };
    // Numbered across the whole message, as the composer's chips and the page's outlines are.
    const byPage = new Map();
    parsed.data.forEach((pick, index) => byPage.set(pick.appId, [...(byPage.get(pick.appId) ?? []), { pick, number: index + 1 }]));
    const blocks = [];
    for (const [appId, picks] of byPage) {
        const row = appRow(store, threadId, appId);
        if (!row || row.app.source !== "html")
            return { ok: false, status: 404, ...userError("serverError.page.notHere") };
        const title = clean(row.app.title, 80);
        const current = (row.app.rev ?? 0) + 1;
        const versions = [...new Set(picks.map(({ pick }) => pick.rev + 1))].map((version) => `version ${version}`).join(" and ");
        const lines = picks.map(({ pick, number }) => `${number}. <${pick.tag}>${pick.role ? ` role ${pick.role}` : ""}; text: ${pick.text || "(none)"}; selector: ${pick.selector}; html: ${pick.html}`);
        // The notes are the person's own words, typed beside each chip, so they sit outside the page's records.
        const notes = picks.flatMap(({ pick, number }) => (pick.note?.trim() ? [`${number}. ${clean(pick.note, POINT_LIMITS.note)}`] : []));
        blocks.push([
            `Page app_id "${appId}" (now version ${current}); the person was looking at ${versions}.`,
            recordsBlock(`the page "${title}", describing what the person pointed at`, lines),
            ...(notes.length ? ["The person's notes on those parts, by number:", ...notes] : []),
        ].join("\n"));
    }
    return {
        ok: true,
        block: `${NOTE}\n${blocks.join("\n")}\n\n`,
        refs: parsed.data.map((pick) => ({ appId: pick.appId, label: pointedLabel(pick) ?? `<${pick.tag}>` })),
    };
}
