// The meeting tools' routes, called by the agents server on a bot's turn.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { END_REASON_TEXT, MEETING_PLATFORM_NAMES } from "../../shared/meetings.js";
import { recordsText } from "../records-block.js";
import { PASS } from "../routes/table.js";
import { notesCard } from "./cards.js";
import { MeetingError, transcriptText } from "./manager.js";
const id = z.string().min(1).max(80);
const schemas = {
    join: z.object({ link: z.string().max(2_000).optional(), note: z.string().max(200).optional(), every_calendar_meeting: z.boolean().optional(), local_transcription: z.boolean().optional() }),
    status: z.object({ meeting_id: id, page: z.number().int().min(1).optional() }),
    chat: z.object({ meeting_id: id, text: z.string().trim().min(1).max(1_500) }),
    leave: z.object({ meeting_id: id }),
    notes: z.object({
        meeting_id: id, title: z.string().trim().min(1).max(120), summary: z.string().trim().min(1).max(4_000),
        decisions: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
        action_items: z.array(z.object({ owner: z.string().trim().max(80).optional(), item: z.string().trim().min(1).max(500), due: z.string().trim().max(80).optional() })).max(30).optional(),
        open_questions: z.array(z.string().trim().min(1).max(500)).max(15).optional(),
    }),
};
const PREFIX = "/api/internal/meetings/";
export function createMeetingRoutes(deps) {
    async function answer(action, body, ctx) {
        const parsed = schemas[action].safeParse(body);
        if (!parsed.success)
            return { status: 400, error: "Those arguments don't match the tool's fields." };
        const meetings = deps.meetings();
        const botId = ctx.bot.id;
        switch (action) {
            case "join": {
                const input = parsed.data;
                if (input.every_calendar_meeting)
                    return { status: 200, text: deps.createRoutine(botId, ctx.threadId) };
                if (!input.link)
                    return { status: 400, error: "Give the meeting link, or every_calendar_meeting: true." };
                const owner = deps.computerOwner(botId);
                if (typeof owner !== "string")
                    return { status: 409, error: owner.error };
                const { record, already } = meetings.join({ botId, botName: ctx.bot.name, threadId: ctx.threadId, owner, link: input.link, ...(input.note ? { note: input.note } : {}), ...(input.local_transcription ? { local: true } : {}), person: deps.personName(ctx.threadId) });
                return {
                    status: 200,
                    text: already
                        ? `You are already in this meeting: meeting_id ${record.id} (${record.phase.replace("_", " ")}).`
                        : `meeting_id ${record.id}. Joining the ${MEETING_PLATFORM_NAMES[record.platform]} meeting in the background as "${ctx.bot.name} (notes)"; the host has to let you in (up to 10 minutes). A card in this conversation follows it. You will get each @notes question and the notes request as their own turns.`,
                };
            }
            case "status": {
                const input = parsed.data;
                const first = meetings.status(input.meeting_id, botId, 1);
                const status = input.page ? meetings.status(input.meeting_id, botId, input.page) : meetings.status(input.meeting_id, botId, first.pages);
                const { record } = status;
                const state = record.phase === "ended"
                    ? `ended after ${status.minutes} min: ${END_REASON_TEXT[record.endReason ?? "meeting_ended"]}`
                    : record.phase === "in_meeting" ? `in the meeting with ${record.others} other${record.others === 1 ? "" : "s"} for ${status.minutes} min`
                        : record.phase === "lobby" ? "waiting to be let in" : "joining";
                const head = `meeting_id ${record.id} (${MEETING_PLATFORM_NAMES[record.platform]}): ${state}. Attendees seen: ${record.attendees.join(", ") || "none yet"}.`;
                if (!status.total)
                    return { status: 200, text: `${head} No transcript yet.` };
                deps.markOutside(ctx.threadId);
                const text = transcriptText(status.lines, record.joinedAt ?? record.createdAt);
                return { status: 200, text: `${head} Transcript page ${status.page} of ${status.pages} (${status.total} lines):\n${recordsText("the meeting transcript, written by its participants", text, 60_000)}` };
            }
            case "chat": {
                const input = parsed.data;
                meetings.status(input.meeting_id, botId);
                const tool = "post_in_meeting_chat";
                const fullAccess = deps.sendsFreely(botId, ctx.threadId);
                const held = await deps.outbound().hold({ bot: ctx.bot, threadId: ctx.threadId, tool, calls: [{ slug: tool, arguments: { text: input.text } }], opaque: false, fullAccess, active: ctx.active });
                if (!held.ok)
                    return { status: 403, error: held.text };
                try {
                    deps.outbound().beforeDispatch({ bot: ctx.bot, threadId: ctx.threadId, tool, opaque: false, fullAccess: fullAccess && deps.sendsFreely(botId, ctx.threadId), approved: held.approved });
                }
                catch (error) {
                    return { status: 403, error: error instanceof Error ? error.message : String(error) };
                }
                const sent = await meetings.chat(input.meeting_id, botId, input.text);
                return sent.ok ? { status: 200, text: "Posted in the meeting chat." } : { status: 409, error: sent.error ?? "The message was not posted." };
            }
            case "leave": {
                const record = await meetings.leave(parsed.data.meeting_id, botId);
                return { status: 200, text: record.phase === "ended" ? "That meeting has already ended." : "Leaving the meeting now. You will be asked to write the notes once it is closed." };
            }
            case "notes": {
                const input = parsed.data;
                const { record, minutes } = meetings.status(input.meeting_id, botId);
                if (record.phase !== "ended")
                    return { status: 409, error: "The meeting is still running. Post the notes once it has ended." };
                if (record.notes === "posted")
                    return { status: 409, error: "The notes for this meeting are already posted." };
                const folder = deps.folder(botId, ctx.threadId);
                if (!folder)
                    return { status: 409, error: "This conversation has no working folder for the transcript." };
                const day = new Date(record.joinedAt ?? record.createdAt).toLocaleDateString("en-CA");
                const name = `${day} ${input.title.replace(/[^\p{L}\p{N} _-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "meeting"} transcript.md`;
                const dir = join(folder, "meetings");
                mkdirSync(dir, { recursive: true });
                const path = join(dir, name);
                const lines = meetings.lines(record.id);
                writeFileSync(path, `# ${input.title}\n\n${MEETING_PLATFORM_NAMES[record.platform]} · ${deps.dateLine(record.joinedAt ?? record.createdAt)} · ${minutes} min\n\n${transcriptText(lines, record.joinedAt ?? record.createdAt)}\n`);
                const notes = { title: input.title, summary: input.summary, decisions: input.decisions ?? [], actions: input.action_items ?? [], questions: input.open_questions ?? [] };
                const messageId = await deps.postNotes(ctx.threadId, ctx.bot, notesCard(record, notes, minutes, deps.dateLine(record.joinedAt ?? record.createdAt)), path, name);
                if (!messageId)
                    return { status: 409, error: "The notes card could not be posted in this conversation." };
                meetings.notesPosted(record.id, botId, messageId);
                return { status: 200, text: "The Meeting notes card is posted, with the transcript attached." };
            }
        }
    }
    return {
        async internal(ctx) {
            if (ctx.method !== "POST" || !ctx.path.startsWith(PREFIX))
                return PASS;
            const action = ctx.path.slice(PREFIX.length);
            if (!(action in schemas))
                return PASS;
            try {
                const out = await answer(action, await ctx.readBody(), ctx);
                ctx.json(ctx.res, out.status, out.error ? { error: out.error } : { text: out.text });
            }
            catch (error) {
                if (error instanceof MeetingError)
                    return void ctx.json(ctx.res, 404, { error: error.message });
                throw error;
            }
        },
    };
}
export const MEETING_ROUTES = ["join", "status", "chat", "leave", "notes"].map((action) => `POST ${PREFIX}${action}`);
