// Append-only usage rows under <data>/usage/ (0600): bookkeeping never fails the turn, and rows never carry message text.
import { personOf } from "./usage-attribution.js";
import { readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { billableFor } from "./prices.js";
export const USAGE_GROUPINGS = ["bot", "model", "user", "day", "engine", "routine", "department"];
export const USAGE_SPLITS = ["model"];
const DIR = "usage";
const MAX_RANGE_DAYS = 366;
const DAY_MS = 24 * 60 * 60_000;
const writeQueues = new Map();
const clean = (value) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
const finiteOrNull = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const promptBytesOf = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const record = value;
    return typeof record.stable === "number" && typeof record.volatile === "number"
        ? { stable: clean(record.stable), volatile: clean(record.volatile) }
        : null;
};
export function monthKey(at) {
    return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}
export function usageFileFor(dataDir, at) {
    return join(dataDir, DIR, `${monthKey(at)}.jsonl`);
}
export function usageRowKey(row) {
    return `${row.at}|${row.threadId}|${row.botId}`;
}
export function appendUsage(dataDir, row) {
    const { promptBytes: rawPromptBytes, ...rest } = row;
    const promptBytes = promptBytesOf(rawPromptBytes);
    const record = {
        ...rest,
        at: row.at ?? new Date().toISOString(),
        input: clean(row.input),
        output: clean(row.output),
        ...(typeof row.cachedInput === "number" ? { cachedInput: clean(row.cachedInput) } : {}),
        ...(promptBytes ? { promptBytes } : {}),
        costUsd: finiteOrNull(row.costUsd),
    };
    if (record.costUsd === null)
        delete record.costSource;
    else
        record.costSource = row.costSource === "estimated" ? "estimated" : "reported";
    const previous = writeQueues.get(dataDir) ?? Promise.resolve();
    const attempt = previous.then(() => write(dataDir, record));
    const queued = attempt.then(() => undefined, () => {
    });
    writeQueues.set(dataDir, queued);
    void queued.finally(() => {
        if (writeQueues.get(dataDir) === queued)
            writeQueues.delete(dataDir);
    });
    return attempt.then(() => true, () => false);
}
async function write(dataDir, record) {
    await mkdir(join(dataDir, DIR), { recursive: true, mode: 0o700 });
    await appendFile(usageFileFor(dataDir, new Date(record.at)), JSON.stringify(record) + "\n", { mode: 0o600 });
}
export async function flushUsageLedger(dataDir) {
    await writeQueues.get(dataDir);
}
const isTrigger = (value) => typeof value === "object" && value !== null && typeof value.kind === "string";
export const isUsageRow = (value) => typeof value === "object" &&
    value !== null &&
    typeof value.at === "string" &&
    typeof value.botId === "string" &&
    typeof value.model === "string" &&
    typeof value.input === "number" &&
    typeof value.output === "number" &&
    isTrigger(value.trigger);
export function monthsBetween(from, to) {
    const keys = [];
    const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
    while (cursor.getTime() <= to.getTime()) {
        keys.push(monthKey(cursor));
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return keys;
}
export function readUsage(dataDir, range) {
    const rows = [];
    const from = range.from.getTime();
    const to = range.to.getTime();
    for (const key of monthsBetween(range.from, range.to)) {
        let text;
        try {
            text = readFileSync(join(dataDir, DIR, `${key}.jsonl`), "utf8");
        }
        catch {
            continue;
        }
        for (const line of text.split("\n")) {
            if (!line)
                continue;
            try {
                const value = JSON.parse(line);
                if (!isUsageRow(value))
                    continue;
                const at = Date.parse(value.at);
                if (at >= from && at <= to)
                    rows.push(value);
            }
            catch {
            }
        }
    }
    return rows;
}
export function parseUsageRange(from, to, now = new Date()) {
    const day = /^(\d{4})-(\d{2})-(\d{2})$/;
    const parse = (value, endOfDay) => {
        const match = day.exec(value);
        if (!match)
            return null;
        const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0));
        // Reject 2026-02-31 style rollovers.
        return date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]) ? date : null;
    };
    const start = from ? parse(from, false) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = to ? parse(to, true) : now;
    if (!start || !end || start.getTime() > end.getTime())
        return null;
    if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY_MS)
        return null;
    return { from: start, to: end };
}
export function usageTriggerFor(auth) {
    return auth.kind === "session"
        ? { kind: "user", ...(auth.session.email ? { email: auth.session.email } : {}), label: auth.session.label }
        : { kind: "owner" };
}
export function queuedTurnTrigger(item) {
    if (item.trigger)
        return item.trigger;
    if (item.peerAsk)
        return undefined;
    return item.sender ? { kind: "user", label: item.sender.name } : { kind: "owner" };
}
/** On a Team Cloud, every routine in someone else's private chat as anyone else reads it (host/private-records.ts): one
 * line with no name and no id. */
