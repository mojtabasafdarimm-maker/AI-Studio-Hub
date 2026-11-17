// Meeting notes on this server: the meetings, their tools' routes, the Leave button and the computer they keep awake.
import { MEETING_ROUTINE } from "../../shared/meetings.js";
import * as boat from "../boat.js";
import { saveBotAttachment } from "../bot-attachment.js";
import { createAgentCard } from "../chat-widgets.js";
import { startInBackground } from "../cloud-computer-background.js";
import { createBotEngine } from "../meetings/engine.js";
import { END_LINE, LEAVE_ACTION, liveCard } from "../meetings/cards.js";
import { createMeetings } from "../meetings/manager.js";
import { createMeetingRoutes } from "../meetings/routes.js";
import { MEETINGS_NEED_CLOUD_COMPUTER } from "../meetings/prompt.js";
import { speechSource } from "../meetings/speech.js";
import { OUTSIDE } from "../peer-provenance.js";
import { conversationLanguage, serverLine } from "../server-lines.js";
const START_BUDGET_MS = 150_000;
const BUSY_WAIT_MS = 15 * 60_000;
export function createMeetingsHost(deps, routeDeps) {
    const { cfg, store } = deps;
    const engine = createBotEngine();
    const speaker = (record) => {
        const bot = store.bot(record.botId);
        return bot ? { id: bot.id, name: bot.name, color: bot.color } : null;
    };
    const computer = (boxId) => ({
        async run(command, timeoutMs) {
            const result = await boat.runCommand(cfg, boxId, boat.isolatedRemoteCommand(command), { timeoutMs });
            return { ok: result.ok, stdout: result.stdout, stderr: result.stderr };
        },
        async start(command) {
            const started = await startInBackground(cfg, boxId, command, AbortSignal.timeout(60_000));
            return started.isError ? { ok: false, error: started.content.map((part) => ("text" in part ? part.text : "")).join(" ") } : { ok: true };
        },
    });
    async function followUp(record, prompt) {
        const until = Date.now() + BUSY_WAIT_MS;
        while (deps.threadBusy(record.botId, record.threadId)) {
            if (Date.now() > until)
                throw new Error("the conversation stayed busy");
            await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        routeDeps().markOutside(record.threadId);
        await deps.startTurn(record.botId, prompt, { threadId: record.threadId, unattended: true, cardContinuation: true, origin: OUTSIDE });
    }
    const meetings = createMeetings({
        dataDir: deps.dataDir,
        engine,
        speech: (record) => speechSource(cfg, { local: record.local === true }),
        async computerFor(record) {
            const bot = store.bot(record.botId);
            if (!bot)
                return { error: "The bot is gone." };
            if (!boat.boatConfigured(cfg))
                return { error: "Meeting notes need a cloud computer, and none is set up here." };
            const machine = record.owner === bot.id
                ? await deps.power().start(bot, { threadId: `meeting:${record.id}`, generation: record.id }, { budgetMs: START_BUDGET_MS })
                : await boat.readyBoat(cfg, record.owner, START_BUDGET_MS);
            if (!machine || typeof machine.id !== "string")
                return { error: "The cloud computer didn't start in time." };
            deps.power().used(record.owner);
            return { boxId: machine.id };
        },
        computer,
        touch: (owner) => deps.power().used(owner),
        card: {
            show(record) {
                const bot = speaker(record);
                if (!bot)
                    return null;
                const made = createAgentCard({ store, bot, threadId: record.threadId, input: { tool: "show_widget", widget: liveCard(record, 0) }, serverCard: true });
                return made.ok ? made.messageId : null;
            },
            update(record) {
                const bot = speaker(record);
                if (!bot || !record.cardMessageId)
                    return;
                createAgentCard({ store, bot, threadId: record.threadId, input: { tool: "update_widget", widget_id: record.cardMessageId, widget: liveCard(record, meetings.minutes(record)) }, serverCard: true });
            },
        },
        say(record, line) {
            const language = conversationLanguage(record.threadId);
            const reason = serverLine(language, END_LINE[line.reason]);
            const text = line.joined ? serverLine(language, "server.meetings.nothingHeard", { reason })
                : line.detail ? serverLine(language, "server.meetings.endedDetail", { reason, detail: line.detail }) : reason;
            store.appendMessage(record.threadId, { role: "bot", kind: "text", text });
        },
        followUp,
        log: deps.log,
    });
    const routes = createMeetingRoutes({
        personName: (threadId) => routeDeps().personName(threadId),
        folder: (botId, threadId) => routeDeps().folder(botId, threadId),
        outbound: () => routeDeps().outbound(),
        sendsFreely: (botId, threadId) => routeDeps().sendsFreely(botId, threadId),
        markOutside: (threadId) => routeDeps().markOutside(threadId),
        meetings: () => meetings,
        computerOwner(botId) {
            const bot = store.bot(botId);
            if (!bot)
                return { error: "The bot is gone." };
            if (!boat.boatConfigured(cfg))
                return { error: MEETINGS_NEED_CLOUD_COMPUTER };
            return deps.computerOwner(bot);
        },
        createRoutine(botId, threadId) {
            const manager = deps.routines();
            if (!manager)
                return "Routines are not available here right now.";
            const existing = manager.listRoutines().find((routine) => routine.botId === botId && routine.name === MEETING_ROUTINE.name);
            if (existing)
                return `The routine "${MEETING_ROUTINE.name}" is already set up${existing.enabled ? "" : " (paused; turn it on in Routines)"}.`;
            manager.create({
                name: MEETING_ROUTINE.name, prompt: MEETING_ROUTINE.prompt, botId, enabled: true, timeoutMinutes: 10, overlap: "skip", resultsThreadId: threadId,
                schedule: { type: "interval", everyMinutes: MEETING_ROUTINE.everyMinutes, anchorAt: Date.now() + 60_000, weekdays: [1, 2, 3, 4, 5],
                    window: { start: MEETING_ROUTINE.windowStart, end: MEETING_ROUTINE.windowEnd } },
            });
            return `Set up the routine "${MEETING_ROUTINE.name}": every ${MEETING_ROUTINE.everyMinutes} minutes on weekdays (${MEETING_ROUTINE.windowStart}–${MEETING_ROUTINE.windowEnd}) it looks at the person's Google Calendar and joins meetings with a Meet or Teams link as they start. It needs Google Calendar connected. It can be paused or changed in Routines.`;
        },
        async postNotes(threadId, bot, card, path, name) {
            const made = createAgentCard({ store, bot, threadId, input: { tool: "show_widget", widget: card }, serverCard: true });
            if (!made.ok)
                return null;
            const folder = routeDeps().folder(bot.id, threadId);
            const saved = await saveBotAttachment({ path, name, roots: folder ? [folder] : [] });
            store.appendMessage(threadId, { role: "bot", kind: "text", text: "", attachments: [saved.attachment] });
            return made.messageId;
        },
        dateLine: (at) => new Date(at).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }),
    });
    setTimeout(() => meetings.resume(), 5_000).unref();
    return {
        internal: (ctx) => routes.internal(ctx),
        keepsAwake: (owner) => meetings.keepsAwake(owner),
        /** The live card's Leave button, handled here without a turn. */
        serverPress(bot, threadId, messageId, action, _auth) {
            if (action.type !== LEAVE_ACTION || !action.payload || typeof action.payload !== "object" || Array.isArray(action.payload))
                return null;
            const meetingId = action.payload.meetingId;
            const record = typeof meetingId === "string" ? meetings.record(meetingId) : undefined;
            const row = store.messagesFor(threadId).find((message) => message.id === messageId);
            if (!record || record.botId !== bot.id || record.cardMessageId !== messageId || row?.serverCard !== true)
                return null;
            void meetings.leave(record.id, bot.id).catch((error) => deps.log(`meeting ${record.id}: leave failed: ${String(error)}`));
            return "handled";
        },
        close: () => meetings.close(),
    };
}
