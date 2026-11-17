// Durable bursts. Counts live on the burst row and every change to a child updates them in one transaction, so reading a
// burst's progress never scans its children, however large it is.
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
const EMPTY = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
const SCHEMA = `
CREATE TABLE IF NOT EXISTS bursts (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  phase TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bursts_phase ON bursts(phase);
CREATE TABLE IF NOT EXISTS burst_children (
  burst_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  json TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (burst_id, seq)
);
CREATE INDEX IF NOT EXISTS burst_children_status ON burst_children(burst_id, status, seq);
`;
const titleOf = (item) => {
    const line = item.replace(/\s+/g, " ").trim();
    return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
};
export const sampleOf = (items) => items.slice(0, 5).map(titleOf);
export function openBurstStore(dataDir) {
    const file = dataDir === ":memory:" ? ":memory:" : join(dataDir, "bursts.db");
    if (file !== ":memory:") {
        mkdirSync(dirname(file), { recursive: true });
        closeSync(openSync(file, "a", 0o600));
        chmodSync(file, 0o600);
    }
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA);
    const rows = {
        insertBurst: db.prepare("INSERT INTO bursts (id, json, phase, created_at) VALUES (?, ?, ?, ?)"),
        updateBurst: db.prepare("UPDATE bursts SET json = ?, phase = ? WHERE id = ?"),
        getBurst: db.prepare("SELECT json FROM bursts WHERE id = ?"),
        activeBursts: db.prepare("SELECT json FROM bursts WHERE phase IN ('running', 'merging') ORDER BY created_at"),
        deleteBurst: db.prepare("DELETE FROM bursts WHERE id = ?"),
        oldBursts: db.prepare("SELECT id FROM bursts WHERE phase IN ('done', 'cancelled') AND created_at < ?"),
        insertChild: db.prepare("INSERT INTO burst_children (burst_id, seq, json, status) VALUES (?, ?, ?, ?)"),
        updateChild: db.prepare("UPDATE burst_children SET json = ?, status = ? WHERE burst_id = ? AND seq = ?"),
        getChild: db.prepare("SELECT json FROM burst_children WHERE burst_id = ? AND seq = ?"),
        nextQueued: db.prepare("SELECT json FROM burst_children WHERE burst_id = ? AND status = 'queued' ORDER BY seq LIMIT 1"),
        childrenOf: db.prepare("SELECT json FROM burst_children WHERE burst_id = ? ORDER BY seq"),
        childrenIn: db.prepare("SELECT json FROM burst_children WHERE burst_id = ? AND status = ? ORDER BY seq"),
        deleteChildren: db.prepare("DELETE FROM burst_children WHERE burst_id = ?"),
    };
    const parseBurst = (row) => JSON.parse(row.json);
    const parseChild = (row) => JSON.parse(row.json);
    const transaction = (run) => {
        db.exec("BEGIN");
        try {
            const result = run();
            db.exec("COMMIT");
            return result;
        }
        catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }
    };
    const writeBurst = (burst) => { rows.updateBurst.run(JSON.stringify(burst), burst.phase, burst.id); };
    const writeChild = (child) => { rows.updateChild.run(JSON.stringify(child), child.status, child.burstId, child.seq); };
    const insertChild = (id, seq, item) => {
        const child = { burstId: id, seq, item, title: titleOf(item), status: "queued", attempts: 0 };
        rows.insertChild.run(id, seq, JSON.stringify(child), "queued");
    };
    const getBurst = (id) => {
        const row = rows.getBurst.get(id);
        return row ? parseBurst(row) : undefined;
    };
    /** Moves a child to `status` and the counts with it, in one transaction. */
    const move = (burstId, seq, status, change = () => { }) => transaction(() => {
        const row = rows.getChild.get(burstId, seq);
        const burst = getBurst(burstId);
        if (!row || !burst)
            return undefined;
        const child = parseChild(row);
        change(child);
        burst.counts[child.status] -= 1;
        burst.counts[status] += 1;
        child.status = status;
        writeChild(child);
        writeBurst(burst);
        return child;
    });
    /** Every child in `from` moves to `to`, counted once at the end. */
    const moveAll = (burstId, from, to, change = () => { }) => transaction(() => {
        const burst = getBurst(burstId);
        if (!burst)
            return [];
        const moved = rows.childrenIn.all(burstId, from).map(parseChild);
        for (const child of moved) {
            change(child);
            child.status = to;
            writeChild(child);
        }
        burst.counts[from] -= moved.length;
        burst.counts[to] += moved.length;
        writeBurst(burst);
        return moved;
    });
    return {
        create(input) {
            const { items, ...fields } = input;
            const burst = { ...fields, phase: "preview", sample: sampleOf(items), counts: { ...EMPTY, queued: items.length } };
            transaction(() => {
                rows.insertBurst.run(burst.id, JSON.stringify(burst), burst.phase, burst.createdAt);
                items.forEach((item, seq) => insertChild(burst.id, seq, item));
            });
            return burst;
        },
        get: getBurst,
        child(burstId, seq) {
            const row = rows.getChild.get(burstId, seq);
            return row ? parseChild(row) : undefined;
        },
        children(burstId) {
            return rows.childrenOf.all(burstId).map(parseChild);
        },
        active() {
            return rows.activeBursts.all().map(parseBurst);
        },
        update(id, patch) {
            return transaction(() => {
                const burst = getBurst(id);
                if (!burst)
                    return undefined;
                Object.assign(burst, patch);
                writeBurst(burst);
                return burst;
            });
        },
        /** A preview's new list. */
        replacePlan(id, plan) {
            return transaction(() => {
                const burst = getBurst(id);
                if (!burst)
                    return undefined;
                if (plan.instructions !== undefined)
                    burst.instructions = plan.instructions;
                if (plan.items) {
                    rows.deleteChildren.run(id);
                    plan.items.forEach((item, seq) => insertChild(id, seq, item));
                    burst.counts = { ...EMPTY, queued: plan.items.length };
                    burst.sample = sampleOf(plan.items);
                    if (plan.requested !== undefined)
                        burst.requested = plan.requested;
                }
                writeBurst(burst);
                return burst;
            });
        },
        /** The next queued child of this burst, now running: one indexed read. */
        takeQueued(burstId) {
            const row = rows.nextQueued.get(burstId);
            return row ? move(burstId, parseChild(row).seq, "running", (child) => { child.attempts += 1; delete child.error; }) : undefined;
        },
        setThread(burstId, seq, threadId) {
            transaction(() => {
                const row = rows.getChild.get(burstId, seq);
                if (!row)
                    return;
                const child = parseChild(row);
                child.threadId = threadId;
                writeChild(child);
            });
        },
        /** A running child ended, unless a cancel settled it first. */
        settle(burstId, seq, status, fields) {
            const row = rows.getChild.get(burstId, seq);
            if (!row || parseChild(row).status !== "running")
                return undefined;
            return move(burstId, seq, status, (child) => {
                if (fields.result !== undefined)
                    child.result = fields.result;
                if (fields.error !== undefined)
                    child.error = fields.error;
            });
        },
        requeue(burstId, seq) {
            return move(burstId, seq, "queued");
        },
        /** Running children go back in line, each counted as cut off once more; one cut off more than `maxRestarts` times fails
         * with `stopped` instead. */
        requeueRunning(burstId, maxRestarts = Infinity, stopped = "") {
            const requeued = moveAll(burstId, "running", "queued", (child) => { child.restarts = (child.restarts ?? 0) + 1; });
            for (const child of requeued)
                if (child.restarts > maxRestarts)
                    move(burstId, child.seq, "failed", (failed) => { failed.error = stopped; });
            return requeued.filter((child) => child.restarts <= maxRestarts);
        },
        /** Failed children go back in line, with their reason cleared. */
        requeueFailed(burstId) {
            return moveAll(burstId, "failed", "queued", (child) => { delete child.error; delete child.result; });
        },
        cancelQueued(burstId) {
            return moveAll(burstId, "queued", "cancelled");
        },
        childrenIn(burstId, status) {
            return rows.childrenIn.all(burstId, status).map(parseChild);
        },
        prune(before) {
            const old = rows.oldBursts.all(before);
            transaction(() => { for (const { id } of old) {
                rows.deleteChildren.run(id);
                rows.deleteBurst.run(id);
            } });
            return old.length;
        },
        close() {
            db.close();
        },
    };
}
export const burstRow = (child) => ({ seq: child.seq, title: child.title, status: child.status,
    ...(child.threadId ? { threadId: child.threadId } : {}), ...(child.error ? { error: child.error } : {}) });
