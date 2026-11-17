// Invariants: a share never changes the skills index of a conversation that started before it (the provider's
// cached prefix survives; the conversation gets a one-time note instead), and a skill reaches only teammates
// that no more people can see than could see where it was learned.
import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { audienceWithin } from "./bot-visibility.js";
import { redactSecretsInText } from "./redact.js";
import { LEARN_SOURCE_PREFIX } from "./skill-learn.js";
import { installLibrarySkill, libraryArchiveDirectory, librarySkillFilePath, listLibrarySkills, readLibrarySkillFile, readSkillLibraryIndex, retireLibrarySkill, skillLibraryEvents, skillsLibraryEnabled, skillsLibraryRoot, updateLibrarySkill, } from "./skill-library.js";
import { archiveSkillDirectory, readPendingAssignments, writePendingAssignments } from "./skills-library-migration.js";
import { listMigratableSkills, listSkills, preparedLearnedSkill, removeManifestEntry, STAGED_SKILL_FILE_MAX_BYTES } from "./skills.js";
export function shareLearnedSkillsMode(cfg) {
    if (!skillsLibraryEnabled(cfg))
        return "off";
    return cfg.features?.shareLearnedSkills ?? "ask";
}
/** The checks stageSkillWrite applies, for a library write that is never staged. */
export function prepareLearnedSkillMd(content) {
    const redacted = redactSecretsInText(content);
    if (Buffer.byteLength(redacted, "utf8") > STAGED_SKILL_FILE_MAX_BYTES) {
        return { error: `learned SKILL.md files must be at most ${STAGED_SKILL_FILE_MAX_BYTES / 1024}KB` };
    }
    const prepared = preparedLearnedSkill([{ path: "SKILL.md", content: redacted }]);
    if ("error" in prepared)
        return prepared;
    const text = prepared.files[0]?.content ?? "";
    return { content: text, name: prepared.parsed.name, description: prepared.parsed.description, sha256: sha256Hex(text), warnings: prepared.warnings };
}
const WIDER_AUDIENCE = "more people can see it than could see where the skill was learned";
const sectionKey = (section) => section?.trim() || "";
/** Unsectioned bots form one team. */
export function teammatesOf(author, bots) {
    const team = sectionKey(author.section);
    return bots.filter((bot) => bot.id !== author.id && sectionKey(bot.section) === team);
}
function sha256Hex(text) {
    return createHash("sha256").update(text).digest("hex");
}
const sortedUnique = (names) => [...new Set(names)].sort();
function sharedAssignmentsPath(root) {
    return join(root, "shared-assignments.json");
}
function shareNotesPath(root) {
    return join(root, "share-notes.json");
}
function readJsonRecord(path) {
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return {};
        const result = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (value && typeof value === "object" && !Array.isArray(value))
                result[key] = { ...value };
        }
        return result;
    }
    catch {
        return {};
    }
}
function writeJsonRecord(root, path, value) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
export function sharedAssignmentTimes(botId, root = skillsLibraryRoot()) {
    const entry = readJsonRecord(sharedAssignmentsPath(root))[botId] ?? {};
    const result = {};
    for (const [name, at] of Object.entries(entry))
        if (typeof at === "number" && Number.isFinite(at))
            result[name] = at;
    return result;
}
function recordSharedAssignments(root, changes) {
    if (!changes.length)
        return;
    const all = readJsonRecord(sharedAssignmentsPath(root));
    for (const change of changes) {
        const entry = { ...all[change.botId] };
        if (change.at === null)
            delete entry[change.name];
        else
            entry[change.name] = change.at;
        if (Object.keys(entry).length)
            all[change.botId] = entry;
        else
            delete all[change.botId];
    }
    writeJsonRecord(root, sharedAssignmentsPath(root), all);
}
/** `startedAt` is the conversation's first message time; undefined (a new conversation) withholds nothing. */
function withheldForConversation(botId, startedAt, root) {
    if (startedAt === undefined)
        return new Set();
    return new Set(Object.entries(sharedAssignmentTimes(botId, root))
        .filter(([, at]) => startedAt < at)
        .map(([name]) => name));
}
export function conversationAssignedSkills(botId, assigned, startedAt, root = skillsLibraryRoot()) {
    if (!assigned?.length)
        return assigned ? [...assigned] : undefined;
    const withheld = withheldForConversation(botId, startedAt, root);
    return withheld.size ? assigned.filter((name) => !withheld.has(name)) : [...assigned];
}
function notedNames(root, botId, threadId) {
    const noted = readJsonRecord(shareNotesPath(root))[botId]?.[threadId];
    return Array.isArray(noted) ? noted.filter((name) => typeof name === "string") : [];
}
const NO_NOTE = { text: "", commit: () => { } };
export function prepareShareNote(botId, threadId, assigned, startedAt, privateNames, root = skillsLibraryRoot()) {
    if (!assigned?.length)
        return NO_NOTE;
    const withheld = withheldForConversation(botId, startedAt, root);
    if (!withheld.size)
        return NO_NOTE;
    const noted = new Set(notedNames(root, botId, threadId));
    const shadowed = new Set(privateNames);
    const assignedNow = new Set(assigned);
    const fresh = listLibrarySkills(root).filter((skill) => skill.enabled && withheld.has(skill.name) && assignedNow.has(skill.name) && !noted.has(skill.name) && !shadowed.has(skill.name));
    if (!fresh.length)
        return NO_NOTE;
    const text = `\n\n${fresh.map((skill) => `New team skill available: ${skill.name} — ${skill.description} Read ${JSON.stringify(librarySkillFilePath(skill.name, root))} with your file tools before a task it covers.`).join("\n")}`;
    let committed = false;
    return {
        text,
        commit: () => {
            if (committed)
                return;
            committed = true;
            // re-read: another conversation of this bot may have noted since
            const latest = readJsonRecord(shareNotesPath(root));
            latest[botId] = { ...latest[botId], [threadId]: sortedUnique([...notedNames(root, botId, threadId), ...fresh.map((skill) => skill.name)]) };
            writeJsonRecord(root, shareNotesPath(root), latest);
        },
    };
}
function assignTeam(args) {
    const assigned = [];
    const skipped = [];
    const recorded = [];
    if (args.assignAuthor && !args.author.assignedSkills?.includes(args.name)) {
        args.patchAssigned(args.author.id, sortedUnique([...(args.author.assignedSkills ?? []), args.name]));
        assigned.push({ botId: args.author.id, name: args.author.name });
    }
    for (const mate of teammatesOf(args.author, args.bots)) {
        if (listSkills(mate.id).some((skill) => skill.name === args.name)) {
            skipped.push({ botId: mate.id, name: mate.name, reason: `has its own skill named "${args.name}"` });
            continue;
        }
        if (mate.assignedSkills?.includes(args.name))
            continue;
        if (!audienceWithin(mate.visibility, args.audience)) {
            skipped.push({ botId: mate.id, name: mate.name, reason: WIDER_AUDIENCE });
            continue;
        }
        args.patchAssigned(mate.id, sortedUnique([...(mate.assignedSkills ?? []), args.name]));
        assigned.push({ botId: mate.id, name: mate.name });
        recorded.push({ botId: mate.id, name: args.name, at: args.at });
    }
    recordSharedAssignments(args.root, recorded);
    return { assigned, skipped };
}
/** Every refusal returns `{ error }` and leaves the skill where it was. */
export function shareLearnedSkill(args) {
    const root = args.root ?? skillsLibraryRoot();
    const at = args.now ?? Date.now();
    const { author, name } = args;
    const audience = args.audience === undefined ? author.visibility : args.audience;
    const copy = listMigratableSkills(author.id).find((skill) => skill.name === name);
    const changed = { error: `"${name}" changed since this receipt — share it from its latest receipt`, stale: true };
    let library;
    if (copy) {
        if (args.expectSha256 !== undefined && copy.sha256 !== args.expectSha256)
            return changed;
        if (!copy.source.startsWith(LEARN_SOURCE_PREFIX))
            return { error: `"${name}" was imported, not learned — only learned skills are shared` };
        if (!copy.intact || !copy.directory)
            return { error: "the stored SKILL.md is missing or changed after review" };
        if (!copy.enabled)
            return { error: `"${name}" is switched off` };
        let instructions;
        try {
            if (readdirSync(copy.directory).some((entry) => entry !== "SKILL.md")) {
                return { error: "the skill has supporting files — the library stores SKILL.md only" };
            }
            instructions = readFileSync(join(copy.directory, "SKILL.md"), "utf8");
        }
        catch {
            return { error: "could not read the stored SKILL.md" };
        }
        if (sha256Hex(instructions) !== copy.sha256)
            return { error: "the stored SKILL.md changed after review" };
        const existing = readSkillLibraryIndex(root)[name];
        if (existing && existing.sha256 !== copy.sha256) {
            return { error: `the library already has a different skill named "${name}"` };
        }
        if (existing && existing.reviewState !== "approved")
            return { error: `the library's "${name}" is switched off` };
        if (!existing) {
            const installed = installLibrarySkill({
                name,
                description: copy.description,
                instructions,
                source: copy.source,
                reviewState: "approved",
                root,
            });
            if ("error" in installed)
                return installed;
        }
        library = existing ? "deduplicated" : "installed";
        // The assignment is durable before the private copy goes, so a crash in between replays it at the next boot.
        try {
            const pending = readPendingAssignments(root);
            writePendingAssignments({ ...pending, [author.id]: sortedUnique([...(pending[author.id] ?? []), name]) }, root);
            archiveSkillDirectory(copy.directory, libraryArchiveDirectory(root, author.id, name), copy.sha256);
        }
        catch (error) {
            return { error: `could not move the private copy into the library: ${error instanceof Error ? error.message : String(error)}` };
        }
        // The library owns the skill from here: a manifest entry that moved on stays the author's, and the share completes.
        try {
            const removed = removeManifestEntry(author.id, name, copy.sha256);
            if ("error" in removed)
                console.warn(`[skill-share] ${name}: ${removed.error}`);
        }
        catch (error) {
            console.warn(`[skill-share] ${name}: could not drop the private manifest entry: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    else {
        const entry = readSkillLibraryIndex(root)[name];
        if (!entry || !author.assignedSkills?.includes(name))
            return { error: `no learned skill named "${name}"` };
        if (args.expectSha256 !== undefined && entry.sha256 !== args.expectSha256)
            return changed;
        if (!entry.source.startsWith(LEARN_SOURCE_PREFIX))
            return { error: `"${name}" was imported, not learned — only learned skills are shared` };
        if (entry.reviewState !== "approved")
            return { error: `the library's "${name}" is switched off` };
        library = "assigned";
    }
    const sha256 = readSkillLibraryIndex(root)[name]?.sha256 ?? "";
    const team = assignTeam({ ...args, at, root, assignAuthor: true, audience });
    if (copy) {
        const pending = readPendingAssignments(root);
        const rest = (pending[author.id] ?? []).filter((entry) => entry !== name);
        if (rest.length)
            pending[author.id] = rest;
        else
            delete pending[author.id];
        try {
            writePendingAssignments(pending, root);
        }
        catch {
            // The pending entry only replays an assignment that already exists.
        }
    }
    skillLibraryEvents.emit("invalidate", { kind: "share", name, botIds: team.assigned.map((bot) => bot.botId) });
    return { library, sha256, sharedAt: at, ...team };
}
export const SHARED_REVISION_CHARS = 12;
/** Applies only while the library holds the version the writer read (`expectSha256`: full hash or revision prefix). */
export function updateSharedLearnedSkill(args) {
    const root = args.root ?? skillsLibraryRoot();
    const at = args.now ?? Date.now();
    const entry = readSkillLibraryIndex(root)[args.name];
    if (!entry || !args.bot.assignedSkills?.includes(args.name))
        return { error: `no shared skill named "${args.name}"` };
    if (!entry.source.startsWith(LEARN_SOURCE_PREFIX))
        return { error: `skill "${args.name}" was imported — it cannot be rewritten` };
    if (entry.reviewState !== "approved")
        return { error: `the library's "${args.name}" is switched off` };
    const audience = args.audience === undefined ? args.bot.visibility : args.audience;
    const wider = args.bots.filter((other) => other.id !== args.bot.id && other.assignedSkills?.includes(args.name) && !audienceWithin(other.visibility, audience));
    if (wider.length) {
        return { error: `skill "${args.name}" is also assigned to ${wider.map((other) => other.name).join(", ")}, which more people can see than can see this conversation — it is not updated from here` };
    }
    const prepared = prepareLearnedSkillMd(args.skillMd);
    if ("error" in prepared)
        return prepared;
    if (prepared.name !== args.name)
        return { error: `updated SKILL.md name must remain "${args.name}"` };
    const previous = readLibrarySkillFile(args.name, root);
    if (previous === null)
        return { error: "stored SKILL.md changed after review — restore or remove it before proposing an update" };
    const read = args.expectSha256.trim().toLowerCase();
    if (read.length < SHARED_REVISION_CHARS || !entry.sha256.startsWith(read))
        return { error: `skill "${args.name}" changed since it was read — read it again first` };
    const base = entry.sha256;
    if (prepared.sha256 === entry.sha256)
        return { error: `skill "${args.name}" already matches the proposed SKILL.md` };
    const updated = updateLibrarySkill({ name: args.name, instructions: prepared.content, expectSha256: base, root });
    if ("stale" in updated)
        return { error: `skill "${args.name}" changed since it was read — read it again first` };
    if ("error" in updated)
        return updated;
    const team = args.assignOnward
        ? assignTeam({ author: args.bot, bots: args.bots, name: args.name, patchAssigned: args.patchAssigned, at, root, assignAuthor: false, audience })
        : { assigned: [], skipped: [] };
    skillLibraryEvents.emit("invalidate", { kind: "share", name: args.name, botIds: team.assigned.map((bot) => bot.botId) });
    return {
        share: { library: "updated", sha256: prepared.sha256, sharedAt: at, ...team },
        previous: { skillMd: previous, source: entry.source },
        content: prepared.content,
        sha256: prepared.sha256,
        warnings: prepared.warnings,
        description: prepared.description,
    };
}
/** Only while the library copy is exactly what the share left; otherwise `stale` and nothing changes. */
export function undoSharedLearnedSkill(args) {
    const root = args.root ?? skillsLibraryRoot();
    const entry = readSkillLibraryIndex(root)[args.name];
    if (!entry || entry.sha256 !== args.share.sha256 || readLibrarySkillFile(args.name, root) === null)
        return { stale: true };
    const { library } = args.share;
    let unassign = args.share.assigned.map((bot) => bot.botId);
    if (library === "installed" && args.action === "create") {
        const retired = retireLibrarySkill(args.name, args.share.sha256, root);
        if (!("retired" in retired))
            return retired;
    }
    else if ((library === "installed" && args.action === "update") || library === "updated") {
        if (!args.previous)
            return { error: "This change can't be undone here." };
        const restored = updateLibrarySkill({ name: args.name, instructions: args.previous.skillMd, expectSha256: args.share.sha256, source: args.previous.source, root });
        if (!("name" in restored))
            return restored;
        // The author keeps the skill it had before this update.
        if (library === "installed")
            unassign = unassign.filter((botId) => botId !== args.authorId);
    }
    else if (args.action === "update") {
        return { error: "This change can't be undone here." };
    }
    const targets = new Set(unassign);
    for (const bot of args.bots) {
        if (!targets.has(bot.id) || !bot.assignedSkills?.includes(args.name))
            continue;
        args.patchAssigned(bot.id, bot.assignedSkills.filter((name) => name !== args.name));
    }
    recordSharedAssignments(root, [...targets].map((botId) => ({ botId, name: args.name, at: null })));
    skillLibraryEvents.emit("invalidate", { kind: "unshare", name: args.name, botIds: [...targets] });
    return { undone: true };
}
export function sharedSkillEditable(botId, assigned, name, root = skillsLibraryRoot()) {
    if (!assigned?.includes(name))
        return false;
    if (listSkills(botId).some((skill) => skill.name === name))
        return false;
    const entry = readSkillLibraryIndex(root)[name];
    return Boolean(entry && entry.source.startsWith(LEARN_SOURCE_PREFIX) && entry.reviewState === "approved" && readLibrarySkillFile(name, root) !== null);
}
