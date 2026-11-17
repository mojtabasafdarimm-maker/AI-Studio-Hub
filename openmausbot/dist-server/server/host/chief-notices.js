import { failedTurnTool } from "../../shared/failed-turn.js";
import { admit } from "../admission.js";
import { engineMemory, memoryStopped } from "../engine-memory.js";
import { outOfProcesses } from "../process-shortage.js";
import { AUTO_RETRY_LEAD, ChiefIncidentBudget, chiefForBot, INCIDENTS_THREAD_TITLE, OLD_INCIDENTS_THREAD_TITLE, IncidentLedger, incidentChip, incidentContext, incidentText, RETRY_BLOCKED, RETRY_LEAD, } from "../incidents.js";
import { buildNotification } from "../notify.js";
import { quoteInNote } from "../peer-provenance.js";
import { peerName } from "../peer-roster.js";
import { redactSecretsInText } from "../redact.js";
import { serverLine } from "../server-lines.js";
import { retriesTeammateThread } from "../routine-recovery.js";
import { queueSteeredMessage } from "../steer-queue.js";
/** How long a run stopped for memory waits before it starts again; the memory gate then holds it until there is room. */
export const MEMORY_RETRY_MS = 30_000;
/** The chats a Chief's line for the problems it was not started for names; its count covers the rest. */
export const FOLDED_LISTED = 5;
export const MEMORY_RETRY_TEXT = "[OpenMausBot started this again by itself, once: the last run was stopped to free memory on this Cloud. "
    + "Continue the request above from where it stopped and finish it. If the same problem comes back, say exactly what is blocking and stop.]";
export const SERVER_MEMORY_RETRY_TEXT = "[OpenMausBot started this again by itself, once: the last run was stopped to free memory on this server. "
    + "Continue the request above from where it stopped and finish it. If the same problem comes back, say exactly what is blocking and stop.]";
/** A run the server had no room to start is the server's shortage: it starts again by itself, and no AI is asked about it. */
export const ROOM_RETRY_TEXT = "[OpenMausBot started this again by itself, once: the last run could not start because this server had no room for another program. "
    + "Continue the request above from where it stopped and finish it. If the same problem comes back, say exactly what is blocking and stop.]";
