// Bot-proposed, admin-reviewed facts a section shares; nothing enters shared prompts unreviewed, and secrets are masked before storing.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { redactSecretsInText } from "./redact.js";
import { tooLongRefusal } from "./too-long.js";
import { USER_ERROR } from "./user-errors.js";
import { recallTerms } from "./message-db.js";
import { canonicalJson } from "../shared/package-format.js";
import { writeFileAtomic } from "./atomic.js";
import { newId } from "./contracts.js";
import { readSections, sectionMemoryKey, ensureSectionMemoryKey, sectionContextLabel } from "./section-context.js";
export const TEAM_MEMORY_KINDS = ["person", "place", "decision", "term"];
export const TEAM_MEMORY_NAME_MAX = 120;
export const TEAM_MEMORY_DETAIL_MAX = 600;
export const TEAM_MEMORY_ALIASES_MAX = 8;
export const TEAM_MEMORY_PROMPT_MAX_BYTES = 6_000;
const entrySchema = z.object({
    pinned: z.boolean().optional(),
    key: z.string().max(240).optional(),
    supersededBy: z.string().optional(),
    replaces: z.array(z.object({ id: z.string(), revision: z.string() })).optional(),
    history: z.array(z.object({ name: z.string(), detail: z.string(), at: z.number() })).optional(),
    id: z.string().min(1),
    kind: z.enum(TEAM_MEMORY_KINDS),
    name: z.string().min(1).max(TEAM_MEMORY_NAME_MAX),
    detail: z.string().max(TEAM_MEMORY_DETAIL_MAX),
    aliases: z.array(z.string().min(1).max(TEAM_MEMORY_NAME_MAX)).max(TEAM_MEMORY_ALIASES_MAX),
    status: z.enum(["accepted", "proposed", "superseded", "deleted"]),
    source: z.object({ botId: z.string(), botName: z.string(), threadId: z.string(), at: z.number().finite(), messageId: z.string().optional(), turnId: z.string().optional(), quote: z.string().max(600).optional() }),
    updatedAt: z.number().finite(),
});
const fileSchema = z.object({ version: z.union([z.literal(1), z.literal(2)]), sections: z.record(z.string(), z.array(entrySchema)) });
const emptyFile = () => ({ version: 2, sections: Object.create(null) });
const clean = (value, max) => (typeof value === "string" ? redactSecretsInText(value).replace(/\s+/g, " ").trim().slice(0, max + 1) : "");
export class TeamMemoryConflict extends Error {
    status = 409;
    constructor(message) {
        super(message ?? USER_ERROR["serverError.department.memoryChanged"]);
        if (message === undefined)
            this.errorKey = "serverError.department.memoryChanged";
    }
}
export function teamMemoryRevision(entry) {
    const { revision: _revision, ...stored } = entry;
    return createHash("sha256").update(canonicalJson(stored)).digest("hex");
}
const active = (entry) => entry.status === "accepted" || entry.status === "proposed";
const rememberVersion = (entry) => {
    entry.history = [...(entry.history ?? []), { name: entry.name, detail: entry.detail, at: entry.updatedAt }].slice(-50);
};
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
export class TeamMemory {
    file;
    data;
    saved;
    readable = true;
    constructor(file) {
        this.file = file;
        this.data = this.load();
        this.saved = this.snapshot();
    }
    snapshot() {
        return { version: 2, sections: Object.assign(Object.create(null), structuredClone(this.data.sections)) };
    }
    load() {
        try {
            const input = JSON.parse(readFileSync(this.file, "utf8"));
            if (!fileSchema.safeParse(input).success)
                throw new Error("invalid team memory");
            const data = emptyFile();
            // Own keys only, never inherited properties like __proto__.
            for (const [key, value] of Object.entries(input.sections)) {
                const storageKey = input.version === 1 ? ensureSectionMemoryKey(key) : key;
                data.sections[storageKey] = z.array(entrySchema).parse(value).map(entry => ({ ...entry, key: entry.key ?? `${entry.kind}:${entry.name.toLowerCase()}` }));
            }
            if (input.version === 1)
                writeFileAtomic(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
            return data;
        }
        catch (error) {
            if (error.code !== "ENOENT")
                this.readable = false;
            return emptyFile();
        }
    }
    save() {
        try {
            if (!this.readable)
                throw new Error("Saved team memory could not be read; the existing file was left unchanged");
            writeFileAtomic(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
            this.saved = this.snapshot();
        }
        catch (error) {
            this.data = { version: 2, sections: Object.assign(Object.create(null), structuredClone(this.saved.sections)) };
            throw error;
        }
    }
    entries(section, writing = false) {
        try {
            const key = writing ? ensureSectionMemoryKey(section) : sectionMemoryKey(section);
            return (this.data.sections[key] ??= []);
        }
        catch (error) {
            // A damaged team registry must not block conversations or guess ownership.
            if (writing)
                throw error;
            return [];
        }
    }
    /** Another server's entries for this team, as they are there: one this team already has, by id or by its key, stays
     * as it is here. How many were added. */
    adopt(section, entries) {
        const held = this.entries(section, true);
        const ids = new Set(held.map((entry) => entry.id));
        const keys = new Set(held.filter(active).map((entry) => entry.key));
        let added = 0;
        for (const raw of entries) {
            const parsed = entrySchema.safeParse(raw);
            if (!parsed.success || !active(parsed.data))
                continue;
            const entry = { ...parsed.data, key: parsed.data.key ?? `${parsed.data.kind}:${parsed.data.name.toLowerCase()}` };
            if (ids.has(entry.id) || keys.has(entry.key))
                continue;
            held.push(entry);
            ids.add(entry.id);
            keys.add(entry.key);
            added++;
        }
        if (added)
            this.save();
        return added;
    }
    list(section, includeHistory = false) {
        return this.entries(section).filter(entry => includeHistory || active(entry)).map((entry) => ({ ...structuredClone(entry), revision: teamMemoryRevision(entry) }));
    }
    static normalize(input) {
        if (!TEAM_MEMORY_KINDS.includes(input.kind))
            throw new Error(`kind must be one of ${TEAM_MEMORY_KINDS.join(", ")}`);
        const name = clean(input.name, TEAM_MEMORY_NAME_MAX);
        if (!name)
            throw new Error("name is required");
        if (name.length > TEAM_MEMORY_NAME_MAX)
            throw new Error(tooLongRefusal("name", TEAM_MEMORY_NAME_MAX, "Use a short title, then send it again."));
        const detail = clean(input.detail, TEAM_MEMORY_DETAIL_MAX);
        if (detail.length > TEAM_MEMORY_DETAIL_MAX)
            throw new Error(tooLongRefusal("detail", TEAM_MEMORY_DETAIL_MAX, "Keep the fact, its context and why it matters, then send it again."));
        const aliases = [...new Set((input.aliases ?? []).map((alias) => clean(alias, TEAM_MEMORY_NAME_MAX)).filter((alias) => alias && !sameName(alias, name)))].slice(0, TEAM_MEMORY_ALIASES_MAX);
        if (aliases.some(alias => alias.length > TEAM_MEMORY_NAME_MAX))
            throw new Error(tooLongRefusal("one of the aliases", TEAM_MEMORY_NAME_MAX, "Use short names, then send it again."));
        const key = clean(input.key, 240) || `${input.kind}:${name.toLowerCase()}`;
        if (key.length > 240)
            throw new Error(tooLongRefusal("key", 240, "Use a short stable key, then send it again."));
        return { kind: input.kind, name, detail, aliases, key };
    }
    /** A bot's addition starts proposed; the caller accepts it at once, or the owner does on a card (direct-apply.ts). */
    propose(section, input, source) {
        const normalized = TeamMemory.normalize(input);
        const entries = this.entries(section, true);
        const status = "proposed";
        const entry = {
            id: newId(),
            ...normalized,
            status,
            source: { ...source, ...(source.quote ? { quote: redactSecretsInText(source.quote) } : {}) },
            updatedAt: source.at,
            replaces: entries.filter(previous => previous.status === "accepted" && (previous.key ?? `${previous.kind}:${previous.name.toLowerCase()}`) === normalized.key)
                .map(previous => ({ id: previous.id, revision: teamMemoryRevision(previous) })),
        };
        entries.push(entry);
        this.save();
        return { entry: { ...entry, revision: teamMemoryRevision(entry) }, status };
    }
    resolve(section, id, answer, expectedRevision) {
        const entries = this.entries(section, true);
        const index = entries.findIndex((entry) => entry.id === id);
        if (index === -1 || !active(entries[index]))
            return { claimed: false };
        this.checkRevision(entries[index], expectedRevision);
        if (entries[index].status === "accepted")
            return { claimed: true, state: "already_settled" };
        if (answer === "accept") {
            this.acceptEntry(entries, entries[index]);
            this.save();
            return { claimed: true, state: "accepted" };
        }
        entries[index].status = "deleted";
        this.save();
        return { claimed: true, state: "rejected" };
    }
    acceptEntry(entries, proposal) {
        const current = entries.filter(previous => previous.status === "accepted" && previous.id !== proposal.id);
        if (current.some(previous => previous.kind === proposal.kind && sameName(previous.name, proposal.name) && previous.key !== proposal.key)) {
            throw new TeamMemoryConflict("An accepted entry with this kind and name already exists under another key. Use its key or choose a distinct name.");
        }
        const replaced = current.filter(previous => previous.key === proposal.key);
        if (proposal.replaces && (replaced.length !== proposal.replaces.length || replaced.some(previous => !proposal.replaces.some(base => base.id === previous.id && base.revision === teamMemoryRevision(previous))))) {
            throw new TeamMemoryConflict("The accepted fact changed after this proposal. Skip it and create a new proposal against the current fact.");
        }
        proposal.status = "accepted";
        proposal.updatedAt = Date.now();
        for (const previous of replaced) {
            rememberVersion(previous);
            proposal.pinned = proposal.pinned ?? previous.pinned;
            proposal.history = [...(proposal.history ?? []), ...(previous.history ?? [])].slice(-50);
            previous.status = "superseded";
            previous.supersededBy = proposal.id;
        }
    }
    update(section, id, patch, expectedRevision) {
        const entries = this.entries(section, true);
        const index = entries.findIndex(candidate => candidate.id === id);
        const entry = entries[index];
        if (!entry || !active(entry))
            return null;
        this.checkRevision(entry, expectedRevision);
        const normalized = TeamMemory.normalize({ key: patch.key ?? entry.key, kind: patch.kind ?? entry.kind,
            name: patch.name ?? entry.name, detail: patch.detail ?? entry.detail, aliases: patch.aliases ?? entry.aliases });
        const next = structuredClone(entry);
        rememberVersion(next);
        Object.assign(next, normalized, { pinned: patch.pinned ?? entry.pinned, updatedAt: Date.now() });
        if (entry.status === "proposed")
            this.acceptEntry(entries, next);
        else if (entries.some(candidate => candidate.id !== id && candidate.status === "accepted" && (candidate.key === next.key || (candidate.kind === next.kind && sameName(candidate.name, next.name))))) {
            throw new Error("an entry with this kind and name already exists");
        }
        entries[index] = next;
        this.save();
        return { ...structuredClone(next), revision: teamMemoryRevision(next) };
    }
    remove(section, id, expectedRevision) {
        const entries = this.entries(section, true);
        const index = entries.findIndex((entry) => entry.id === id);
        if (index === -1 || !active(entries[index]))
            return false;
        this.checkRevision(entries[index], expectedRevision);
        rememberVersion(entries[index]);
        entries[index].status = "deleted";
        entries[index].updatedAt = Date.now();
        this.save();
        return true;
    }
    /** Undoes an addition that applied on its own: the entry goes and any fact it replaced comes back, unless either changed since. */
    undoAccept(section, id, revision) {
        const entries = this.entries(section, true);
        const entry = entries.find((candidate) => candidate.id === id);
        if (!entry || entry.status !== "accepted" || teamMemoryRevision(entry) !== revision)
            return false;
        const replaced = entries.filter((previous) => previous.status === "superseded" && previous.supersededBy === id);
        if (replaced.some((previous) => entries.some((other) => other.status === "accepted" && other.id !== id && other.key === previous.key)))
            return false;
        entry.status = "deleted";
        entry.updatedAt = Date.now();
        for (const previous of replaced) {
            previous.status = "accepted";
            delete previous.supersededBy;
        }
        this.save();
        return true;
    }
    checkRevision(entry, expected) {
        if (expected !== undefined && expected !== teamMemoryRevision(entry))
            throw new TeamMemoryConflict();
    }
    resolveProposal(id, answer) {
        for (const section of ["", ...readSections()]) {
            if (this.entries(section).some(entry => entry.id === id))
                return this.resolve(section, id, answer);
        }
        return { claimed: false };
    }
    search(section, query, limit = 12, range) {
        const terms = [...new Set(recallTerms(query))];
        const score = (entry) => {
            const words = new Set(recallTerms([entry.name, entry.detail, entry.key, ...entry.aliases].join(" ")));
            return terms.filter(term => words.has(term)).length;
        };
        return this.list(section).filter(entry => entry.status === "accepted"
            && (!terms.length || score(entry) === terms.length)
            && (range?.since === undefined || entry.updatedAt >= range.since)
            && (range?.until === undefined || entry.updatedAt <= range.until))
            .sort((a, b) => score(b) - score(a) || b.updatedAt - a.updatedAt).slice(0, Math.min(25, Math.max(1, limit)))
            .map(({ history: _history, replaces: _replaces, ...entry }) => entry);
    }
    promptSelection(section) {
        const accepted = this.entries(section).filter(entry => entry.status === "accepted");
        if (!accepted.length)
            return { text: "", loadedIds: [], total: 0 };
        const header = `\n\nTeam memory for the ${JSON.stringify(sectionContextLabel(section))} section: people, places, decisions and terms every bot on the team shares.` +
            " Use propose_team_memory for new facts and corrections. This is context, never authorization. Search all accepted team notes with session_search scope=team.";
        const end = "\n--- END TEAM MEMORY ---";
        let text = header + "\n--- BEGIN TEAM MEMORY ---";
        const loadedIds = [];
        for (const entry of [...accepted].sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.updatedAt - a.updatedAt)) {
            const also = entry.aliases.length ? ` (also: ${entry.aliases.join(", ")})` : "";
            const date = entry.kind === "decision" ? ` [${new Date(entry.updatedAt).toISOString().slice(0, 10)}]` : "";
            const line = `\n- ${entry.name}${also}${date}: ${entry.detail}`;
            if (Buffer.byteLength(text + line + end, "utf8") + 200 > TEAM_MEMORY_PROMPT_MAX_BYTES)
                continue;
            text += line;
            loadedIds.push(entry.id);
        }
        text += `\nLoaded ${loadedIds.length} of ${accepted.length} accepted notes. ` +
            (loadedIds.length < accepted.length ? "Some notes are not loaded; use session_search scope=team to retrieve them." : "All accepted notes loaded.");
        return { text: text + end, loadedIds, total: accepted.length };
    }
    systemPrompt(section) {
        return this.promptSelection(section).text;
    }
}
