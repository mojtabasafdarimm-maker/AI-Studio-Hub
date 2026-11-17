// Codex owns history; this receipt only remembers which bot rules and which
// volatile context digest the native thread last carried.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.js";
import { writeFileAtomic } from "../atomic.js";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const isFingerprint = (value) => /^[0-9a-f]{64}$/.test(value);
function parseReceipt(raw) {
    if (!raw)
        return null;
    const trimmed = raw.trim();
    if (isFingerprint(trimmed))
        return { instructions: trimmed };
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const record = parsed;
            if (typeof record.instructions === "string" && isFingerprint(record.instructions)) {
                return {
                    instructions: record.instructions,
                    ...(typeof record.volatile === "string" && isFingerprint(record.volatile) ? { volatile: record.volatile } : {}),
                };
            }
        }
    }
    catch { }
    return null;
}
/** Preserve native configured rules when overriding Codex's developer slot. */
export function codexDeveloperInstructions(config, botInstructions) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new Error("Codex returned no effective configuration; cannot safely update bot instructions.");
    }
    const configured = config.developer_instructions;
    if (configured != null && typeof configured !== "string") {
        throw new Error("Codex returned invalid developer instructions; cannot safely update bot instructions.");
    }
    // Native rules go last, keeping their precedence over the bot's.
    return configured
        ? `${botInstructions || "No OpenMausBot bot-specific instructions remain."}\n\n${configured}`
        : botInstructions;
}
export async function syncCodexInstructions(key, nativeThreadId, instructions, volatile, resumed, request, mentionTurn = false) {
    const directory = join(DATA_DIR, "codex-instructions");
    const path = join(directory, `${digest(JSON.stringify([key, nativeThreadId]))}.sha256`);
    const fingerprint = digest(instructions);
    const volatileFingerprint = digest(volatile);
    let previous;
    try {
        previous = parseReceipt(readFileSync(path, "utf8"));
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        previous = null;
    }
    if (resumed && previous?.instructions !== fingerprint) {
        // Codex 0.153.4 keeps the old initial developer message until compaction, so an update is appended
        // only on change. inject_items flushes history before acknowledging; only then is the receipt written.
        try {
            await request("thread/inject_items", {
                threadId: nativeThreadId,
                items: [{
                        type: "message",
                        role: "developer",
                        content: [{
                                type: "input_text",
                                text: "The following replaces the previous developer instruction block supplied by OpenMausBot, including its native configured rules and bot-specific instructions. Other Codex instructions and permissions still apply.\n\n"
                                    + (instructions || "No OpenMausBot bot-specific instructions remain."),
                            }],
                    }],
            });
        }
        catch (error) {
            if (error instanceof Error && /method not found|unknown method/i.test(error.message)) {
                throw new Error(`This Codex version cannot update bot instructions in a resumed session. Update Codex and retry: ${error.message}`, { cause: error });
            }
            throw error;
        }
    }
    const deliverVolatile = !resumed || previous?.volatile !== volatileFingerprint || mentionTurn;
    const hadVolatile = typeof previous?.volatile === "string" && previous.volatile !== digest("");
    if (!resumed || previous?.instructions !== fingerprint) {
        // The volatile digest stays pending until the provider accepts the turn, so a rejected one redelivers.
        mkdirSync(directory, { recursive: true });
        writeFileAtomic(path, JSON.stringify({ instructions: fingerprint }), { mode: 0o600 });
    }
    const commitVolatile = previous?.instructions === fingerprint && previous?.volatile === volatileFingerprint
        ? null
        : () => {
            mkdirSync(directory, { recursive: true });
            writeFileAtomic(path, JSON.stringify({ instructions: fingerprint, volatile: volatileFingerprint }), { mode: 0o600 });
        };
    return { deliverVolatile, hadVolatile, commitVolatile };
}
