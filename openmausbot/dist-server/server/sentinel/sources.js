// SQLite opens read-only, never `immutable`: both databases run in WAL mode and recent rows live in the -wal file,
// which immutable skips. Handles close after each short query so a scan never blocks the app's checkpoint.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HARNESS_NOTICE, isToolIdentifier } from "./normalize.js";
const MAX_TEXT = 2_000;
/** A log never read before is read from at most this far from its end. */
const FIRST_READ_BYTES = 8 * 1024 * 1024;
export function withReadOnlyDb(file, read) {
    if (!existsSync(file))
        return null;
    const db = new DatabaseSync(file, { readOnly: true, timeout: 2_000 });
    try {
        return read(db);
    }
    finally {
        db.close();
    }
}
export function readThreadOwners(dataDir) {
    const owners = new Map();
    const names = [];
    let bots;
    try {
        bots = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
    }
    catch {
        return { owners, names };
    }
    if (!Array.isArray(bots))
        return { owners, names };
    for (const bot of bots) {
        if (typeof bot?.id !== "string")
            continue;
        if (typeof bot.name === "string" && bot.name.trim())
            names.push(bot.name);
        if (typeof bot.threadId === "string")
            owners.set(bot.threadId, bot.id);
        if (Array.isArray(bot.tasks)) {
            for (const task of bot.tasks) {
                if (typeof task?.threadId === "string")
                    owners.set(task.threadId, bot.id);
            }
        }
    }
    return { owners, names };
}
/** Activity rows are UPDATEd when a tool finishes, so this rereads an `at` window instead of keeping a rowid cursor. */
export function readToolRecords(dataDir, sinceAt, who) {
    const rows = withReadOnlyDb(join(dataDir, "messages.db"), (db) => {
        const threads = db.prepare("SELECT DISTINCT thread_id FROM messages").all();
        // messages_thread_at serves each of these; json_extract keeps the
        // successful calls, nearly all of them, from crossing into JS at all.
        const failed = db.prepare(`SELECT thread_id, id, at, json FROM messages
      WHERE thread_id = ? AND at >= ? AND kind = 'activity' AND json_extract(json, '$.tool.ok') = 0`);
        return threads.flatMap(({ thread_id }) => failed.all(thread_id, sinceAt));
    }) ?? [];
    rows.sort((a, b) => a.at - b.at);
    const records = [];
    for (const row of rows) {
        let message;
        try {
            message = JSON.parse(row.json);
        }
        catch {
            continue;
        }
        const name = message.tool?.name ?? "";
        const notice = !isToolIdentifier(name);
        const text = notice ? withoutNames(name, who.names) : (message.tool?.output ?? message.tool?.summary ?? "");
        const botId = message.from?.botId ?? who.owners.get(row.thread_id);
        records.push({
            type: "tool", id: row.id, threadId: row.thread_id, at: Number(row.at), ok: false,
            tool: notice ? HARNESS_NOTICE : name, text: text.slice(0, MAX_TEXT),
            ...(message.turnId ? { turnId: message.turnId } : {}),
            ...(botId ? { botId } : {}),
        });
    }
    return records;
}
function withoutNames(text, names) {
    let out = text;
    // longest first, so "Editor 10" is not left as "<bot>0"
    for (const name of [...names].sort((a, b) => b.length - a.length))
        out = out.split(name).join("<bot>");
    return out;
}
export function readTurnRecords(dataDir, previous, who) {
    const dir = join(dataDir, "events");
    const offsets = {};
    const records = [];
    let files;
    try {
        files = readdirSync(dir).filter((name) => name.endsWith(".ndjson"));
    }
    catch {
        return { records, offsets };
    }
    for (const name of files) {
        const read = readLogTail(join(dir, name), previous[name]);
        if (!read)
            continue;
        offsets[name] = read.offset;
        const threadId = name.slice(0, -".ndjson".length);
        for (const line of read.lines) {
            if (!line.includes('"turn.completed"'))
                continue;
            let event;
            try {
                event = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (event.type !== "turn.completed" || typeof event.eventId !== "string")
                continue;
            const at = Date.parse(event.createdAt ?? "");
            if (!Number.isFinite(at))
                continue;
            if (at <= read.skipThrough)
                continue;
            read.offset.hwm = Math.max(read.offset.hwm, at);
            const thread = event.threadId ?? threadId;
            const botId = who.owners.get(thread);
            records.push({
                type: "turn", id: event.eventId, threadId: thread, at, ok: event.ok !== false,
                stopReason: typeof event.stopReason === "string" ? event.stopReason : null,
                cost: typeof event.cost === "number" && Number.isFinite(event.cost) ? event.cost : null,
                ...(event.turnId ? { turnId: event.turnId } : {}),
                ...(botId ? { botId } : {}),
            });
        }
    }
    return { records, offsets };
}
/** From the start when the file was replaced or truncated; null when it cannot be read. */
export function readLogTail(file, previous) {
    let fd;
    try {
        fd = openSync(file, "r");
    }
    catch {
        return null;
    }
    try {
        const { size, ino } = statSync(file);
        const continues = previous !== undefined && previous.ino === ino && previous.offset <= size;
        const start = continues ? previous.offset : previous ? 0 : Math.max(0, size - FIRST_READ_BYTES);
        // a rewritten file starts over at 0; its kept tail was read before
        const skipThrough = continues ? -Infinity : previous?.hwm ?? -Infinity;
        const offset = { ino, offset: start, hwm: previous?.hwm ?? 0 };
        if (size === start)
            return { lines: [], offset, skipThrough };
        const buffer = Buffer.allocUnsafe(size - start);
        let filled = 0;
        while (filled < buffer.length) {
            const count = readSync(fd, buffer, filled, buffer.length - filled, start + filled);
            if (count === 0)
                break;
            filled += count;
        }
        // only whole lines: a half-written record is read next time
        const end = buffer.lastIndexOf(0x0a, filled - 1);
        if (end === -1)
            return { lines: [], offset, skipThrough };
        let text = buffer.subarray(0, end + 1).toString("utf8");
        // a first read that began mid-file drops its partial first line
        if (!previous && start > 0)
            text = text.slice(text.indexOf("\n") + 1);
        offset.offset = start + end + 1;
        return { lines: text.split("\n").filter(Boolean), offset, skipThrough };
    }
    finally {
        closeSync(fd);
    }
}
/** A wait runs from `enqueued` or `resume_due` to the next `started`; one not started yet reports the time so far. */
export function readQueueRecords(dataDir, sinceAt, now, who) {
    const rows = withReadOnlyDb(join(dataDir, "runtime.db"), (db) => db.prepare(`
    SELECT e.id AS eid, e.assignment_id AS aid, e.at, e.kind, a.status, a.assignee_bot_id AS bot, a.assignee_thread_id AS thread
    FROM assignment_events e JOIN assignments a ON a.id = e.assignment_id
    WHERE e.kind IN ('enqueued', 'resume_due', 'started')
      AND (a.status IN ('queued', 'resume') OR e.assignment_id IN (SELECT assignment_id FROM assignment_events WHERE at >= ?))
    ORDER BY e.assignment_id, e.id`).all(sinceAt)) ?? [];
    const records = [];
    const pending = (wait) => {
        if (wait && (wait.status === "queued" || wait.status === "resume"))
            records.push(queueRecord(wait, now, false, who));
    };
    let waiting = null;
    for (const row of rows) {
        if (waiting && waiting.aid !== row.aid) {
            pending(waiting);
            waiting = null;
        }
        if (row.kind !== "started")
            waiting = row;
        else {
            if (waiting && Number(row.at) >= sinceAt)
                records.push(queueRecord(waiting, Number(row.at), true, who));
            waiting = null;
        }
    }
    pending(waiting);
    return records;
}
function queueRecord(wait, end, started, who) {
    const botId = wait.bot || who.owners.get(wait.thread);
    return {
        type: "queue", id: `${wait.aid}:${wait.eid}`, assignmentId: wait.aid, threadId: wait.thread, at: end, waitMs: Math.max(0, end - Number(wait.at)), started,
        ...(botId ? { botId } : {}),
    };
}
