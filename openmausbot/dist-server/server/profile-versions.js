// Append-only per-bot profile history (0600, redacted); a history write never fails the change it records.
import { appendFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { PROFILE_REQUEST_FIELDS } from "../shared/profile-request.js";
import { botFolder, SOUL_FILE } from "./bot-folder.js";
import { unifiedDiff } from "./memory-journal.js";
import { redactSecrets } from "./redact.js";
const FILE_NAME = "history.ndjson";
const ONE_LINER = 200;
const MAX_HISTORY_READ_BYTES = 8 * 1024 * 1024;
const writeQueues = new Map();
export function historyFile(botId) {
    return join(botFolder(botId), FILE_NAME);
}
function oneLiner(value) {
    return value.replace(/\s+/g, " ").trim().slice(0, ONE_LINER);
}
function rowFor(field, at, actor, via, before, after) {
    if (field === "soul") {
        const b = Buffer.byteLength(before, "utf8");
        const a = Buffer.byteLength(after, "utf8");
        return { id: randomUUID(), at, actor, via, field, summary: `soul: ${b} → ${a} bytes`, before, after };
    }
    const b = oneLiner(before);
    const a = oneLiner(after);
    return { id: randomUUID(), at, actor, via, field, summary: `${field}: ${JSON.stringify(b)} → ${JSON.stringify(a)}`, before: b, after: a };
}
function withRestoreEligibility(row) {
    const redacted = redactSecrets(row);
    const canRestore = row.field === "soul" && typeof row.before === "string" &&
        row.canRestore !== false && row.before === redacted.before &&
        !/«redacted \d+ chars»/.test(row.before);
    return {
        ...redacted,
        canRestore,
        restoreUnavailableReason: row.field === "soul" && !canRestore
            ? "This version is missing exact text or contains redacted sensitive text and cannot be restored."
            : undefined,
    };
}
async function writeRows(botId, rows) {
    if (!existsSync(botFolder(botId)))
        return;
    const file = historyFile(botId);
    mkdirSync(botFolder(botId), { recursive: true, mode: 0o700 });
    const text = rows.map((row) => JSON.stringify(withRestoreEligibility(row))).join("\n") + "\n";
    await appendFile(file, text, { mode: 0o600 });
}
function queueHistoryRows(botId, rows) {
    if (!rows.length)
        return;
    const previous = writeQueues.get(botId) ?? Promise.resolve();
    const queued = previous.then(() => writeRows(botId, rows)).catch(() => {
    });
    writeQueues.set(botId, queued);
    void queued.finally(() => {
        if (writeQueues.get(botId) === queued)
            writeQueues.delete(botId);
    });
}
export function recordProfileChange(botId, actor, via, before, after) {
    const at = Date.now();
    const rows = [];
    const historyText = (value) => value === undefined ? "" : typeof value === "boolean" ? (value ? "on" : "off") : value;
    for (const field of PROFILE_REQUEST_FIELDS) {
        const b = before[field];
        const a = after[field];
        if (b !== a)
            rows.push(rowFor(field, at, actor, via, historyText(b), historyText(a)));
    }
    queueHistoryRows(botId, rows);
}
export async function flushProfileHistory(botId) {
    await writeQueues.get(botId);
}
export async function flushAllProfileHistory() {
    await Promise.allSettled(writeQueues.values());
}
const isRow = (value) => typeof value === "object" &&
    value !== null &&
    typeof value.at === "number" &&
    typeof value.field === "string" &&
    typeof value.actor === "string";
export function readHistory(botId, limit = 100) {
    let text;
    let offset;
    let end;
    try {
        const fd = openSync(historyFile(botId), "r");
        try {
            const size = fstatSync(fd).size;
            offset = Math.max(0, size - MAX_HISTORY_READ_BYTES);
            const buffer = Buffer.alloc(size - offset);
            let length = 0;
            while (length < buffer.length) {
                const count = readSync(fd, buffer, length, buffer.length - length, offset + length);
                if (!count)
                    break;
                length += count;
            }
            end = offset + length;
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
    const maxRows = Math.min(500, Math.max(1, limit));
    for (let index = lines.length - 1; index >= (offset > 0 ? 1 : 0) && rows.length < maxRows; index--) {
        const line = lines[index];
        end -= Buffer.byteLength(line, "utf8") + (index < lines.length - 1 ? 1 : 0);
        if (!line)
            continue;
        try {
            const value = JSON.parse(line);
            if (isRow(value)) {
                const id = typeof value.id === "string" && value.id
                    ? value.id
                    : `legacy-${createHash("sha256").update(`${end}:${line}`).digest("hex")}`;
                rows.push(withRestoreEligibility({ ...value, id }));
            }
        }
        catch {
        }
    }
    return rows;
}
const CHANGE_ACTOR = { user: "person", bot: "bot", file: "person", import: "import", system: "import" };
export function soulChanges(botId, rows) {
    return rows.filter((row) => row.field === "soul").map((row) => {
        const diff = unifiedDiff(row.before ?? "", row.after ?? "", SOUL_FILE);
        return {
            id: row.id, at: row.at, botId, path: SOUL_FILE, actor: CHANGE_ACTOR[row.actor] ?? "person",
            via: row.actor === "file" ? "disk" : row.via === "rollback" || row.via.startsWith("undo:") ? "revert" : row.via,
            kind: "edited", beforeHash: null, afterHash: null, diff: diff.text, added: diff.added, removed: diff.removed,
            canRevert: row.canRestore === true, ...(row.restoreUnavailableReason ? { revertUnavailableReason: row.restoreUnavailableReason } : {}),
        };
    });
}
