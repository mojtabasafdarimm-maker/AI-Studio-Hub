// When a person leaves a Team Cloud (an admin removes them, or they leave), what was theirs alone goes with them: their
// own MausBot with its chats and notes, their private chats with every bot (messages, notifications, the files only
// those chats used, and the files they uploaded and never sent), the routines that live in those chats, their memory
// layers, their
// engine home (its transcripts), their "About you", their own connections and saved secrets, their own browsers, and every session and
// phone of theirs. Nothing of it is handed to an admin. A routine they wrote for a shared place keeps running, as the
// routine of whoever looks after its bot now (the Admins when nobody does), and admin activity says it was handed over.
// They come off every bot's sharing and "Looked after by" (what they looked after falls to the Admins), so joining again
// restores nothing, and one admin activity row says who left, in counts. The Admin tells this machine with a signed
// request (`POST /api/cloud/team/member-left`, cloud-signed.ts).
//
// Each conversation keeps its starter (thread-starters.json, a hash): what other records still name it (a decision's
// row, a usage trace) stays someone else's, so no admin ever reads it there either.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { defaultBotPerson } from "../../shared/default-bot.js";
import { memberAudience } from "../audience.js";
import { forgetDefaultBot } from "../default-bot.js";
import { audienceHome } from "../engine-homes/layout.js";
import { forgetBotMemoryJournal, journalFile } from "../memory-journal.js";
import { deleteBotMemoryFiles } from "../message-db.js";
import { personKey } from "../person-key.js";
import { removeMemoryLayer } from "./delete-leftovers.js";
import { memberUploads } from "./member-uploads.js";
/** A file in attachments/, by its URL or by its path (as JSON escapes it) a sent document's tag carries. */
const ATTACHMENT = /attachments(?:\/|\\)+([A-Za-z0-9][\w.-]{0,200})/g;
const PERSON = /^p_[\w-]{22}$/;
export const memoryLayerRecords = {
    journalFile,
    forget(layer) {
        deleteBotMemoryFiles(layer);
        forgetBotMemoryJournal(layer);
    },
};
export function createTeamMemberLeft(deps) {
    const workspaces = join(deps.dataDir, "workspaces");
    const attachments = join(deps.dataDir, "attachments");
    return async (email) => {
        const person = personKey({ id: "", email });
        if (!PERSON.test(person))
            throw new Error("not a person key");
        // First, so nothing of theirs is opened, written or streamed while it goes.
        const sessions = deps.revokeSessions(email);
        const address = email.trim().toLowerCase();
        const botsHandedBack = deps.forgetOnBots(address);
        // Before their chats go: which routine lives in one is read from those chats.
        const everyRoutine = deps.routines();
        const ownRoutines = everyRoutine.filter((routine) => routine.home === person);
        const written = everyRoutine.filter((routine) => routine.home === null && routine.writer === person);
        for (const routine of written) {
            const owner = deps.ownerOf(routine.botId);
            const to = owner && owner !== address ? owner : null;
            deps.handRoutine(routine.id, person, to === null ? null : personKey({ id: "", email: to }));
            deps.record({ category: "bot", action: "routine.handover", target: { kind: "routine", id: routine.id, name: routine.name }, after: { owner: to } });
        }
        for (const routine of ownRoutines)
            deps.deleteRoutine(routine.id);
        deps.sharesLeft?.(person);
        const mine = new Set(deps.openedBy(person).filter((threadId) => deps.privateTo(threadId) === person));
        let chats = 0;
        const files = new Set([...memberUploads(deps.dataDir, person), ...ownRoutines.flatMap((routine) => routine.files)]);
        const noteFiles = (threadId) => {
            for (const match of JSON.stringify(deps.store.messagesFor(threadId)).matchAll(ATTACHMENT))
                files.add(match[1]);
        };
        let bots = 0;
        let botsKept = 0;
        for (const bot of deps.store.bots.filter((candidate) => candidate.defaultBot && defaultBotPerson(candidate) === address)) {
            const threads = (bot.tasks ?? []).map((task) => task.threadId);
            threads.forEach(noteFiles);
            await deps.stopBot(bot.id).catch(() => { });
            if (!(await deps.deleteBot(bot.id).catch(() => false))) {
                botsKept++;
                continue;
            }
            bots++;
            chats += threads.length;
        }
        forgetDefaultBot(deps.dataDir, address);
        for (const bot of deps.store.bots) {
            const threads = (bot.tasks ?? []).map((task) => task.threadId).filter((threadId) => mine.has(threadId));
            if (!threads.length)
                continue;
            for (const threadId of threads) {
                if (deps.busy(bot.id, threadId))
                    await deps.stop(bot.id, threadId).catch(() => { });
                noteFiles(threadId);
            }
            chats += deps.deleteTasks(bot.id, threads)?.deleted.length ?? 0;
        }
        // A file only their chats or private routines used, or that they never sent, goes too; one a bot's picture, another
        // conversation or a routine that stays uses stays.
        const routineFiles = new Set(deps.routines().flatMap((routine) => routine.files));
        let removed = 0;
        for (const name of files) {
            const url = `/api/attachments/${name}`;
            if (name.includes("..") || !existsSync(join(attachments, name)) || routineFiles.has(name) || deps.threadsReferencing(name).length || deps.store.bots.some((bot) => bot.avatarUrl === url))
                continue;
            deps.deleteAttachment(basename(name));
            removed++;
        }
        let layers = 0;
        let entries = [];
        try {
            entries = readdirSync(workspaces);
        }
        catch { }
        for (const layer of entries.filter((entry) => entry.endsWith(`--member-${person}`))) {
            removeMemoryLayer(deps.dataDir, layer, memoryLayerRecords);
            layers++;
        }
        rmSync(join(deps.dataDir, "people", person), { recursive: true, force: true });
        rmSync(audienceHome(deps.dataDir, memberAudience(person)), { recursive: true, force: true });
        await Promise.resolve(deps.forgetConnections(person)).catch((error) => { console.warn(`[team] a leaving member's connections were not all removed: ${error instanceof Error ? error.message : String(error)}`); });
        try {
            deps.forgetSecrets(person);
        }
        catch (error) {
            console.warn(`[team] a leaving member's saved secrets were not removed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const browsers = await deps.eraseBrowsers(memberAudience(person)).catch(() => false);
        // Counts of shared things only: nothing here says what was theirs alone.
        deps.record({ category: "people", action: "member.left", target: { kind: "person", name: address }, after: { botsHandedBack, routinesHandedOver: written.length } });
        return { chats, layers, sessions, files: removed, browsers, bots, botsKept, routines: ownRoutines.length, routinesHandedOver: written.length, botsHandedBack };
    };
}
