// A row never holds the message text, the options' text or the key. Files are 0600.
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { boundRetentionDays, pruneMonthFiles } from "../decision-log.js";
import { monthKey } from "../usage-ledger.js";
export const DECIDER_LOG_DIR = "decider-log";
const PRUNE_EVERY_MS = 60 * 60_000;
const writeQueues = new Map();
const lastPrune = new Map();
export function stateHash(state) {
    let text;
    try {
        text = JSON.stringify(state) ?? "";
    }
    catch {
        text = "";
    }
    return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
export function deciderLogFileFor(dataDir, at) {
    return join(dataDir, DECIDER_LOG_DIR, `${monthKey(at)}.ndjson`);
}
async function write(dataDir, row) {
    const at = new Date(row.at);
    await mkdir(join(dataDir, DECIDER_LOG_DIR), { recursive: true, mode: 0o700 });
    await appendFile(deciderLogFileFor(dataDir, at), JSON.stringify(row) + "\n", { mode: 0o600 });
    if (at.getTime() - (lastPrune.get(dataDir) ?? 0) >= PRUNE_EVERY_MS) {
        lastPrune.set(dataDir, at.getTime());
        await pruneMonthFiles(join(dataDir, DECIDER_LOG_DIR), boundRetentionDays(), at);
    }
}
/** Never throws and never waits: a full disk must not slow or fail a room turn. */
export function appendDeciderLog(dataDir, row) {
    const previous = writeQueues.get(dataDir) ?? Promise.resolve();
    const queued = previous.then(() => write(dataDir, row)).catch(() => {
    });
    writeQueues.set(dataDir, queued);
    void queued.finally(() => {
        if (writeQueues.get(dataDir) === queued)
            writeQueues.delete(dataDir);
    });
}
export async function flushDeciderLog(dataDir) {
    await writeQueues.get(dataDir);
}
