// The receipt is written in the same SQLite transaction as the command's own rows, so only synchronous writes to this
// database belong in `apply`. Files, provider calls, caches and broadcasts are not transactional: prepare replay-safe files
// before and publish after. A receipt does not make external side effects exactly-once.
import { readCommandReceipt, withCommandReceipt } from "./message-db.js";
/** A repeat returns the stored result without calling `apply`; results must be JSON (`undefined` is stored as `null`). */
export function runCommand(command, apply, now = Date.now) {
    const { result } = withCommandReceipt(command.kind, command.key, () => JSON.stringify(apply() ?? null), now());
    return JSON.parse(result);
}
export function commandReceipt(kind, key) {
    const stored = readCommandReceipt(kind, key);
    if (!stored)
        return null;
    return { kind: stored.kind, key: stored.key, at: stored.at, result: JSON.parse(stored.result) };
}
