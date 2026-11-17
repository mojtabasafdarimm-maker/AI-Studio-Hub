// "Forget X" reaches every note a bot keeps: MEMORY.md, its topic notes and their archive. About me is forgotten by the caller.
import { join } from "node:path";
import { parseMemoryEntries, passageMatcher } from "./memory-entries.js";
import { clearForgotten, rememberForgotten } from "./profile-learned.js";
import { isMemorySeed, listMemoryTopics, readMemoryText, updateMemory, workspaceDir, writeMemoryFile, writeMemoryTopic } from "./workspace.js";
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;
/** `text` without each note that mentions the passage: a dated entry judged by its fact, never by its source, and any
 * other line whole. Headings, blank lines and a topic's frontmatter stay. */
export function withoutMentions(text, mentions) {
    const lines = text.split("\n");
    const drop = new Set();
    const entryLines = new Set();
    const removed = [];
    for (const entry of parseMemoryEntries(text)) {
        for (let line = entry.line; line < entry.end; line += 1)
            entryLines.add(line);
        if (!mentions(entry.body))
            continue;
        for (let line = entry.line; line < entry.end; line += 1)
            drop.add(line);
        removed.push(entry.body);
    }
    let frontmatter = lines[0]?.trim() === "---";
    lines.forEach((line, index) => {
        if (index > 0 && frontmatter && line.trim() === "---") {
            frontmatter = false;
            return;
        }
        if (frontmatter || entryLines.has(index) || line.trim().startsWith("#"))
            return;
        const bare = line.replace(BULLET, "").replace(/~~/g, "").trim();
        if (!bare || !mentions(bare))
            return;
        drop.add(index);
        removed.push(bare);
    });
    return { text: lines.filter((_, index) => !drop.has(index)).join("\n"), removed };
}
function readNote(botId, relative) {
    try {
        return readMemoryText(join(workspaceDir(botId), relative));
    }
    catch {
        return null;
    }
}
/** The facts removed, from MEMORY.md first. Each file is read and rewritten with no await in between. */
export function forgetInNotes(botId, mentions) {
    const removed = [];
    const index = readNote(botId, "MEMORY.md");
    if (index !== null && !isMemorySeed(index)) {
        const kept = withoutMentions(index, mentions);
        if (kept.removed.length) {
            writeMemoryFile(botId, kept.text);
            removed.push(...kept.removed);
        }
    }
    for (const topic of listMemoryTopics(botId)) {
        const text = readNote(botId, join("memory", topic.name));
        if (text === null)
            continue;
        const kept = withoutMentions(text, mentions);
        if (!kept.removed.length)
            continue;
        writeMemoryTopic(botId, topic.name, kept.text);
        removed.push(...kept.removed);
    }
    return removed;
}
/** The person's own words started this turn: not another person's, not another bot's, not a room's. */
export function ownersOwnAsk(path) {
    const asked = path.findLast((message) => message.role === "user" && message.kind === "text");
    return Boolean(asked) && !asked.sender && !asked.peerAsk;
}
/** The longest preference one line of About me holds: one standing wish, not instructions. */
export const PREFERENCE_CHARS = 300;
/** memory_update from a bot's turn. forget takes the passage in oldText; `aboutMe` is null when this conversation may not
 * change the person's About me. prefer saves one standing preference into the About me of the person who began this
 * work, which every bot reads, so nothing has to be passed on to each bot; `prefer` is null when no one person began it. */
export function botMemoryUpdate(layer, body, opts) {
    if (body.action === "prefer") {
        const text = typeof body.text === "string" ? body.text.replace(/\s+/g, " ").trim() : "";
        if (!text || text.length > PREFERENCE_CHARS) {
            return { ok: false, code: "invalid", error: `prefer needs text: the person's preference as one short line, at most ${PREFERENCE_CHARS} characters.` };
        }
        if (!opts.prefer) {
            return { ok: false, code: "invalid", error: "Only work one person began with their own words can save their preference: ask them to say it in their own chat with you." };
        }
        // Said again now, it holds again, even after the person had it forgotten.
        clearForgotten(text);
        return { ok: true, preference: opts.prefer.save(text) > 0 ? "saved" : "known", ...(opts.prefer.person ? { person: opts.prefer.person } : {}) };
    }
    if (body.action === "forget") {
        const passage = typeof body.oldText === "string" ? body.oldText : "";
        const mentions = passageMatcher(passage);
        if (!mentions)
            return { ok: false, code: "invalid", error: "forget needs old_text: a few words that name what to forget, at least three letters." };
        const forgotten = forgetInNotes(layer, mentions);
        if (!opts.aboutMe)
            return { ok: true, forgotten, aboutMe: [] };
        const aboutMe = opts.aboutMe.forget(layer, mentions);
        rememberForgotten(passage, mentions);
        return { ok: true, forgotten, aboutMe };
    }
    if (body.action === "append" && typeof body.text === "string")
        clearForgotten(body.text);
    const result = updateMemory(layer, { action: body.action, text: body.text, oldText: body.oldText, ...(body.until !== undefined ? { until: body.until } : {}) }, { source: opts.source });
    // A supersede restores the fact only once the old entry was really replaced; a stale old_text keeps the marker.
    if (body.action === "supersede" && result.ok && typeof body.text === "string")
        clearForgotten(body.text);
    return result;
}
