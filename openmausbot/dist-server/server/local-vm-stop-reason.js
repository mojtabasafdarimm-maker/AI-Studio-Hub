import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { DATA_DIR } from "./config.js";
function recordPath(key, dataDir) {
    return join(dataDir, "local-vm-stops", `${createHash("sha256").update(key).digest("hex")}.json`);
}
export function recordLocalVmIdleStop(key, stoppedAt, dataDir = DATA_DIR) {
    if (!stoppedAt)
        return;
    mkdirSync(join(dataDir, "local-vm-stops"), { recursive: true, mode: 0o700 });
    writeFileAtomic(recordPath(key, dataDir), JSON.stringify({ stoppedAt }), { mode: 0o600 });
}
export function localVmStopReason(key, status, dataDir = DATA_DIR) {
    if (status.container !== "stopped" || !status.stopped_at)
        return null;
    try {
        return JSON.parse(readFileSync(recordPath(key, dataDir), "utf8")).stoppedAt === status.stopped_at ? "idle" : null;
    }
    catch {
        return null;
    }
}
