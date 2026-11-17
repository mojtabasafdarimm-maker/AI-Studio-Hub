import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.js";
import { personKey } from "../person-key.js";
const ROOM_READS_FILE = "room-reads.json";
const fileSchema = z.object({ version: z.literal(1), reads: z.record(z.string(), z.record(z.string(), z.string())) });
const NOT_A_REPLY = new Set(["activity", "screen", "digest", "compaction"]);
const isReply = (message) => message.role === "bot" && !NOT_A_REPLY.has(message.kind ?? "text");
/** Unread for a person: a bot replied after where they read up to; with no line yet, the room's own mark. A line no
 * longer on the path (an edit or a retry moved it) reads up to the last message at or before it; `atOf` gives its time. */
export function roomUnreadFor(path, readUpTo, roomUnread, atOf) {
    if (readUpTo === undefined)
        return roomUnread;
    let from = path.findIndex((message) => message.id === readUpTo) + 1;
    if (from === 0) {
        const readAt = atOf?.(readUpTo);
        if (readAt === undefined)
            return false;
        from = path.findLastIndex((message) => (message.at ?? 0) <= readAt) + 1;
    }
    return path.slice(from).some(isReply);
}
/** `alsoForget`: a person's other marks of their own (their bots' order, their notification reads), which go with
 * their read lines when they leave the team. */
