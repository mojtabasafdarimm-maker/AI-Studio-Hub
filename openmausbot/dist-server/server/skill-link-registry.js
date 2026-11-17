import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeFileAtomicIfChanged } from "./atomic.js";
import { DATA_DIR } from "./config.js";
import { isSkillName } from "../shared/skill-md.js";
const managedLinksSchema = z.array(z.string());
/** One registry per link root: the bot workspace, or one task workspace. */
function managedLinksPath(botId, threadId) {
    const state = join(DATA_DIR, "skill-state", botId);
    return threadId ? join(state, "task-links", `${threadId}.json`) : join(state, "managed-links.json");
}
export function readManagedLinks(botId, threadId) {
    try {
        const parsed = JSON.parse(readFileSync(managedLinksPath(botId, threadId), "utf8"));
        const result = managedLinksSchema.safeParse(parsed);
        return result.success ? result.data.filter(isSkillName) : [];
    }
    catch {
        return [];
    }
}
export function writeManagedLinks(botId, names, threadId) {
    const path = managedLinksPath(botId, threadId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileAtomicIfChanged(path, `${JSON.stringify([...new Set(names)].sort(), null, 2)}\n`, { mode: 0o600 });
}
