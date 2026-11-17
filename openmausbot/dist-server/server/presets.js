// A preset is an allowlist (persona, looks, playbooks, skills, notes): nothing it says can widen what a bot may do.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.js";
import { DATA_DIR } from "./config.js";
import { pair } from "./package-parts.js";
import { AGENT_MAX_SKILLS, canonicalJson, PACKAGE_FORMAT, PACKAGE_V2_VERSION, parsePackageDocument, SEED_FILE_MAX_BYTES, SEED_MAX_BYTES, SEED_MAX_FILES, utf8Bytes, } from "../shared/package-format.js";
import { parseSkillMd } from "../shared/skill-md.js";
export const PRESETS_FILE = join(DATA_DIR, "org-library", "presets.json");
export const PUBLISHED_LIBRARY_FILE = join(DATA_DIR, "published-library.json");
export const MAX_STORED_PRESETS = 200;
export const DEFAULTS_PRESET_KEY = "new-bot-defaults";
export const PRESET_UNAVAILABLE_MESSAGE = "That preset is no longer available. Choose another starting role.";
export const ORG_PRESET_REMOVE_MESSAGE = "Presets from your organization are managed in Admin.";
const text = (max) => z.string().max(max);
const storedPresetSchema = z.object({
    id: z.string().regex(/^[\w-]{1,64}$/),
    source: z.enum(["file", "org"]),
    installId: text(100).min(1),
    packageId: text(80).min(1),
    packageName: text(100).min(1),
    release: text(30).min(1),
    publisherName: text(100).optional(),
    publisher: z.object({ organizationId: text(200), slug: text(40), name: text(100) }).optional(),
    ref: text(120).optional(),
    sha256: text(64).optional(),
    key: text(64).min(1),
    name: text(100).min(1),
    description: text(300).optional(),
    // Checked field by field through the package parser on every use.
    bot: z.record(z.string(), z.unknown()),
    playbooks: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
    seed: z.object({ memory: z.record(z.string(), z.string()) }).optional(),
    addedAt: z.number(),
});
const fileSchema = z.object({
    version: z.literal(1),
    presets: z.array(z.unknown()),
    content: z.record(z.string(), z.object({ skills: z.array(z.unknown()), playbooks: z.array(z.unknown()) })).optional(),
});
export function storedPresetObject(row) {
    return {
        key: row.key,
        name: row.name,
        ...(row.description !== undefined ? { description: row.description } : {}),
        bot: row.bot,
        ...(row.playbooks ? { playbooks: row.playbooks } : {}),
        ...(row.skills ? { skills: row.skills } : {}),
        ...(row.seed ? { seed: row.seed } : {}),
    };
}
function resolveRow(row, content) {
    const wantedSkills = new Set(row.skills ?? []);
    const wantedPlaybooks = new Set(row.playbooks ?? []);
    const skills = (content?.skills ?? []).filter((skill) => wantedSkills.has(skill.name));
    const playbooks = (content?.playbooks ?? []).filter((playbook) => wantedPlaybooks.has(playbook.key));
    let document;
    try {
        document = parsePackageDocument({
            format: PACKAGE_FORMAT,
            version: PACKAGE_V2_VERSION,
            package: {
                id: row.packageId,
                release: row.release,
                name: row.packageName,
                tagline: row.packageName,
                summary: row.packageName,
                category: "Presets",
                author: { name: row.publisherName ?? row.packageName },
                license: "Unspecified",
                outcomes: [row.name],
                setupMinutes: 1,
                requirements: { apps: [], capabilities: [] },
                presets: [storedPresetObject(row)],
                ...(skills.length ? { skills: { version: 1, entries: skills } } : {}),
                ...(playbooks.length ? { playbooks } : {}),
            },
        }, { trust: "file" });
    }
    catch {
        return null;
    }
    const pkg = document.package;
    return { row, preset: pkg.presets[0], skills: pkg.skills?.entries ?? [], playbooks: pkg.playbooks ?? [] };
}
export function createPresetStore(file = PRESETS_FILE) {
    const load = () => {
        const empty = { version: 1, presets: [], content: Object.create(null) };
        if (!existsSync(file))
            return empty;
        try {
            const parsed = fileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
            const presets = parsed.presets.flatMap((value) => {
                const row = storedPresetSchema.safeParse(value);
                return row.success ? [row.data] : [];
            });
            const content = Object.create(null);
            // Own entries only: an install id is data from a file.
            for (const [installId, value] of Object.entries(parsed.content ?? {})) {
                content[installId] = { skills: value.skills, playbooks: value.playbooks };
            }
            return { version: 1, presets, content };
        }
        catch {
            return empty;
        }
    };
    const save = (state) => {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const used = new Set(state.presets.map((row) => row.installId));
        const content = Object.create(null);
        for (const [installId, value] of Object.entries(state.content))
            if (used.has(installId))
                content[installId] = value;
        writeFileAtomic(file, JSON.stringify({ version: 1, presets: state.presets, content }, null, 2), { mode: 0o600 });
    };
    const sameFilePreset = (row, candidate, state, content) => row.source === "file" && candidate.source === "file" && row.packageId === candidate.packageId && row.release === candidate.release && row.key === candidate.key &&
        canonicalJson(storedPresetObject(row)) === canonicalJson(storedPresetObject(candidate)) &&
        canonicalJson(usedContent(row, state.content[row.installId])) === canonicalJson(usedContent(candidate, content));
    return {
        list: () => load().presets,
        resolve(id) {
            const state = load();
            const row = state.presets.find((candidate) => candidate.id === id);
            return row ? resolveRow(row, state.content[row.installId]) : null;
        },
        register(document, context) {
            const pkg = document.package;
            const presets = pkg.presets ?? [];
            const added = [];
            const existing = [];
            const skipped = [];
            const org = context.source === "org" ? context.org : undefined;
            if (!presets.length && !org)
                return { added, existing, skipped };
            const state = load();
            const used = new Set(presets.flatMap((preset) => preset.skills ?? []));
            const usedPlaybooks = new Set(presets.flatMap((preset) => preset.playbooks ?? []));
            const content = {
                skills: (pkg.skills?.entries ?? []).filter((skill) => used.has(skill.name)),
                playbooks: (pkg.playbooks ?? []).filter((playbook) => usedPlaybooks.has(playbook.key)),
            };
            const ownRow = (row) => row.source === "org" && row.installId === context.installId;
            let refreshed = false;
            if (org) {
                const keys = new Set(presets.map((preset) => preset.key));
                const kept = state.presets.filter((row) => !ownRow(row) || keys.has(row.key));
                refreshed = kept.length !== state.presets.length;
                state.presets = kept;
            }
            for (const preset of presets) {
                const row = {
                    id: randomUUID(),
                    source: context.source,
                    installId: context.installId,
                    packageId: pkg.id,
                    packageName: pkg.name,
                    release: pkg.release,
                    ...(org ? { publisherName: org.publisher.name, publisher: { ...org.publisher }, ref: org.ref, sha256: org.sha256 } : {}),
                    key: preset.key,
                    name: preset.name,
                    ...(preset.description !== undefined ? { description: preset.description } : {}),
                    bot: structuredClone(preset.bot),
                    ...(preset.playbooks ? { playbooks: [...preset.playbooks] } : {}),
                    ...(preset.skills ? { skills: [...preset.skills] } : {}),
                    ...(preset.seed ? { seed: structuredClone(preset.seed) } : {}),
                    addedAt: Date.now(),
                };
                const own = org ? state.presets.findIndex((candidate) => ownRow(candidate) && candidate.key === preset.key) : -1;
                if (own >= 0) {
                    const previous = state.presets[own];
                    state.presets[own] = { ...row, id: previous.id, addedAt: previous.addedAt };
                    existing.push({ id: previous.id, key: row.key, name: row.name });
                    refreshed = true;
                    continue;
                }
                const same = state.presets.find((candidate) => sameFilePreset(candidate, row, state, content));
                if (same) {
                    existing.push({ id: same.id, key: same.key, name: same.name });
                    continue;
                }
                if (state.presets.length >= MAX_STORED_PRESETS) {
                    skipped.push({ part: `presets[${preset.key}]`, reason: "too_many_presets" });
                    continue;
                }
                state.presets.push(row);
                added.push({ id: row.id, key: row.key, name: row.name });
            }
            if (added.length || refreshed) {
                state.content[context.installId] = content;
                save(state);
            }
            return { added, existing, skipped };
        },
        remove(ids) {
            if (!ids.length)
                return;
            const drop = new Set(ids);
            const state = load();
            const kept = state.presets.filter((row) => !drop.has(row.id));
            if (kept.length === state.presets.length)
                return;
            save({ ...state, presets: kept });
        },
        removeFilePreset(id) {
            const state = load();
            const row = state.presets.find((candidate) => candidate.id === id);
            if (!row)
                return "not_found";
            if (row.source !== "file")
                return "organization";
            save({ ...state, presets: state.presets.filter((candidate) => candidate.id !== id) });
            return "removed";
        },
    };
}
function usedContent(row, content) {
    const skills = new Set(row.skills ?? []);
    const playbooks = new Set(row.playbooks ?? []);
    return {
        skills: (content?.skills ?? []).filter((skill) => skills.has(skill.name)),
        playbooks: (content?.playbooks ?? []).filter((playbook) => playbooks.has(playbook.key)),
    };
}
export function presetOffered(row, statuses) {
    if (row.source !== "org")
        return true;
    const status = statuses.get(row.installId);
    return status !== "withdrawn" && status !== "removed";
}
export function listBotPresets(store, statuses) {
    const wire = [];
    for (const row of store.list()) {
        if (!presetOffered(row, statuses))
            continue;
        const resolved = store.resolve(row.id);
        if (!resolved)
            continue;
        const { preset } = resolved;
        wire.push({
            id: row.id,
            source: row.source,
            key: preset.key,
            name: preset.name,
            ...(preset.description ? { description: preset.description } : {}),
            packageName: row.packageName,
            release: row.release,
            ...(row.source === "org" && row.publisherName ? { publisherName: row.publisherName } : {}),
            bot: preset.bot,
            skills: resolved.skills.map((skill) => ({ name: skill.name, description: skill.description })),
            skillsEnabled: row.source === "org",
            playbooks: resolved.playbooks.map((playbook) => playbook.name),
            notes: Object.keys(preset.seed?.memory ?? {}),
            addedAt: row.addedAt,
        });
    }
    const org = wire.filter((preset) => preset.source === "org")
        .sort((a, b) => (a.publisherName ?? "").localeCompare(b.publisherName ?? "") || a.name.localeCompare(b.name));
    const files = wire.filter((preset) => preset.source === "file").sort((a, b) => b.addedAt - a.addedAt);
    return [...org, ...files].map(({ addedAt: _addedAt, ...preset }) => preset);
}
const ORG_INSTALL_ID = /^[a-f0-9]{32}$/;
export function applyPresetToBot(botId, resolved, deps) {
    const { row, preset } = resolved;
    const org = row.source === "org";
    const stamped = org && Boolean(row.ref) && ORG_INSTALL_ID.test(row.installId);
    const playbooks = (preset.playbooks ?? []).flatMap((key) => {
        const playbook = resolved.playbooks.find((candidate) => candidate.key === key);
        return playbook ? [{ ...playbook, triggers: [...playbook.triggers] }] : [];
    });
    const installed = {
        id: row.packageId,
        name: row.packageName,
        release: row.release,
        requiredApps: [],
        source: row.source,
        installId: row.installId,
        presetKey: row.key,
        ...(org && row.publisher ? { publisher: { ...row.publisher } } : {}),
        ...(org && row.ref ? { ref: row.ref } : {}),
        ...(org && row.sha256 ? { sha256: row.sha256 } : {}),
    };
    deps.store.patchBot(botId, { installedPackage: installed, ...(playbooks.length ? { playbooks } : {}) });
    const skills = [];
    for (const name of preset.skills ?? []) {
        const skill = resolved.skills.find((candidate) => candidate.name === name);
        if (!skill)
            throw new Error(`The preset's skill "${name}" is unavailable`);
        // The organization channel names its own source; a file's is display only.
        const source = org && row.ref ? `org:${row.ref}@${row.release}` : skill.source ?? `package:${row.packageId}`;
        if (stamped) {
            const stamp = { installId: row.installId, key: skill.name, release: row.release, ...pair(skill.instructions, skill.instructions), via: "preset" };
            const added = deps.skills.installOrg(botId, source, skill.instructions, stamp);
            if ("error" in added)
                throw new Error(`The preset's skill "${name}" could not be added: ${added.error}`);
        }
        else {
            const added = deps.skills.install(botId, source, [{ path: "SKILL.md", content: skill.instructions }]);
            if ("error" in added)
                throw new Error(`The preset's skill "${name}" could not be added: ${added.error}`);
            if (org) {
                const enabled = deps.skills.setEnabled(botId, name, true);
                if ("error" in enabled)
                    throw new Error(`The preset's skill "${name}" could not be switched on: ${enabled.error}`);
            }
        }
        skills.push(name);
    }
    let notes = 0;
    for (const [path, value] of Object.entries(preset.seed?.memory ?? {})) {
        if (path === "MEMORY.md")
            deps.memory.writeIndex(botId, value);
        else
            deps.memory.writeTopic(botId, path.slice("memory/".length), value);
        notes += 1;
    }
    return { skills, notes };
}
function isPortableSource(value) {
    return !/^(?:[a-z]:[\\/]|[\\/]|\\\\|file:)/i.test(value);
}
/** The defaults reduced to the preset allowlist: never the model, folder, computer, approval level, apps, MCP servers, browser, peers, Chief or routines. */
export function presetFromDefaults(defaults, options) {
    const skipped = [];
    const profile = defaults?.profile ?? {};
    const part = `presets[${DEFAULTS_PRESET_KEY}]`;
    const trimmed = (value) => (value?.trim() ? value : undefined);
    const bot = {
        ...(trimmed(profile.name) ? { name: profile.name.trim() } : {}),
        ...(trimmed(profile.title) ? { title: profile.title.trim() } : {}),
        ...(trimmed(profile.description) ? { description: profile.description.trim() } : {}),
        ...(trimmed(profile.soul) ? { soul: profile.soul } : {}),
    };
    const mascotExpression = profile.mascotExpression?.trim() || undefined;
    const mascotBody = profile.mascotBody?.trim() || undefined;
    if (profile.color || mascotExpression || mascotBody || options.avatar) {
        const crop = profile.avatarCrop === "rounded" || profile.avatarCrop === "square" ? profile.avatarCrop : "circle";
        bot.appearance = {
            color: profile.color ?? "green",
            ...(mascotExpression ? { mascotExpression } : {}),
            ...(mascotBody ? { mascotBody } : {}),
            ...(options.avatar ? { avatar: { ...options.avatar, crop } } : {}),
        };
    }
    const skills = [];
    for (const template of defaults?.skills ?? []) {
        const parsed = parseSkillMd(template.text);
        if ("error" in parsed || parsed.name !== template.name) {
            skipped.push({ part: `${part}.skills[${template.name}]`, reason: "skill_changed" });
            continue;
        }
        if (skills.length >= AGENT_MAX_SKILLS) {
            skipped.push({ part: `${part}.skills[${template.name}]`, reason: "bot_skill_limit" });
            continue;
        }
        skills.push({
            name: parsed.name,
            description: parsed.description,
            ...(template.source && isPortableSource(template.source) ? { source: template.source } : {}),
            ...(parsed.license ? { license: parsed.license } : {}),
            ...(parsed.compatibility ? { compatibility: parsed.compatibility } : {}),
            instructions: template.text,
            enabled: template.enabled,
        });
    }
    const memory = {};
    if (options.includeNotes) {
        let files = 0;
        let total = 0;
        for (const path of Object.keys(defaults?.memory ?? {}).sort((a, b) => (a === "MEMORY.md" ? -1 : b === "MEMORY.md" ? 1 : a.localeCompare(b)))) {
            const value = defaults.memory[path];
            if (!value.trim())
                continue;
            const bytes = utf8Bytes(value);
            if (bytes > SEED_FILE_MAX_BYTES || files >= SEED_MAX_FILES || total + bytes > SEED_MAX_BYTES) {
                skipped.push({ part: `${part}.seed.memory[${JSON.stringify(path)}]`, reason: "notes_too_large" });
                continue;
            }
            memory[path] = value;
            files += 1;
            total += bytes;
        }
    }
    const hasContent = Object.keys(bot).length > 0 || skills.length > 0 || Object.keys(memory).length > 0;
    if (!hasContent) {
        skipped.push({ part, reason: "preset_empty" });
        return { value: null, skipped };
    }
    const name = (options.name?.trim() || profile.name?.trim() || "New bot").slice(0, 100).trim();
    const description = options.description?.trim().slice(0, 300) || undefined;
    return {
        value: {
            preset: {
                key: DEFAULTS_PRESET_KEY,
                name,
                ...(description ? { description } : {}),
                bot,
                ...(skills.length ? { skills: skills.map((skill) => skill.name) } : {}),
                ...(Object.keys(memory).length ? { seed: { memory } } : {}),
            },
            skills,
        },
        skipped,
    };
}
const publishedLibrarySchema = z.object({ version: z.literal(1), packageId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(80), lastRelease: z.string().min(1).max(30) });
export function readPublishedLibrary(file = PUBLISHED_LIBRARY_FILE) {
    try {
        const parsed = publishedLibrarySchema.parse(JSON.parse(readFileSync(file, "utf8")));
        return { packageId: parsed.packageId, lastRelease: parsed.lastRelease };
    }
    catch {
        return null;
    }
}
export function writePublishedLibrary(entry, file = PUBLISHED_LIBRARY_FILE) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileAtomic(file, JSON.stringify({ version: 1, ...entry }, null, 2), { mode: 0o600 });
}