export function createRoomReads(dataDir, alsoForget) {
    const file = join(dataDir, ROOM_READS_FILE);
    let reads = {};
    try {
        const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
        if (parsed.success)
            reads = parsed.data.reads;
        else
            console.warn(`room reads: ${file} is not a room reads file; starting fresh`);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            console.warn(`room reads: ${file} is unreadable; starting fresh`);
    }
    const save = () => {
        try {
            writeFileAtomic(file, `${JSON.stringify({ version: 1, reads })}\n`, { mode: 0o600 });
        }
        catch (error) {
            console.warn(`room reads: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    const key = (groupId, threadId) => threadId ? `${groupId}/${threadId}` : groupId;
    return {
        readUpTo: (groupId, person, threadId) => reads[key(groupId, threadId)]?.[person],
        read(groupId, person, messageId, threadId) {
            const bucket = key(groupId, threadId);
            if (reads[bucket]?.[person] === messageId)
                return;
            (reads[bucket] ??= {})[person] = messageId;
            save();
        },
        forget(groupId, person, threadId) {
            const bucket = key(groupId, threadId);
            if (reads[bucket]?.[person] === undefined)
                return;
            delete reads[bucket][person];
            save();
        },
        forgetRoom(groupId) {
            const buckets = Object.keys(reads).filter((bucket) => bucket === groupId || bucket.startsWith(`${groupId}/`));
            if (!buckets.length)
                return;
            for (const bucket of buckets)
                delete reads[bucket];
            save();
        },
        forgetPerson(person) {
            alsoForget?.(person);
            const rooms = Object.values(reads).filter((room) => room[person] !== undefined);
            if (!rooms.length)
                return;
            for (const room of rooms)
                delete room[person];
            save();
        },
    };
}
/** A bot's shared conversation's key in `room-reads.json`, apart from every room's id. */
export const threadReadKey = (threadId) => `thread:${threadId}`;
/** Each person's view of a room (server/index.ts): its unread mark and read line as they read it, on a Team Cloud. */
export function createPersonRooms(deps) {
    const { reads } = deps;
    const atOf = (threadId) => (id) => deps.store().messagesFor(threadId).find((message) => message.id === id)?.at;
    /** A room's unread mark and read line as this person has read it, on a Team Cloud; the room as it is anywhere else. */
    function groupForPerson(group, person) {
        if (!reads || !person)
            return group;
        const currentPath = deps.store().activePath(group.threadId);
        const legacyRead = reads.readUpTo(group.id, person);
        const currentRead = reads.readUpTo(group.id, person, group.threadId)
            ?? (legacyRead && currentPath.some((message) => message.id === legacyRead) ? legacyRead : undefined);
        const tasks = group.tasks?.map((task) => {
            const path = deps.store().activePath(task.threadId);
            const readUpTo = task.threadId === group.threadId ? currentRead : reads.readUpTo(group.id, person, task.threadId);
            const unread = roomUnreadFor(path, readUpTo, task.unread ?? false, atOf(task.threadId));
            return { ...task, unread };
        });
        const unread = tasks ? tasks.some((task) => task.unread) : roomUnreadFor(currentPath, currentRead, group.unread, atOf(group.threadId));
        if (unread === group.unread && currentRead === group.lastReadMessageId &&
            (!tasks || tasks.every((task, index) => task.unread === group.tasks?.[index]?.unread)))
            return group;
        const { lastReadMessageId: _shared, ...rest } = group;
        return { ...rest, tasks, unread, ...(currentRead ? { lastReadMessageId: currentRead } : {}) };
    }
    /** A bot's shared conversation's unread mark and read line as this person read it, on a Team Cloud; the task as it is
     * anywhere else and for a private chat. Nobody's read line but their own goes out. */
    function taskForPerson(task, person) {
        if (!reads || !deps.shared(task.threadId))
            return task;
        const readUpTo = reads.readUpTo(threadReadKey(task.threadId), person);
        const unread = roomUnreadFor(deps.store().activePath(task.threadId), readUpTo, task.unread === true, atOf(task.threadId));
        if (unread === (task.unread === true) && readUpTo === task.lastReadMessageId)
            return task;
        const { lastReadMessageId: _shared, ...rest } = task;
        return { ...rest, unread, ...(readUpTo ? { lastReadMessageId: readUpTo } : {}) };
    }
    return {
        reads,
        groupForPerson,
        taskForPerson,
        /** A deleted room's or conversation's read lines go with it. */
        forgetDeleted(change) {
            if (change.type === "group.deleted" && change.groupId)
                reads?.forgetRoom(change.groupId);
            else if (change.type === "thread.deleted" && change.threadId)
                reads?.forgetRoom(threadReadKey(change.threadId));
        },
        groupForAuth: (auth, group) => groupForPerson(group, auth.kind === "session" ? personKey(auth.session) : null),
        /** A `group` frame as `person`'s own room (`frameOf` writes the stream's frame for a payload), kept in `ownGroups` for
         * the rest of that frame's streams; null when it is the room as it is. */
        ownGroupFrame(ownGroups, person, payload, frameOf) {
            if (!reads || payload.kind !== "group")
                return null;
            if (!ownGroups.has(person)) {
                const group = payload.group;
                const own = groupForPerson(group, person);
                const ownPayload = { ...payload, group: own };
                ownGroups.set(person, own === group ? null : { payload: ownPayload, frame: frameOf(ownPayload) });
            }
            return ownGroups.get(person) ?? null;
        },
        /** Marks a room read or unread for the person signed in (server/routes/channels.ts `personMarkRoom`), told to their
         * streams alone; absent anywhere but a Team Cloud. */
        ...(reads ? { personMarkRoom: (auth, room, unread, threadId = room.threadId) => {
                if (auth.kind !== "session")
                    return null;
                const person = personKey(auth.session);
                const newest = deps.newestMessageId(threadId);
                if (unread) {
                    reads.forget(room.id, person, threadId);
                    if (threadId === room.threadId)
                        reads.forget(room.id, person);
                }
                else if (newest)
                    reads.read(room.id, person, newest, threadId);
                const group = deps.publicGroupState(room);
                deps.broadcast({ kind: "group", group }, { person });
                return groupForPerson(group, person);
            },
            /** Marks a bot's shared conversation read or unread for the person signed in, told to their streams alone; false for
             * a private chat, which keeps its one mark. Unread reads up to just before the conversation's newest reply. */
            personMarkThread: (auth, threadId, unread) => {
                if (auth.kind !== "session" || !deps.shared(threadId))
                    return false;
                const person = personKey(auth.session), key = threadReadKey(threadId);
                if (unread) {
                    const path = deps.store().activePath(threadId), reply = path.findLastIndex(isReply);
                    if (reply > 0)
                        reads.read(key, person, path[reply - 1].id);
                    else
                        reads.forget(key, person);
                }
                else {
                    const newest = deps.newestMessageId(threadId);
                    if (newest)
                        reads.read(key, person, newest);
                }
                const bot = deps.store().botByThread(threadId), frame = bot ? deps.wireBot(bot.id) : null;
                if (frame)
                    deps.broadcast({ kind: "bot", bot: frame }, { person });
                return true;
            } } : {}),
    };
}