export function createChiefNotices(deps) {
    const { store } = deps;
    const incidentLedger = new IncidentLedger();
    const chiefBudget = new ChiefIncidentBudget({ now: deps.now, limit: deps.chiefTurnsPerHour });
    /** Each Chief's line that counts the problems it was not started for, while its hour's share is spent. */
    const folded = new Map();
    const schedule = deps.schedule ?? ((run) => { setTimeout(run, 0).unref?.(); });
    const later = deps.later ?? ((run, ms) => { setTimeout(run, ms).unref?.(); });
    /** Each thread's last request a run stopped for memory was started again for: once a request. */
    const roomRetries = new Map();
    /** A run stopped for memory that no Chief retries starts once more by itself; the person hears only if that one fails too,
     * or can't start. Never a run whose thread someone wrote in since, or that is running or queued again. */
    function retryForRoom(bot, threadId, report, text = MEMORY_RETRY_TEXT) {
        const continueRequest = deps.continueRequest;
        if (!continueRequest)
            return false;
        const asked = store.activePath(threadId).findLast((line) => line.role === "user")?.id ?? "";
        if (roomRetries.get(threadId) === asked) {
            report({ retried: true });
            return true;
        }
        roomRetries.set(threadId, asked);
        if (roomRetries.size > 500)
            roomRetries.delete(roomRetries.keys().next().value);
        const failedAt = Date.now();
        later(() => {
            if (!store.bot(bot.id) || !store.taskByThread(bot.id, threadId))
                return;
            if (store.activePath(threadId).some((line) => line.role === "user" && line.at > failedAt))
                return;
            if (deps.threadBusy(bot.id, threadId) || deps.threadQueued?.(bot.id, threadId))
                return;
            continueRequest(bot.id, threadId, text)
                .catch((error) => report({ notRetried: `its retry could not start (${error instanceof Error ? error.message : String(error)})` }));
        }, MEMORY_RETRY_MS);
        return true;
    }
    /** Why a teammate's stopped thread cannot be retried now, in words a Chief can act on, or null. */
    function retryRefusal(botId, threadId) {
        const blocked = deps.threadBusy(botId, threadId) ? (deps.threadSettling?.(threadId) ? "settling" : "running")
            : deps.threadQueued?.(botId, threadId) ? "queued" : null;
        if (blocked)
            return RETRY_BLOCKED[blocked];
        // A thread that finished a run since it was last reported has nothing to resume: resuming would redo finished work.
        const reportedAt = incidentLedger.lastAt(threadId);
        if (reportedAt !== undefined && store.activePath(threadId).some((line) => line.turnSucceeded === true && line.at > reportedAt)) {
            return "that thread has finished a run since it was reported — there is nothing to retry; read what it did before deciding anything else";
        }
        return null;
    }
    /** The one way a teammate's stopped thread runs again: a Chief's retry_thread and OpenMausBot's automatic retry both
     * start it here, after the same refusal checks. Throws the refusal, or why the start failed. */
    async function retryThread(input) {
        const refused = retryRefusal(input.bot.id, input.threadId);
        if (refused)
            throw new Error(refused);
        const chief = peerName(input.chief.name);
        const lead = input.automatic
            ? `${AUTO_RETRY_LEAD}, once, before telling ${chief}, your Chief of Staff, that this thread's last run failed.`
            : `${RETRY_LEAD}${chief}, your Chief of Staff, after this thread's last run stopped.${input.note ? ` Note from ${chief}: ${quoteInNote(input.note, 300)}` : ""}`;
        await deps.startTurn(input.bot.id, `${lead} Continue the request above from where it stopped and finish it. If the same problem comes back, say exactly what is blocking and stop.]`, { threadId: input.threadId, unattended: input.unattended, peerAsk: { botId: input.chief.id, name: input.chief.name, ...(input.unattended ? { unattended: true } : {}) } });
    }
    /** A notice about this thread may go to `chief`: its asks are the Chief's person's, never another person's private chat. */
    function reachesChief(chief, bot, threadId) {
        const routing = deps.routing;
        if (deps.confined?.(threadId))
            return false;
        return routing ? routing.askedPerson(bot.id, threadId) === routing.personOf(chief) : deps.privateThread?.(threadId) !== true;
    }
    function incidentRefused(chief, incidentsThreadId, asks, why) {
        const refused = `the problem report could not reach ${chief.name} — ${why}`;
        store.appendMessage(incidentsThreadId, { role: "bot", kind: "activity", tool: failedTurnTool(refused) });
        const lines = store.messagesFor(incidentsThreadId);
        for (const ask of asks) {
            if (!ask?.incident || ask.incident.notified)
                continue;
            const bot = store.bot(ask.botId);
            if (!bot)
                continue;
            const { threadId } = ask.incident;
            const chip = lines.findLast(line => line.kind === "activity" && line.tool?.ok === false && line.threadRef?.threadId === threadId)?.tool?.name;
            const group = store.groupByThread(threadId);
            deps.notify(buildNotification("incident", bot, threadId, chip ?? refused, {
                avatarUrl: bot.avatarUrl,
                ...(group ? { group: { id: group.id, name: group.name } } : {}),
            }));
        }
    }
    /** Past its hour's share a Chief is not started again: the problems are counted on one line in its notices chat, which
     * lists the chats they came from (the first FOLDED_LISTED) and links the newest. */
    function fold(chief, threadId, until, from) {
        const open = folded.get(chief.id), now = deps.now?.() ?? Date.now();
        const same = open && open.threadId === threadId && open.until > now ? open : null;
        const count = (same?.count ?? 0) + 1;
        const chats = same?.chats.some((chat) => chat.threadId === from.threadId) ? same.chats : [...(same?.chats ?? []), from];
        const list = chats.slice(0, FOLDED_LISTED).map((chat) => chat.name).join("; ");
        const name = serverLine(deps.threadLanguage?.(threadId), "server.incidents.folded", { count, chief: chief.name, list });
        const threadRef = { botId: from.botId, threadId: from.threadId, title: from.title };
        const line = same && store.patchMessage?.(threadId, same.messageId, { tool: { name, ok: false }, threadRef })
            || store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name, ok: false }, threadRef });
        folded.set(chief.id, { threadId, messageId: line.id, count, chats, until: Math.max(until, same?.until ?? 0) });
    }
    function deliver(input) {
        const { chief, bot, threadId } = input;
        const task = store.taskByThread(bot.id, threadId);
        const group = store.groupByThread(threadId);
        const tellThePerson = () => {
            if (!input.alreadyNotified) {
                deps.notify(buildNotification("incident", bot, threadId, input.chip, {
                    avatarUrl: bot.avatarUrl,
                    ...(group ? { group: { id: group.id, name: group.name } } : {}),
                }));
            }
            return "person";
        };
        const routing = deps.routing;
        const person = chief && routing ? routing.personOf(chief) : null;
        if (!chief || !reachesChief(chief, bot, threadId))
            return tellThePerson();
        const notices = store.tasks(chief.id).find((candidate) => (candidate.title === input.title || (input.title === INCIDENTS_THREAD_TITLE && candidate.title === OLD_INCIDENTS_THREAD_TITLE)) && !candidate.archivedAt &&
            (!routing || routing.startedBy(candidate.threadId) === (person ?? undefined)))
            ?? store.createTask(chief.id, input.title, false, undefined, { botId: chief.id, name: chief.name, at: Date.now() }, undefined, undefined, undefined, routing && person ? (created) => routing.open(created.threadId, person) : undefined);
        if (!notices || notices.threadId === threadId)
            return tellThePerson();
        if (routing && person && routing.startedBy(notices.threadId) === undefined)
            routing.open(notices.threadId, person);
        const spent = chiefBudget.take(chief.id);
        if (spent) {
            const title = task?.title ?? (group ? group.name : `${bot.name}'s conversation`);
            fold(chief, notices.threadId, spent.until, { botId: bot.id, threadId, title, name: `${bot.name} · ${title}` });
            tellThePerson();
            return "chief";
        }
        store.appendMessage(notices.threadId, {
            role: "bot",
            kind: "activity",
            tool: { name: input.chip, ok: false },
            threadRef: { botId: bot.id, threadId, title: task?.title ?? (group ? group.name : `${bot.name}'s conversation`) },
        });
        const peerAsk = { botId: bot.id, name: bot.name, unattended: true,
            incident: { threadId, ...(input.alreadyNotified ? { notified: true } : {}) } };
        const decision = admit("incident", {}, {
            threadBusy: deps.threadBusy(chief.id, notices.threadId),
            atCapacity: deps.botAtThreadCapacity(chief.id),
            groupTurn: deps.groupTurnActive(chief.id),
        });
        if (decision.action === "queue") {
            queueSteeredMessage(chief.id, notices.threadId, input.text, { reason: decision.reason, unattended: true, peerAsk });
            return "chief";
        }
        void deps.startTurn(chief.id, input.text, { threadId: notices.threadId, unattended: true, peerAsk }).catch((error) => {
            incidentRefused(chief, notices.threadId, [peerAsk], error instanceof Error ? error.message : String(error));
        });
        return "chief";
    }
    /** A failed teammate run gets one retry from OpenMausBot before its Chief hears; the Chief then hears how that retry ended.
     * Never retried: a stall the turn watchdog stopped (kind "stalled"), a stop, a refusal or a cap (retriesTeammateThread,
     * from the failure's words and `facts`), a run that answered a retry, and a thread whose asks are not the Chief's person's. */
    /** `notified`: the person already heard of it another way (a usage limit's own notice), so only the Chief is told. */
    /** `failure`: the failure's own words when `detail` adds a name to them; only those are read for the kind of failure. */
    function reportIncident(input) {
        const { bot, threadId } = input;
        if (deps.quietThread?.(bot.id, threadId))
            return;
        const task = store.taskByThread(bot.id, threadId);
        if (deps.assignerOf(threadId))
            return;
        const group = store.groupByThread(threadId);
        const incident = {
            kind: input.kind,
            bot,
            threadId,
            title: task?.title ?? null,
            room: group?.name ?? null,
            detail: redactSecretsInText(input.detail),
            failure: { text: input.failure ?? input.detail, stopReason: input.facts?.stopReason },
            ...incidentContext(deps.store.messagesFor(threadId)),
        };
        const count = incidentLedger.note(threadId);
        if (count.muted)
            return;
        const chief = chiefForBot(store.bots, bot);
        const report = (retry) => void deliver({
            chief, title: INCIDENTS_THREAD_TITLE, bot, threadId,
            chip: incidentChip(incident, deps.threadLanguage?.(threadId)), text: incidentText(incident, count, retry),
            alreadyNotified: input.notified === true || input.kind === "could-not-start" || input.kind === "routine-failed",
        });
        const chiefRetries = Boolean(chief && !group && reachesChief(chief, bot, threadId));
        // Before any Chief hears: a Chief's turn about it would be a paid one, started on the same full server.
        const noRoom = outOfProcesses(input.detail), stoppedHere = !noRoom && memoryStopped(input.detail) && (deps.selfHosted ?? (() => engineMemory.selfHosted()))();
        if (noRoom || stoppedHere) {
            const person = (retry) => void deliver({ chief: null, title: INCIDENTS_THREAD_TITLE, bot, threadId, chip: incidentChip(incident, deps.threadLanguage?.(threadId)),
                text: incidentText(incident, count, retry), alreadyNotified: input.notified === true || input.kind === "could-not-start" || input.kind === "routine-failed" });
            if (group || input.kind === "routine-failed" || !retryForRoom(bot, threadId, person, noRoom ? ROOM_RETRY_TEXT : SERVER_MEMORY_RETRY_TEXT))
                person();
            return;
        }
        if (input.kind === "failed" && !group && !chiefRetries && memoryStopped(input.detail) && retryForRoom(bot, threadId, report))
            return;
        if (!chief || !chiefRetries)
            return report();
        const answered = store.activePath(threadId).findLast((line) => line.role === "user")?.text ?? "";
        if (answered.startsWith(AUTO_RETRY_LEAD))
            return report({ retried: true });
        if (input.kind !== "failed" || answered.startsWith(RETRY_LEAD) || !count.mayRetry || !retriesTeammateThread(input.detail, input.facts))
            return report();
        const failedAt = Date.now();
        schedule(() => {
            if (!store.bot(bot.id) || !store.taskByThread(bot.id, threadId))
                return;
            if (store.activePath(threadId).some((line) => line.role === "user" && line.at > failedAt))
                return report({ notRetried: "someone wrote in that thread since" });
            retryThread({ chief, bot, threadId, unattended: true, automatic: true })
                .catch((error) => report({ notRetried: `its retry could not start (${error instanceof Error ? error.message : String(error)})` }));
        });
    }
    return { reportIncident, incidentRefused, retryRefusal, retryThread };
}
