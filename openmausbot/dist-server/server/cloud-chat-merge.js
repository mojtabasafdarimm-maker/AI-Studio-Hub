// Bring newer chats: adds to this server what a copy of another computer's workspace has and it lacks, a whole
// conversation or the messages (by id) of one both have. Invariant: nothing here deletes a row, writes a bot's settings,
// a room's setup, a routine, a memory or a credential, or changes a message this server already has, except the parentId
// that orders it after an added message.
import { chmodSync, constants, copyFileSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { splitTranscriptAttachments } from "../src/lib/composer-attachments.js";
import { movesThreadToTop } from "../shared/wire.js";
import { cleanupStaleAttachmentPartials } from "./attachments.js";
import { stampOwner } from "./cloud-owner-lines.js";
import { restorePaths } from "./workspace-backup-paths.js";
const BOT_TASK_KEYS = ["threadId", "title", "createdAt", "titleFromFirstMessage", "openedBy", "closedBy", "archivedAt", "pinned", "link", "linkAuto",
    "lastReadMessageId", "pinnedMessageId", "routineRunId", "askedAt", "snoozedUntil", "outside"];
const GROUP_TASK_KEYS = ["threadId", "title", "createdAt", "titleFromFirstMessage", "pinned", "pinnedMessageId", "turnTimeoutMinutes"];
export const ATTACHMENT_NAME = /^[A-Za-z0-9-]{1,80}\.[A-Za-z0-9]{1,10}$/;
const ownerKey = (owner) => `${owner.kind}:${owner.id}`;
const newest = (values) => { let max = Number.NEGATIVE_INFINITY; for (const value of values)
    if (value > max)
        max = value; return max; };
const textLines = (rows) => rows.filter((row) => row.kind === "text").length;
function* conversations(side) {
    for (const bot of side.bots) {
        const owner = { kind: "bot", id: bot.id }, seen = new Set();
        for (const task of bot.tasks ?? [])
            if (!seen.has(task.threadId)) {
                seen.add(task.threadId);
                yield { owner, threadId: task.threadId, task };
            }
        if (!seen.has(bot.threadId))
            yield { owner, threadId: bot.threadId };
    }
    for (const group of side.groups) {
        const owner = { kind: "group", id: group.id };
        if (group.dm || !group.tasks?.length)
            yield { owner, threadId: group.threadId, dm: Boolean(group.dm) };
        else
            for (const task of group.tasks)
                yield { owner, threadId: task.threadId, task };
    }
}
export function activePath(rows, leaf) {
    const byId = new Map(rows.map((row) => [row.id, row])), path = [], seen = new Set();
    for (let row = leaf ? byId.get(leaf) : undefined; row && !seen.has(row.id); row = row.parentId ? byId.get(row.parentId) : undefined) {
        seen.add(row.id);
        path.push(row);
    }
    return path.reverse();
}
/** A conversation's own context summary describes the other computer's session, so it is not added to one both have. */
function withoutSummaries(thread, have) {
    const dropped = new Map(thread.rows.filter((row) => !have.has(row.id) && row.kind === "compaction" && !row.compaction?.fresh).map((row) => [row.id, row.parentId ?? null]));
    if (!dropped.size)
        return thread;
    const above = (id) => { for (let hops = 0; id !== null && dropped.has(id) && hops <= dropped.size; hops++)
        id = dropped.get(id); return id; };
    return {
        rows: thread.rows.filter((row) => !dropped.has(row.id)).map((row) => row.parentId && dropped.has(row.parentId) ? { ...row, parentId: above(row.parentId) } : row),
        leaf: above(thread.leaf),
    };
}
/** A turn is a line a person (or a teammate) wrote and what answered it; a turn is never split. */
function turns(rows) {
    const out = [];
    for (const row of rows)
        if (!out.length || row.role === "user")
            out.push([row]);
        else
            out.at(-1).push(row);
    return out;
}
function interleave(here, added) {
    const out = [];
    for (let i = 0, j = 0; i < here.length || j < added.length;) {
        out.push(...(j >= added.length || (i < here.length && here[i][0].at <= added[j][0].at) ? here[i++] : added[j++]));
    }
    return out;
}
/** Adds `from`'s rows `to` lacks; the ones on `from`'s visible path are placed among `to`'s by time, turn by turn. */
export function mergeThread(from, to, { keepSummaries = false } = {}) {
    const have = new Set(to.rows.map((row) => row.id));
    const synced = newest(from.rows.filter((row) => have.has(row.id)).map((row) => row.at));
    const source = keepSummaries ? from : withoutSummaries(from, have);
    const added = source.rows.filter((row) => !have.has(row.id));
    const unchanged = { added, relinked: [], leaf: to.leaf, synced };
    if (!added.length)
        return unchanged;
    const path = activePath(source.rows, source.leaf), first = path.findIndex((row) => !have.has(row.id));
    const fresh = first < 0 ? [] : path.slice(first);
    const fork = fresh[0]?.parentId ?? null, visible = activePath(to.rows, to.leaf);
    const after = fork === null ? 0 : visible.findIndex((row) => row.id === fork) + 1;
    // A path that continues a branch this server is not showing (or runs through rows it has again) stays that branch.
    if (!fresh.length || fresh.some((row) => have.has(row.id)) || (fork !== null && after === 0))
        return unchanged;
    const placed = new Map(), relinked = [];
    let parent = fork;
    for (const row of interleave(turns(visible.slice(after)), turns(fresh))) {
        if (!have.has(row.id))
            placed.set(row.id, parent);
        else if ((row.parentId ?? null) !== parent)
            relinked.push({ id: row.id, parentId: parent });
        parent = row.id;
    }
    return { added: added.map((row) => placed.has(row.id) ? { ...row, parentId: placed.get(row.id) } : row), relinked, leaf: parent, synced };
}
function carriedTask(task, owner, rows, projects) {
    const source = task;
    const kept = Object.fromEntries((owner.kind === "bot" ? BOT_TASK_KEYS : GROUP_TASK_KEYS)
        .filter((key) => source[key] !== undefined).map((key) => [key, structuredClone(source[key])]));
    const order = newest(rows.filter(movesThreadToTop).map((row) => row.turnCompletedAt ?? row.at));
    const stamps = { updatedAt: Math.max(task.createdAt, newest(rows.map((row) => row.at))), ...(Number.isFinite(order) ? { lastThreadOrderAt: order } : {}) };
    if (owner.kind === "group")
        return { ...kept, ...stamps };
    const projectId = "projectId" in task && task.projectId && projects?.some((project) => project.id === task.projectId) ? { projectId: task.projectId } : {};
    return { ...kept, ...projectId, ...stamps, resumeCursors: {}, unread: false };
}
/**
 * A conversation `to` lacks is added unless `to` once had it: one with a message from before `syncedAt` (when the two were
 * last in step: the copy, or an earlier bring) or no newer than the newest message both share was there, so `to` deleted it since.
 */
export function planChatMerge(from, to, syncedAt = Number.NEGATIVE_INFINITY, options = {}) {
    const owners = new Set([...to.bots.map((bot) => `bot:${bot.id}`), ...to.groups.map((group) => `group:${group.id}`)]);
    const homes = new Map();
    for (const conversation of conversations(to))
        homes.set(conversation.threadId, ownerKey(conversation.owner));
    const plan = { threads: [], conversations: 0, messages: 0, intoExisting: 0, skippedBots: 0, skippedRooms: 0, deleted: 0 };
    const missing = new Set(), fresh = [];
    let synced = syncedAt;
    for (const { owner, threadId, task, dm } of conversations(from)) {
        const rows = from.thread(threadId);
        if (!rows.rows.length)
            continue;
        if (!owners.has(ownerKey(owner))) {
            if (!dm)
                missing.add(ownerKey(owner));
            continue;
        }
        const home = homes.get(threadId);
        if (home === ownerKey(owner)) {
            const merged = mergeThread(rows, to.thread(threadId), options);
            synced = Math.max(synced, merged.synced);
            if (!merged.added.length)
                continue;
            plan.threads.push({ owner, threadId, added: merged.added, relinked: merged.relinked, leaf: merged.leaf, ...(task && "outside" in task && task.outside ? { outside: true } : {}) });
            plan.intoExisting += textLines(merged.added);
        }
        else if (home === undefined && task && !to.thread(threadId).rows.length)
            fresh.push({ owner, threadId, task, rows });
    }
    for (const { owner, threadId, task, rows } of fresh) {
        if (rows.rows.some((row) => row.at <= synced)) {
            plan.deleted++;
            continue;
        }
        const projects = owner.kind === "bot" ? to.bots.find((bot) => bot.id === owner.id)?.projects : undefined;
        plan.threads.push({ owner, threadId, task: carriedTask(task, owner, rows.rows, projects), added: rows.rows, relinked: [], leaf: rows.leaf });
        plan.conversations++;
    }
    plan.messages = plan.threads.reduce((sum, thread) => sum + textLines(thread.added), 0);
    plan.skippedBots = [...missing].filter((key) => key.startsWith("bot:")).length;
    plan.skippedRooms = missing.size - plan.skippedBots;
    return plan;
}
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const named = (value) => record(value) && typeof value.id === "string" && typeof value.threadId === "string" &&
    (value.tasks === undefined || (Array.isArray(value.tasks) && value.tasks.every((task) => record(task) && typeof task.threadId === "string" && Number.isFinite(task.createdAt))));
/** The copy staged on this server, read only. */
export function stagedChats(data) {
    const roster = (name) => {
        try {
            const value = JSON.parse(readFileSync(join(data, name), "utf8"));
            return Array.isArray(value) ? value.filter(named) : [];
        }
        catch {
            return [];
        }
    };
    let db = null;
    try {
        if (lstatSync(join(data, "messages.db")).isFile())
            db = new DatabaseSync(join(data, "messages.db"), { readOnly: true });
    }
    catch { }
    const rowsOf = db?.prepare("SELECT json FROM messages WHERE thread_id = ? ORDER BY rowid");
    const leafOf = db && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thread_state'").get()
        ? db.prepare("SELECT active_leaf_id AS leaf FROM thread_state WHERE thread_id = ?") : undefined;
    return {
        bots: roster("bots.json"),
        groups: roster("groups.json"),
        thread(threadId) {
            const rows = [];
            let previous = null;
            for (const row of rowsOf?.all(threadId) ?? []) {
                let message;
                try {
                    message = JSON.parse(String(row.json));
                }
                catch {
                    continue;
                }
                if (!record(message) || typeof message.id !== "string" || !Number.isFinite(message.at))
                    continue;
                if (message.parentId === undefined)
                    message.parentId = previous;
                previous = message.id;
                rows.push(message);
            }
            const stored = leafOf?.get(threadId)?.leaf;
            return { rows, leaf: typeof stored === "string" && rows.some((row) => row.id === stored) ? stored : rows.at(-1)?.id ?? null };
        },
        close: () => db?.close(),
    };
}
export function liveChats(store) {
    return { bots: store.bots, groups: store.groups, thread: (threadId) => ({ rows: store.messagesFor(threadId), leaf: store.activeLeaf(threadId) }) };
}
/** The attachments in this computer's folder a row names, by file name. */
export function attachmentNames(message, source) {
    const root = `${source.replaceAll("\\", "/").replace(/\/$/, "")}/attachments/`;
    const fold = (value) => /^(?:[A-Za-z]:\/|\/\/)/.test(root) ? value.toLowerCase() : value;
    const paths = Array.isArray(message.attachments) ? message.attachments.map((attachment) => attachment?.path) : [];
    if (typeof message.text === "string" && message.text.includes("<attached-")) {
        const parsed = splitTranscriptAttachments(message.text, false);
        paths.push(...parsed.images.map((image) => image.path), ...parsed.files.map((file) => file.path));
    }
    return paths.flatMap((path) => {
        const value = typeof path === "string" ? path.replaceAll("\\", "/") : "";
        const name = fold(value.slice(0, root.length)) === fold(root) ? value.slice(root.length) : "";
        return ATTACHMENT_NAME.test(name) ? [name] : [];
    });
}
/** Never replaces a file already here: names are random, so one that exists is the same upload. */
function carryAttachment(data, dataDir, name) {
    const from = join(data, "attachments", name);
    try {
        if (!lstatSync(from).isFile())
            return false;
    }
    catch {
        return false;
    }
    mkdirSync(join(dataDir, "attachments"), { recursive: true, mode: 0o700 });
    try {
        copyFileSync(from, join(dataDir, "attachments", name), constants.COPYFILE_EXCL);
        chmodSync(join(dataDir, "attachments", name), 0o600);
        return true;
    }
    catch (error) {
        if (error.code === "EEXIST")
            return false;
        throw error;
    }
}
/** Owners first, so a conversation's rows never exist without its entry in the list. */
export function applyChatMerge(store, plan) {
    const tasks = new Map();
    for (const thread of plan.threads)
        if (thread.task)
            tasks.set(ownerKey(thread.owner), [...tasks.get(ownerKey(thread.owner)) ?? [], thread.task]);
    for (const bot of store.bots) {
        const added = tasks.get(`bot:${bot.id}`);
        if (added)
            store.patchBot(bot.id, { tasks: [...bot.tasks ?? [], ...added] });
    }
    for (const group of store.groups) {
        const added = tasks.get(`group:${group.id}`);
        if (added) {
            group.tasks = [...group.tasks ?? [], ...added];
            store.patchGroup(group.id, {});
        }
    }
    const touched = new Map();
    for (const thread of plan.threads) {
        store.importTranscript(thread.threadId, thread.added, thread.leaf, thread.task ? undefined : thread.relinked);
        if (!thread.task)
            touched.set(ownerKey(thread.owner), thread.owner);
        if (thread.outside && thread.owner.kind === "bot") {
            const task = store.bot(thread.owner.id)?.tasks?.find((one) => one.threadId === thread.threadId);
            if (task)
                task.outside = true;
        }
    }
    // Saves the conversations' new activity times and tells open apps about them; no message frame, so nothing is read aloud or notified.
    for (const owner of touched.values()) {
        if (owner.kind === "bot")
            store.patchBot(owner.id, {});
        else
            store.patchGroup(owner.id, {});
    }
}
/** Rebases the added rows' paths from the other computer's folder to this one's, then adds them. */
function applyFrom(store, dataDir, plan, sourceDataDir, carry) {
    const destination = resolve(dataDir), paths = restorePaths(sourceDataDir, destination);
    let copied = false;
    for (const thread of plan.threads)
        for (const message of thread.added) {
            if (carry)
                for (const name of attachmentNames(message, sourceDataDir))
                    copied = carry(name) || copied;
            if (sourceDataDir !== destination)
                paths.message(message);
        }
    if (copied)
        cleanupStaleAttachmentPartials();
    applyChatMerge(store, plan);
}
export function mergeStagedChats(store, dataDir, staged, syncedAt) {
    const from = stagedChats(staged.data);
    try {
        const plan = planChatMerge(from, liveChats(store), syncedAt);
        applyFrom(store, dataDir, plan, staged.sourceDataDir, (name) => carryAttachment(staged.data, dataDir, name));
        const { threads: _threads, ...result } = plan;
        return result;
    }
    finally {
        from.close();
    }
}
const listedIn = (owner, threadId) => owner.threadId === threadId || (owner.tasks ?? []).some((task) => task.threadId === threadId);
/** Only the sender knows what it sent before, so only its `sent` makes a conversation this server lacks one removed here. */
const removedHere = (store, conversation, listed) => conversation.sent && !listed && !store.messagesFor(conversation.threadId).length;
const sentThread = (conversation) => (threadId) => threadId === conversation.threadId ? { rows: conversation.rows, leaf: conversation.leaf } : { rows: [], leaf: null };
function botSide(store, conversation) {
    const bot = store.bot(conversation.bot);
    if (!bot)
        return "waiting";
    if (removedHere(store, conversation, listedIn(bot, conversation.threadId)))
        return "removed";
    const tasks = conversation.task ? [conversation.task] : [];
    return { bots: [{ id: bot.id, threadId: conversation.task ? bot.threadId : conversation.threadId, tasks }], groups: [], thread: sentThread(conversation) };
}
function roomSide(store, conversation) {
    let room = store.group(conversation.room);
    if (room?.dm)
        return "waiting";
    if (!room) {
        if (conversation.sent)
            return "removed";
        room = openRoom(store, conversation);
        if (!room)
            return "waiting";
    }
    else if (removedHere(store, conversation, listedIn(room, conversation.threadId)))
        return "removed";
    const tasks = conversation.task ? [conversation.task] : [];
    return { bots: [], groups: [{ id: room.id, threadId: conversation.task ? room.threadId : conversation.threadId, tasks, dm: false }], thread: sentThread(conversation) };
}
/** A room this server lacks and never had from the sender, made under the sender's ids with the members this server
 * has; its first thread is the conversation being sent. None while none of its bots is here. */
function openRoom(store, conversation) {
    const info = conversation.roomInfo;
    const members = (info?.memberIds ?? []).filter((id) => store.bot(id));
    if (!info || !members.length || [...conversations(liveChats(store))].some((entry) => entry.threadId === conversation.threadId))
        return undefined;
    const room = store.createGroup(info.name, members, false, typeof info.section === "string" ? info.section.slice(0, 60) || undefined : undefined, { bulletin: info.bulletin, defaultResponder: info.defaultResponder, completed: info.setupCompletedAt != null, id: conversation.room, threadId: conversation.threadId });
    const first = room.tasks?.find((task) => task.threadId === conversation.threadId);
    if (first && conversation.task)
        Object.assign(first, Object.fromEntries(GROUP_TASK_KEYS.filter((key) => conversation.task[key] !== undefined)
            .map((key) => [key, structuredClone(conversation.task[key])])));
    store.patchGroup(room.id, info.audienceFloor ? { audienceFloor: info.audienceFloor } : {});
    return room;
}
/**
 * Adds each sent conversation's rows the way a copy's are added (planChatMerge), one conversation at a time, so rows
 * one conversation shares never make another look deleted. Attachments arrived before, under their own names. Only the
 * sender knows what it sent before, so only its `sent` makes a conversation this server lacks one removed here. `owner`:
 * the owner's own session sent them, so the lines and answers its owner wrote, in a bot conversation or a room, arrive as
 * the owner's.
 */
export function addSentChats(store, dataDir, sourceDataDir, sent, { busy, owner = null }) {
    const result = { conversations: 0, messages: 0, accepted: [], waiting: [], removed: [] };
    for (const conversation of sent) {
        if (busy(conversation.threadId)) {
            result.waiting.push(conversation.threadId);
            continue;
        }
        const arriving = owner ? { ...conversation, rows: stampOwner(conversation.rows, owner) } : conversation;
        const from = conversation.room === undefined ? botSide(store, arriving) : roomSide(store, arriving);
        if (from === "waiting" || from === "removed") {
            result[from].push(conversation.threadId);
            continue;
        }
        const plan = planChatMerge(from, liveChats(store), Number.NEGATIVE_INFINITY, { keepSummaries: true });
        applyFrom(store, dataDir, plan, sourceDataDir);
        result.conversations += plan.conversations;
        result.messages += plan.messages;
        result.accepted.push(conversation.threadId);
    }
    return result;
}