export const PRIVATE_ROUTINE = { routineId: "private", label: "Private routine" };
export function triggerKey(trigger) {
    switch (trigger.kind) {
        case "user":
            return `user:${(trigger.email ?? trigger.label ?? "").toLowerCase() || "unknown"}`;
        case "owner":
            return "owner";
        case "routine":
            return `routine:${trigger.routineId ?? trigger.label ?? "unknown"}`;
        case "helper":
            return "helper";
        default:
            return "bot";
    }
}
export function triggerLabel(trigger) {
    switch (trigger.kind) {
        case "user":
            return trigger.email ?? trigger.label ?? "Signed-in user";
        case "owner":
            return "This computer";
        case "routine":
            return trigger.routineId === PRIVATE_ROUTINE.routineId ? PRIVATE_ROUTINE.label : `Routine: ${trigger.label ?? trigger.routineId ?? "unknown"}`;
        case "helper":
            return "Helper model";
        default:
            return "Bot to bot";
    }
}
function groupOf(row, groupBy) {
    switch (groupBy) {
        case "bot":
            return { key: `bot:${row.botId}`, label: row.botName || row.botId };
        case "model":
            return { key: `model:${row.driverKind}/${row.model}`, label: row.model };
        case "user": {
            // A routine's or a teammate's work for a known person counts as theirs.
            const email = personOf(row.trigger);
            return email ? { key: `user:${email.toLowerCase()}`, label: email } : { key: triggerKey(row.trigger), label: triggerLabel(row.trigger) };
        }
        case "day":
            return { key: `day:${row.at.slice(0, 10)}`, label: row.at.slice(0, 10) };
        case "routine":
            return row.trigger.kind === "routine"
                ? { key: triggerKey(row.trigger), label: row.trigger.label ?? row.trigger.routineId ?? "unknown" }
                : { key: "manual", label: "Not from a routine" };
        case "department":
            return { key: `department:${row.section ?? ""}`, label: row.section ?? "" };
        default:
            return { key: `engine:${row.driverKind}`, label: row.driverKind };
    }
}
/** An empty group before any ledger row is booked into it. */
function emptyGroup(key, label) {
    return { key, label, turns: 0, input: 0, output: 0, cachedInput: 0, costUsd: null, estimatedUsd: null, unpriced: 0, billableUsd: null, barTokens: 0 };
}
export function costSourceOf(row) {
    if (finiteOrNull(row.costUsd) === null)
        return null;
    return row.costSource === "estimated" ? "estimated" : "reported";
}
/** Books one row into a group, keeping its raw aggregates and its additive bar total. */
function add(group, row, prices) {
    const input = clean(row.input);
    const output = clean(row.output);
    const cachedInput = clean(row.cachedInput);
    group.turns += 1;
    group.input += input;
    group.output += output;
    group.cachedInput += cachedInput;
    group.barTokens = (group.barTokens ?? 0) + Math.max(0, input - Math.min(cachedInput, input)) + output;
    const cost = finiteOrNull(row.costUsd);
    if (cost === null)
        group.unpriced += 1;
    else {
        group.costUsd = (group.costUsd ?? 0) + cost;
        if (costSourceOf(row) === "estimated")
            group.estimatedUsd = (group.estimatedUsd ?? 0) + cost;
    }
    const billable = prices ? billableFor(row, prices) : null;
    if (billable !== null)
        group.billableUsd = (group.billableUsd ?? 0) + billable;
}
/** The tokens a bar shows: the row-by-row sum when the ledger has it, or the old aggregate for older callers. */
function barTokensOf(group) {
    return group.barTokens ?? Math.max(0, group.input - Math.min(group.cachedInput, group.input)) + group.output;
}
/** Groups ledger rows by `groupBy`; when `splitBy` differs, each group also carries its pieces, largest first. */
export function summarizeUsage(rows, groupBy, prices = null, splitBy = null) {
    const groups = new Map();
    const total = emptyGroup("total", "total");
    const splits = new Map();
    const split = splitBy && splitBy !== groupBy ? splitBy : null;
    for (const row of rows) {
        const { key, label } = groupOf(row, groupBy);
        let group = groups.get(key);
        if (!group) {
            group = emptyGroup(key, label);
            groups.set(key, group);
        }
        add(group, row, prices);
        add(total, row, prices);
        if (!split)
            continue;
        let inside = splits.get(key);
        if (!inside) {
            inside = new Map();
            splits.set(key, inside);
        }
        const pieceOf = groupOf(row, split);
        let piece = inside.get(pieceOf.key);
        if (!piece) {
            piece = emptyGroup(pieceOf.key, pieceOf.label);
            inside.set(pieceOf.key, piece);
        }
        add(piece, row, prices);
    }
    for (const [key, inside] of splits) {
        groups.get(key).segments = [...inside.values()].sort((a, b) => barTokensOf(b) - barTokensOf(a));
    }
    const ordered = [...groups.values()];
    if (groupBy === "day")
        ordered.sort((a, b) => a.key.localeCompare(b.key));
    else {
        ordered.sort((a, b) => {
            const costA = a.costUsd ?? Number.NEGATIVE_INFINITY;
            const costB = b.costUsd ?? Number.NEGATIVE_INFINITY;
            return costB - costA || b.input + b.output - (a.input + a.output);
        });
    }
    return { groups: ordered, total };
}
export function csvCell(value) {
    if (value === null)
        return "";
    const text = String(value);
    // A leading formula character is neutralised, so a spreadsheet never executes a bot name or an email.
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
export function usageCsv(rows, prices = null) {
    const header = ["time", "bot", "model", "engine", "triggered_by", "input_tokens", "output_tokens", "cached_input_tokens", "cost_usd", "cost_source", ...(prices ? ["billable_usd"] : []), "thread", "department", "person"];
    const lines = [header.join(",")];
    for (const row of rows) {
        lines.push([
            row.at,
            row.botName || row.botId,
            row.model,
            row.driverKind,
            triggerLabel(row.trigger),
            clean(row.input),
            clean(row.output),
            clean(row.cachedInput),
            finiteOrNull(row.costUsd),
            costSourceOf(row),
            ...(prices ? [billableFor(row, prices)] : []),
            row.threadId,
            row.section ?? "",
            personOf(row.trigger) ?? "",
        ].map(csvCell).join(","));
    }
    return lines.join("\n") + "\n";
}
