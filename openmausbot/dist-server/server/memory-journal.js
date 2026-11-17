// Kept outside the workspace on purpose: an audit trail the audited bot can rewrite is not an audit trail.
// A journal write must never fail the change it records.
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { DATA_DIR } from "./config.js";
import { MEMORY_INDEX, MemoryStoreError, deleteMemoryDoc, hashMemoryText, readMemoryDoc, writeMemoryDoc, } from "./memory-store.js";
import { redactSecretsInText } from "./redact.js";
import { memoryFilesOnDisk, readMemoryText, workspaceDir } from "./workspace.js";
export const JOURNAL_DIR = join(DATA_DIR, "memory-journal");
export const DIFF_CAP = 8_000;
export const BEFORE_CAP = 512 * 1024;
const MAX_JOURNAL_READ_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 500;
const LCS_CELL_CAP = 4_000_000;
const CONTEXT = 2;
export function journalFile(botId) {
    return join(JOURNAL_DIR, `${botId}.ndjson`);
}
function editScript(fullA, fullB) {
    if (fullA.length * fullB.length > LCS_CELL_CAP) {
        return [...fullA.map((line) => ({ tag: "-", line })), ...fullB.map((line) => ({ tag: "+", line }))];
    }
    let shared = 0;
    while (shared < fullA.length && shared < fullB.length && fullA[shared] === fullB[shared])
        shared++;
    const ops = fullA.slice(0, shared).map((line) => ({ tag: " ", line }));
    const a = fullA.slice(shared);
    const b = fullB.slice(shared);
    const rows = a.length + 1;
    const cols = b.length + 1;
    const table = new Uint32Array(rows * cols);
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            table[i * cols + j] = a[i] === b[j]
                ? table[(i + 1) * cols + j + 1] + 1
                : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
        }
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            ops.push({ tag: " ", line: a[i] });
            i++;
            j++;
        }
        else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
            ops.push({ tag: "-", line: a[i++] });
        }
        else {
            ops.push({ tag: "+", line: b[j++] });
        }
    }
    while (i < a.length)
        ops.push({ tag: "-", line: a[i++] });
    while (j < b.length)
        ops.push({ tag: "+", line: b[j++] });
    return ops;
}
function splitLines(text) {
    if (text === "")
        return [];
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "")
        lines.pop();
    return lines;
}
export function unifiedDiff(before, after, path, cap = DIFF_CAP) {
    if (before === after)
        return { text: "", added: 0, removed: 0, truncated: false };
    const ops = editScript(splitLines(before), splitLines(after));
    let added = 0;
    let removed = 0;
    for (const op of ops) {
        if (op.tag === "+")
            added++;
        else if (op.tag === "-")
            removed++;
    }
    const changes = [];
    ops.forEach((op, k) => {
        if (op.tag !== " ")
            changes.push(k);
    });
    const hunks = [];
    let index = 0;
    while (index < changes.length) {
        let lastChange = changes[index];
        let next = index + 1;
        while (next < changes.length && changes[next] - lastChange <= CONTEXT * 2 + 1)
            lastChange = changes[next++];
        hunks.push({ start: Math.max(0, changes[index] - CONTEXT), end: Math.min(ops.length - 1, lastChange + CONTEXT) });
        index = next;
    }
    const lines = [`--- a/${path}`, `+++ b/${path}`];
    let oldLine = 1;
    let newLine = 1;
    let cursor = 0;
    for (const hunk of hunks) {
        for (; cursor < hunk.start; cursor++) {
            if (ops[cursor].tag !== "+")
                oldLine++;
            if (ops[cursor].tag !== "-")
                newLine++;
        }
        const slice = ops.slice(hunk.start, hunk.end + 1);
        const oldCount = slice.filter((op) => op.tag !== "+").length;
        const newCount = slice.filter((op) => op.tag !== "-").length;
        // an empty side is conventionally anchored on the line before it
        lines.push(`@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@`);
        for (const op of slice)
            lines.push(`${op.tag}${op.line}`);
        for (; cursor <= hunk.end; cursor++) {
            if (ops[cursor].tag !== "+")
                oldLine++;
            if (ops[cursor].tag !== "-")
                newLine++;
        }
    }
    let text = lines.join("\n");
    let truncated = false;
    if (text.length > cap) {
        text = `${text.slice(0, cap)}\n… (diff cut here)`;
        truncated = true;
    }
    return { text, added, removed, truncated };
}
const writeQueues = new Map();
function enqueue(botId, entry) {
    const previous = writeQueues.get(botId) ?? Promise.resolve();
    const queued = previous
        .then(async () => {
        mkdirSync(JOURNAL_DIR, { recursive: true, mode: 0o700 });
        await appendFile(journalFile(botId), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    })
        .catch((error) => {
        console.error(`memory-journal: could not append for ${botId}:`, error instanceof Error ? error.message : error);
    });
    writeQueues.set(botId, queued);
    void queued.finally(() => {
        if (writeQueues.get(botId) === queued)
            writeQueues.delete(botId);
    });
}
export async function flushMemoryJournal(botId) {
    await writeQueues.get(botId);
}
export async function flushAllMemoryJournals() {
    await Promise.allSettled(writeQueues.values());
}
function isEntry(value) {
    if (typeof value !== "object" || value === null)
        return false;
    // SAFETY: shape probe on a parsed JSON line; the fields the panel keys on are checked below
    const row = value;
    return typeof row.id === "string" && typeof row.at === "number" && typeof row.path === "string" && typeof row.kind === "string";
}
/** Another server's changes to this bot's memory, by id, in time order among this server's own: they describe that
 * server's files, so none of them can be reverted here. How many were added. */
export async function adoptMemoryJournal(botId, entries) {
    await flushMemoryJournal(botId);
    const held = readMemoryJournal(botId, MAX_ROWS);
    const ids = new Set(held.map((entry) => entry.id));
    const added = entries.filter((entry) => isEntry(entry) && !ids.has(entry.id)).map((entry) => ({ ...entry, botId, before: null, canRevert: false,
        revertUnavailableReason: "This change was made on another computer, so it cannot be reverted here." }));
    if (!added.length)
        return 0;
    let kept = "";
    try {
        kept = readFileSync(journalFile(botId), "utf8");
    }
    catch { }
    const rows = [...kept.split("\n").filter(Boolean), ...added.map((entry) => JSON.stringify(entry))];
    const at = (line) => { try {
        return Number(JSON.parse(line).at) || 0;
    }
    catch {
        return 0;
    } };
    mkdirSync(JOURNAL_DIR, { recursive: true, mode: 0o700 });
    writeFileAtomic(journalFile(botId), `${rows.map((line, index) => ({ line, index, at: at(line) })).sort((a, b) => a.at - b.at || a.index - b.index).map((row) => row.line).join("\n")}\n`, { mode: 0o600 });
    return added.length;
}
export function readMemoryJournal(botId, limit = 50) {
    let text;
    let offset;
    try {
        const fd = openSync(journalFile(botId), "r");
        try {
            const size = fstatSync(fd).size;
            offset = Math.max(0, size - MAX_JOURNAL_READ_BYTES);
            const buffer = Buffer.alloc(size - offset);
            let length = 0;
            while (length < buffer.length) {
                const count = readSync(fd, buffer, length, buffer.length - length, offset + length);
                if (!count)
                    break;
                length += count;
            }
            text = buffer.subarray(0, length).toString("utf8");
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        return [];
    }
    const rows = [];
    const lines = text.split("\n");
    const maxRows = Math.min(MAX_ROWS, Math.max(1, limit));
    for (let index = lines.length - 1; index >= (offset > 0 ? 1 : 0) && rows.length < maxRows; index--) {
        const line = lines[index];
        if (!line)
            continue;
        try {
            const value = JSON.parse(line);
            if (isEntry(value))
                rows.push(value);
        }
        catch {
        }
    }
    return rows;
}
const baselines = new Map();
// Same trade as the search index: a same-size edit within the same millisecond of mtime is missed.
const baselineStats = new Map();
function baselineFor(botId) {
    let baseline = baselines.get(botId);
    if (!baseline) {
        baseline = new Map();
        baselines.set(botId, baseline);
    }
    return baseline;
}
function advanceBaseline(botId, path, after) {
    const baseline = baselineFor(botId);
    if (after === null)
        baseline.delete(path);
    else
        baseline.set(path, after);
}
export function recordMemoryChange(botId, change) {
    const { before, after } = change;
    if (before === after)
        return null;
    advanceBaseline(botId, change.path, after);
    const kind = before === null ? "created" : after === null ? "deleted" : "edited";
    const diff = unifiedDiff(before ?? "", after ?? "", change.path);
    let keptBefore = null;
    let canRevert = true;
    let revertUnavailableReason;
    if (before !== null) {
        if (Buffer.byteLength(before, "utf8") > BEFORE_CAP) {
            canRevert = false;
            revertUnavailableReason = "The earlier version was too large to keep, so this change cannot be reverted.";
        }
        else {
            keptBefore = redactSecretsInText(before);
            if (keptBefore !== before) {
                canRevert = false;
                revertUnavailableReason = "The earlier version contained sensitive text that was hidden, so it cannot be restored exactly.";
            }
        }
    }
    const entry = {
        id: randomUUID(),
        at: Date.now(),
        botId,
        path: change.path,
        actor: change.actor,
        via: change.via,
        kind,
        beforeHash: before === null ? null : hashMemoryText(before),
        afterHash: after === null ? null : hashMemoryText(after),
        before: keptBefore,
        diff: redactSecretsInText(diff.text),
        added: diff.added,
        removed: diff.removed,
        canRevert,
    };
    if (change.threadId)
        entry.threadId = change.threadId;
    if (revertUnavailableReason)
        entry.revertUnavailableReason = revertUnavailableReason;
    enqueue(botId, entry);
    return entry;
}
export function journalMemoryWrite(botId, path, text, opts) {
    const result = writeMemoryDoc(botId, path, text, { expectedHash: opts.expectedHash });
    const entry = recordMemoryChange(botId, {
        path,
        actor: opts.actor,
        via: opts.via,
        threadId: opts.threadId,
        before: result.before,
        after: result.after,
    });
    return { doc: { path, text: result.after, hash: result.hash, exists: true }, entry };
}
export function journalMemoryDelete(botId, path, opts) {
    const result = deleteMemoryDoc(botId, path);
    return recordMemoryChange(botId, { path, actor: opts.actor, via: opts.via, threadId: opts.threadId, before: result.before, after: null });
}
export function revertMemoryChange(botId, entryId, opts = {}) {
    const entry = readMemoryJournal(botId, MAX_ROWS).find((row) => row.id === entryId);
    if (!entry)
        return { ok: false, status: 404, error: "no such memory change" };
    if (!entry.canRevert)
        return { ok: false, status: 400, error: entry.revertUnavailableReason ?? "this change cannot be reverted" };
    try {
        if (entry.kind === "created") {
            if (entry.path === MEMORY_INDEX) {
                const written = journalMemoryWrite(botId, entry.path, "", { actor: "person", via: "revert", threadId: opts.threadId });
                return { ok: true, entry: written.entry, doc: written.doc };
            }
            const removed = journalMemoryDelete(botId, entry.path, { actor: "person", via: "revert", threadId: opts.threadId });
            return { ok: true, entry: removed, doc: { path: entry.path, text: "", hash: hashMemoryText(""), exists: false } };
        }
        const written = journalMemoryWrite(botId, entry.path, entry.before ?? "", { actor: "person", via: "revert", threadId: opts.threadId });
        return { ok: true, entry: written.entry, doc: written.doc };
    }
    catch (error) {
        if (error instanceof MemoryStoreError)
            return { ok: false, status: error.status, error: error.message };
        throw error;
    }
}
const turnBots = new Map();
function statsFor(botId) {
    let stats = baselineStats.get(botId);
    if (!stats) {
        stats = new Map();
        baselineStats.set(botId, stats);
    }
    return stats;
}
function currentDocs(botId) {
    const docs = new Map();
    const stats = statsFor(botId);
    const baseline = baselines.get(botId);
    const seen = new Set();
    for (const file of memoryFilesOnDisk(botId)) {
        seen.add(file.path);
        const mtimeMs = Math.trunc(file.mtimeMs);
        const cached = stats.get(file.path);
        const known = baseline?.get(file.path);
        if (cached && known !== undefined && cached.bytes === file.bytes && cached.mtimeMs === mtimeMs) {
            docs.set(file.path, known);
            continue;
        }
        let text;
        try {
            text = readMemoryText(join(workspaceDir(botId), file.path));
        }
        catch {
            if (known !== undefined)
                docs.set(file.path, known);
            continue;
        }
        docs.set(file.path, text);
        stats.set(file.path, { mtimeMs, bytes: file.bytes });
    }
    for (const path of stats.keys()) {
        if (!seen.has(path))
            stats.delete(path);
    }
    return docs;
}
function reconcile(botId, actor, via, threadId, unknownIsNew) {
    const baseline = baselineFor(botId);
    const docs = currentDocs(botId);
    const rows = [];
    for (const [path, text] of docs) {
        const known = baseline.get(path);
        if (known === text)
            continue;
        if (known === undefined && !unknownIsNew) {
            baseline.set(path, text);
            continue;
        }
        const row = recordMemoryChange(botId, { path, actor, via, threadId, before: known ?? null, after: text });
        if (row)
            rows.push(row);
    }
    // deleting the current key mid-iteration is defined for a Map
    for (const path of baseline.keys()) {
        if (docs.has(path))
            continue;
        const row = recordMemoryChange(botId, { path, actor, via, threadId, before: baseline.get(path) ?? null, after: null });
        if (row)
            rows.push(row);
    }
    return rows;
}
export function beginMemoryTurn(botId, threadId) {
    try {
        let bots = turnBots.get(threadId);
        if (!bots) {
            bots = new Set();
            turnBots.set(threadId, bots);
        }
        bots.add(botId);
        reconcile(botId, "person", "disk", undefined, false);
    }
    catch (error) {
        console.error(`memory-journal: could not snapshot ${botId}:`, error instanceof Error ? error.message : error);
    }
}
export function endMemoryTurn(threadId) {
    const bots = turnBots.get(threadId);
    if (!bots)
        return [];
    turnBots.delete(threadId);
    const rows = [];
    for (const botId of bots) {
        try {
            rows.push(...reconcile(botId, "bot", "turn", threadId, true));
        }
        catch (error) {
            console.error(`memory-journal: could not diff ${botId}:`, error instanceof Error ? error.message : error);
        }
    }
    return rows;
}
/** Lands after the turn's boundary diff, so without its own row the next turn would credit it to the person. */
export function journalTurnWrite(botId, path, threadId, write) {
    let before;
    try {
        const doc = readMemoryDoc(botId, path);
        before = doc.exists ? doc.text : null;
    }
    catch (error) {
        console.error(`memory-journal: could not read ${path} for ${botId}:`, error instanceof Error ? error.message : error);
    }
    const result = write();
    if (before === undefined)
        return result;
    try {
        const after = readMemoryDoc(botId, path);
        if (after.exists)
            recordMemoryChange(botId, { path, actor: "bot", via: "turn", threadId, before, after: after.text });
    }
    catch (error) {
        console.error(`memory-journal: could not record ${path} for ${botId}:`, error instanceof Error ? error.message : error);
    }
    return result;
}
export function resetMemoryJournalState() {
    baselines.clear();
    baselineStats.clear();
    turnBots.clear();
}
export function forgetBotMemoryJournal(botId) {
    baselines.delete(botId);
    baselineStats.delete(botId);
    for (const [threadId, bots] of turnBots) {
        if (!bots.delete(botId))
            continue;
        if (bots.size === 0)
            turnBots.delete(threadId);
    }
}
