// index.ts's wiring of the link between a person's computer and their Cloud (server/bot-link/link.ts): the link over this
// server's store and coordinator, the computer's end that asks the Cloud, and the routes. With the link off (no
// bot-link.json in the data folder) `start` asks nobody and every hook here answers as if the link did not exist.
import { dirname } from "node:path";
import { createDialer } from "../bot-link/dial.js";
import { createBotLink } from "../bot-link/link.js";
import { redactSecretsInText } from "../redact.js";
import { createBotLinkRoutes, linkSessionUser } from "../routes/bot-link.js";
import { isLinkedId } from "../bot-link/protocol.js";
import { sentRow, teammateResultRow } from "./handoff-sent.js";
import { createLinkedRooms } from "./bot-link-rooms.js";
export function createBotLinkHost(deps) {
    const { store } = deps;
    /** Each bot of each linked place as a record this place finds by its address: its name and look, and where it lives.
     * It has no conversation, model or tools here, and takes no turn here. */
    const syncStandIns = () => {
        const next = new Map();
        for (const { id, peer, place, kind, bot } of link.linked()) {
            next.set(id, { id, name: bot.name, color: bot.color ?? "blue", threadId: "", tasks: [], resumeCursors: {}, modelSelection: { instanceId: "", model: bot.model ?? "" },
                home: { place: peer, placeName: place.name, botId: bot.id, kind }, ...(bot.title ? { title: bot.title } : {}), ...(bot.description ? { description: bot.description } : {}),
                ...(bot.mascotBody ? { mascotBody: bot.mascotBody } : {}), ...(bot.mascotFaceColor ? { mascotFaceColor: bot.mascotFaceColor } : {}) });
        }
        // A far member of a room here that cannot be reached now (the link is off, its place is unlinked, or its place no
        // longer has it) stays a member: it is found by its address, named as it was last known, and takes no turn.
        rooms.sync();
        for (const { id, gone, name, color, place, placeName, botId, kind, title, mascotBody, mascotFaceColor } of rooms.absent()) {
            next.set(id, { id, name, color: color ?? "blue", threadId: "", tasks: [], resumeCursors: {}, modelSelection: { instanceId: "", model: "" },
                home: { place, placeName, botId, ...(kind ? { kind } : {}), gone }, ...(title ? { title } : {}), ...(mascotBody ? { mascotBody } : {}), ...(mascotFaceColor ? { mascotFaceColor } : {}) });
        }
        store.standIns.clear();
        for (const [id, record] of next)
            if (isLinkedId(id))
                store.standIns.set(id, record);
        for (const group of store.groups) {
            const far = group.dm || !group.memberIds.some(isLinkedId) ? "" : JSON.stringify(rooms.far(group));
            if ((farTold.get(group.id) ?? "") === far)
                continue;
            if (far)
                farTold.set(group.id, far);
            else
                farTold.delete(group.id);
            deps.roomChanged?.(group.id);
        }
    };
    /** What the app was last told of each room's far members. */
    const farTold = new Map();
    const rooms = createLinkedRooms({ dataDir: deps.dataDir, store, coordinator: deps.coordinator, on: () => link.on(), linked: (peer) => link.has(peer), online: (peer) => link.online(peer), linkedBots: () => link.linked(), selfName: () => link.selfName(), wanted: () => link.wanted(),
        personName: deps.personName, line: deps.roomLine, window: deps.roomWindow, log: deps.log, ...(deps.roomOpener ? { opener: deps.roomOpener } : {}), ...(deps.roomFollow ? { follow: deps.roomFollow } : {}) });
    const link = createBotLink({
        dataDir: deps.dataDir, coordinator: deps.coordinator, kick: deps.kick, log: deps.log, rooms, directoryChanged: () => { syncStandIns(); }, revoke: (sessionId) => { deps.sessions.revoke(sessionId); },
        bots: () => store.bots, bot: (id) => store.bot(id),
        refusal: (bot) => deps.refusal(bot),
        model: (bot) => bot.modelSelection.model,
        level: (bot) => deps.level(bot),
        openThread: (bot, title, opener) => store.createTask(bot.id, title, false, undefined, { ...opener, at: Date.now(), kind: "work" })?.threadId,
        hasThread: (botId, threadId) => Boolean(store.taskByThread(botId, threadId)),
        personName: deps.personName,
        files: {
            carried: deps.files.carried, crossed: deps.files.crossed,
            store: async (files) => {
                const stored = [];
                for (const file of files) {
                    const { attachment, bytes } = await deps.storeFile(file.path, file.name, dirname(file.path));
                    if (attachment.kind === "image" || attachment.kind === "file")
                        stored.push({ kind: attachment.kind, path: attachment.path, name: attachment.name || file.name, mime: attachment.mime, bytes });
                }
                return stored;
            },
        },
        sentRow: ({ sender, threadId, recipient, workThreadId, nodeId, reason, doneWhen, roomId }) => {
            const room = roomId ? store.group(roomId) : undefined;
            store.appendMessage(threadId, sentRow({ sender: { id: sender.id, name: sender.name, color: sender.color ?? "blue" }, recipient: { ...recipient, color: "blue" }, threadId: workThreadId, via: "direct", language: deps.language(threadId), ...(room ? { room: { id: room.id, name: room.name, here: true } } : {}),
                ...(reason ? { reason } : {}), ...(doneWhen ? { doneWhen: redactSecretsInText(doneWhen) } : {}), ...deps.files.sentWith(nodeId) }));
        },
        resultRow: (parent, child, name) => {
            const room = parent.groupId ? store.group(parent.groupId) : undefined;
            if (parent.groupId ? !room || !store.groupTaskByThread(room.id, parent.threadId) : !store.taskByThread(parent.botId, parent.threadId))
                return;
            const done = child.status === "completed";
            store.appendMessage(parent.threadId, { role: "bot", kind: "activity", roomRequest: { id: child.id, phase: "result" }, ...deps.files.returnedWith(child, parent),
                tool: { name: teammateResultRow(deps.language(parent.threadId), child, name, undefined, undefined), ok: done,
                    ...(done && child.result.trim() ? { output: redactSecretsInText(child.result.trim()).slice(0, 2_000) } : {}) } });
            if (room)
                store.markGroupThreadUnread(room.id, parent.threadId, true);
            else if (!parent.parentId && parent.reply !== "poll")
                store.patchTask(parent.botId, parent.threadId, { unread: true });
        },
    });
    const dialer = createDialer({ link, log: deps.log });
    let stopWatching, upkeep;
    /** While the link is on: bot changes reach the other places, and old records and stray file bytes are cleared hourly. */
    const watch = () => {
        stopWatching ??= store.onChange((change) => { if (change.type.startsWith("bot."))
            link.botsChanged(); });
        watchRooms();
        if (upkeep)
            return;
        upkeep = setInterval(() => link.tidy(), 60 * 60_000);
        upkeep.unref?.();
    };
    /** A room's members changed: a far member is remembered by name for when its place cannot be asked, and one the person
     * removed is forgotten. Watched while the link is on, or while a room still has a far member. */
    let stopWatchingRooms;
    const watchRooms = () => { stopWatchingRooms ??= store.onChange((change) => { if (change.type === "group" && (store.standIns.size > 0 || rooms.any()))
        syncStandIns(); }); };
    const routes = createBotLinkRoutes({ link, dialer, turnedOn: watch, environmentId: deps.environmentId, local: deps.local, owner: deps.owner, power: deps.power,
        // A personal Cloud issues no session without its owner's scopes, so the link's carries them; `linkSessionRefusal`
        // (wired where requests are admitted) keeps it to the link's own routes.
        issue: (auth, label, computerId) => {
            const issued = deps.sessions.issue({ label, scopes: [...auth.scopes], userId: linkSessionUser(computerId), ...(auth.kind === "session" && auth.session.email ? { email: auth.session.email } : {}) });
            return { token: issued.token, sessionId: issued.session.id };
        },
        revoke: (sessionId) => { deps.sessions.revoke(sessionId); } });
    return {
        link, routes, rooms,
        /** Once the server is up. Off: nothing. On, on the computer: it starts asking the Cloud. */
        start() {
            // Off: nothing, unless a room here still has a member from another place, which is then found and shown as away.
            if (!link.on()) {
                if (rooms.any()) {
                    syncStandIns();
                    watchRooms();
                }
                return;
            }
            syncStandIns();
            watch();
            link.tidy();
            if (link.role() === "dialer")
                dialer.start({ gentle: true });
        },
        close() { if (upkeep)
            clearInterval(upkeep); stopWatching?.(); stopWatchingRooms?.(); dialer.close(); link.close(); },
    };
}
