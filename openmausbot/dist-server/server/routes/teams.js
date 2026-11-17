import { z } from "zod";
import { MAX_TEAM_BACKUP_BYTES } from "../../shared/team-backup.js";
import { validateBotCwd } from "../bot-cwd.js";
import { fetchBotDirectory, matchDirectoryBots } from "../bot-directory.js";
import { isBotPackage, packageSummary, parsePackageDocument, renderBotPackageMarkdown } from "../bot-package.js";
import { parseVisibility } from "../bot-visibility.js";
import { teamCreator } from "../new-bot-sharing.js";
import { TeamExportError, createBotPackageExport, createLibraryPackageExport, createTeamPackageExport, } from "../package-export.js";
import { PackageImportError, importPackageDocument, importTeamManifest, } from "../package-import.js";
import { readPublishedLibrary, writePublishedLibrary } from "../presets.js";
import { scoutProject, suggestTeam } from "../project-scout.js";
import { readPublishedTeam, writePublishedTeam } from "../published-teams.js";
import { readSectionContext } from "../section-context.js";
import { sectionKey } from "../store.js";
import { createTeamBackup, importTeamBackup } from "../team-backup.js";
import { fetchGithubTeam, fetchLibraryTeam, fetchTeamCatalog } from "../team-library.js";
import { createTeamManifest, parseTeamManifest } from "../team-manifest.js";
import { userErrorFields } from "../user-errors.js";
import { PASS } from "./table.js";
export function createTeamRoutes(deps) {
    const routinesFor = (auth) => {
        const all = deps.routines().listRoutines();
        const shown = deps.routineShown?.(auth);
        return shown ? all.filter(shown) : all;
    };
    const { store, cfg, broadcast, publicBot, publicGroupState, groupWithThread, defaultSelection, defaultsPresetFor, packageImportDeps, starterNotes, checkedExportSkillNames, collectExportSkills, collectTeamSkills, } = deps;
    return async ({ req, res, url, path, method, auth, json, readBody }) => {
        let m = null;
        const routines = deps.routines();
        const orgLibrary = deps.orgLibrary();
        if (method === "POST" && path === "/api/teams/export") {
            const body = await readBody(req, 8 * 1024 * 1024);
            const botShown = deps.botShown?.(auth), exportable = botShown ? store.bots.filter((bot) => botShown(bot.id)) : store.bots;
            const profileName = deps.authorName(auth);
            if (body.format === "package" && body.version === 2 && body.kind === "library") {
                const optional = (value) => (typeof value === "string" ? value : undefined);
                const built = defaultsPresetFor(body, body.includeMemory === true);
                try {
                    const exported = createLibraryPackageExport({
                        name: optional(body.name),
                        tagline: optional(body.tagline),
                        summary: optional(body.summary),
                        release: optional(body.release),
                        notes: optional(body.notes),
                        authorName: profileName,
                        published: readPublishedLibrary(),
                        preset: built.preset,
                        skipped: built.skipped,
                    });
                    if (body.dryRun !== true)
                        writePublishedLibrary(exported.published);
                    return json(res, 200, {
                        document: exported.document,
                        filename: exported.filename,
                        redacted: exported.redacted,
                        skipped: exported.skipped,
                        summary: packageSummary(exported.document),
                    });
                }
                catch (error) {
                    if (error instanceof TeamExportError)
                        return json(res, error.status, { error: error.message, ...userErrorFields(error) });
                    throw error;
                }
            }
            if (body.format === "package" && body.version === 2) {
                if (typeof body.team !== "string")
                    return json(res, 400, { error: "Choose a team to share." });
                const team = body.team.trim();
                if (team && !store.sections.includes(team) && !exportable.some((bot) => sectionKey(bot.section) === team)) {
                    return json(res, 404, { error: "That team no longer exists." });
                }
                const optional = (value) => (typeof value === "string" ? value : undefined);
                const teamBots = exportable.filter((bot) => !bot.hidden && sectionKey(bot.section) === team);
                const skills = collectTeamSkills(teamBots, body.skills);
                if (!skills.ok)
                    return json(res, 400, { error: skills.error, choices: { skills: skills.available } });
                const avatars = body.avatars && typeof body.avatars === "object" && !Array.isArray(body.avatars)
                    ? body.avatars
                    : undefined;
                const defaults = body.includeDefaultsPreset === true ? defaultsPresetFor(body, body.includeMemory === true) : null;
                try {
                    const exported = createTeamPackageExport({
                        team,
                        name: optional(body.name),
                        tagline: optional(body.tagline),
                        summary: optional(body.summary),
                        release: optional(body.release),
                        notes: optional(body.notes),
                        authorName: profileName,
                        bots: exportable,
                        groups: store.groups,
                        routines: routinesFor(auth),
                        brief: readSectionContext(team)?.text,
                        published: readPublishedTeam(team),
                        skillsByBot: skills.skillsByBot,
                        skillSelection: skills.all ? "all" : "chosen",
                        memoryByBot: body.includeMemory === true ? new Map(teamBots.map((bot) => [bot.id, starterNotes(bot.id)])) : undefined,
                        avatars,
                        mcpServers: cfg.mcpServers ?? {},
                        skipped: [...skills.skipped, ...(defaults?.skipped ?? [])],
                        preset: defaults?.preset ?? null,
                    });
                    if (body.dryRun !== true)
                        writePublishedTeam(team, exported.published);
                    return json(res, 200, {
                        document: exported.document,
                        filename: exported.filename,
                        redacted: exported.redacted,
                        skipped: exported.skipped,
                        summary: packageSummary(exported.document),
                        choices: { skills: skills.available },
                    });
                }
                catch (error) {
                    if (error instanceof TeamExportError)
                        return json(res, error.status, { error: error.message, ...userErrorFields(error), choices: { skills: skills.available } });
                    throw error;
                }
            }
            const name = typeof body.name === "string" && body.name.trim()
                ? body.name.trim()
                : profileName
                    ? `${profileName}'s Team`
                    : "My OpenMaus Team";
            const memberIds = exportable.filter((bot) => !bot.hidden).map((bot) => bot.id);
            if ((body.format === "backup" ? exportable.length : memberIds.length) === 0)
                return json(res, 400, { error: "Create a bot before exporting your team" });
            try {
                if (body.format === "backup") {
                    return json(res, 200, createTeamBackup(store, routinesFor(auth), name, deps.threadShown?.(auth)));
                }
                if (body.format === "package") {
                    const selectedBots = exportable.filter((bot) => !bot.hidden);
                    const skillNames = checkedExportSkillNames(body.skillIds, selectedBots);
                    if (!skillNames.ok)
                        return json(res, 400, { error: skillNames.error });
                    const document = createBotPackageExport({
                        name,
                        authorName: profileName,
                        bots: selectedBots,
                        groups: store.groups,
                        routines: routinesFor(auth),
                        skillsByBot: collectExportSkills(selectedBots, skillNames.names),
                    });
                    return json(res, 200, {
                        name: document.package.name,
                        members: document.package.agents.length,
                        markdown: renderBotPackageMarkdown(document),
                    });
                }
                return json(res, 200, createTeamManifest({
                    name,
                    memberIds,
                }, exportable));
            }
            catch (error) {
                return json(res, 400, { error: error instanceof Error ? error.message : "Team could not be exported" });
            }
        }
        if (method === "GET" && path === "/api/team-library/catalog") {
            try {
                return json(res, 200, await fetchTeamCatalog());
            }
            catch (error) {
                return json(res, 502, { error: error instanceof Error ? error.message : "The team library is unavailable" });
            }
        }
        m = path.match(/^\/api\/team-library\/teams\/([a-z0-9][a-z0-9-]*)$/);
        if (m && method === "GET") {
            try {
                return json(res, 200, await fetchLibraryTeam(m[1]));
            }
            catch (error) {
                const status = error.status === 404 ? 404 : 502;
                return json(res, status, { error: error instanceof Error ? error.message : "The team could not be loaded" });
            }
        }
        if (method === "POST" && path === "/api/team-library/github") {
            const body = await readBody(req);
            if (typeof body.url !== "string" || !body.url.trim()) {
                return json(res, 400, { error: "A GitHub URL is required" });
            }
            try {
                return json(res, 200, await fetchGithubTeam(body.url));
            }
            catch (error) {
                const status = error.status === 404 ? 404 : 400;
                return json(res, status, { error: error instanceof Error ? error.message : "The GitHub team could not be loaded" });
            }
        }
        if (method === "GET" && path === "/api/teams/scout") {
            // Creates nothing: bots exist only once the person sends the manifest to /api/teams/import.
            const validated = validateBotCwd(url.searchParams.get("cwd"));
            if (!validated.ok)
                return json(res, 400, { error: validated.error });
            if (!validated.cwd)
                return json(res, 400, { error: "scout needs a folder to read" });
            const profile = scoutProject(validated.cwd);
            return json(res, 200, { profile, suggestion: suggestTeam(profile) });
        }
        if (method === "GET" && path === "/api/teams/scout/directory") {
            const validated = validateBotCwd(url.searchParams.get("cwd"));
            if (!validated.ok)
                return json(res, 400, { error: validated.error });
            if (!validated.cwd)
                return json(res, 400, { error: "scout needs a folder to read" });
            let directory = [];
            try {
                directory = matchDirectoryBots(scoutProject(validated.cwd), await fetchBotDirectory());
            }
            catch (error) {
                console.warn("bot directory lookup failed:", error instanceof Error ? error.message : String(error));
            }
            return json(res, 200, { directory });
        }
        if (method === "GET" && path === "/api/org-library") {
            return json(res, 200, orgLibrary?.list() ?? { organization: null, packages: [] });
        }
        m = path.match(/^\/api\/org-library\/packages\/([a-f0-9-]{36})$/);
        if (m && method === "GET") {
            const outcome = orgLibrary?.preview(m[1]);
            if (!outcome)
                return json(res, 404, { error: "This package is not in your organization's library.", code: "not_listed" });
            return outcome.ok ? json(res, 200, outcome.value) : json(res, outcome.status, { error: outcome.error, code: outcome.code });
        }
        if (method === "POST" && path === "/api/org-library/add") {
            const body = await readBody(req);
            const packageId = typeof body?.packageId === "string" && /^[a-f0-9-]{36}$/.test(body.packageId) ? body.packageId : null;
            if (!packageId)
                return json(res, 400, { error: "Choose a package from your organization's library." });
            if (!orgLibrary)
                return json(res, 404, { error: "This package is not in your organization's library.", code: "not_listed" });
            const outcome = orgLibrary.add(packageId, { ...packageImportDeps(await defaultSelection()), ...teamCreator(auth) });
            if (!outcome.ok)
                return json(res, outcome.status, { error: outcome.error, code: outcome.code });
            if (outcome.value.alreadyAdded)
                return json(res, 200, outcome.value);
            const imported = outcome.value.result;
            return json(res, 201, {
                alreadyAdded: false,
                installId: imported.installId,
                name: imported.name,
                section: imported.section,
                bots: imported.bots.map((bot) => publicBot(store.bot(bot.id) ?? bot)),
                groups: imported.groups.map((created) => ({ ...publicGroupState(store.group(created.id) ?? created), messages: [] })),
                routines: imported.routines,
                offeredSkills: imported.offeredSkills,
                connections: imported.connections,
                skipped: imported.skipped,
                brief: imported.brief,
                notes: imported.notes,
                presets: imported.presets ?? [],
            });
        }
        if (method === "GET" && path === "/api/org-library/skills") {
            const botId = url.searchParams.get("botId") ?? undefined;
            return json(res, 200, orgLibrary?.offeredSkills(botId) ?? { organization: null, skills: [] });
        }
        if (method === "POST" && path === "/api/org-library/skills") {
            const body = await readBody(req);
            const parsed = z.object({ botId: z.string().min(1).max(128), installId: z.string().regex(/^[a-f0-9]{32}$/), name: z.string().min(1).max(64) })
                .safeParse(body);
            if (!parsed.success)
                return json(res, 400, { error: "Choose a bot and a skill from your organization's library." });
            if (!orgLibrary)
                return json(res, 404, { error: "This package is not in your organization's library.", code: "not_listed" });
            const outcome = orgLibrary.addOfferedSkill(parsed.data.botId, parsed.data.installId, parsed.data.name);
            return outcome.ok ? json(res, 201, { skill: outcome.value }) : json(res, outcome.status, { error: outcome.error, code: outcome.code });
        }
        if (method === "POST" && path === "/api/teams/import") {
            // Additive-only: a manifest is untrusted, so every member becomes a NEW bot and none can name an existing bot or room.
            const importMode = url.searchParams.get("mode") ?? "add";
            if (importMode === "replace") {
                return json(res, 400, { error: "Replacing your team is no longer supported. Reopen Import in the updated app to add bots alongside your existing conversations." });
            }
            if (importMode !== "add" && importMode !== "project") {
                return json(res, 400, { error: "Team import mode must be add or project" });
            }
            // No format can point at an existing room or choose a folder: workspace access comes only from this parameter.
            let projectCwd = null;
            if (importMode === "project") {
                const requested = url.searchParams.get("cwd");
                if (requested !== null) {
                    const validated = validateBotCwd(requested);
                    if (!validated.ok)
                        return json(res, 400, { error: validated.error });
                    projectCwd = validated.cwd;
                }
            }
            // The admin's choice, never the file's.
            const rawVisibility = url.searchParams.get("visibility");
            let importVisibility;
            if (rawVisibility !== null) {
                let value = rawVisibility;
                if (rawVisibility.trim().startsWith("{")) {
                    try {
                        value = JSON.parse(rawVisibility);
                    }
                    catch {
                    }
                }
                const parsed = parseVisibility(value);
                if (!parsed.ok)
                    return json(res, 400, { error: parsed.error });
                importVisibility = parsed.visibility;
            }
            const body = await readBody(req, MAX_TEAM_BACKUP_BYTES);
            if (body?.format === "openmaus.backup") {
                if (importMode !== "add")
                    return json(res, 400, { error: "Import backups alongside your existing bots; project mode is only for templates" });
                try {
                    const imported = importTeamBackup(store, routines, body, await defaultSelection(), { visibility: importVisibility, ...teamCreator(auth) });
                    // A restore writes transcripts without store events: these frames carry the restored pages to other clients.
                    const bots = imported.bots.map((bot) => publicBot(bot));
                    const groups = imported.groups.map((group) => groupWithThread(group));
                    for (const bot of bots)
                        broadcast({ kind: "bot", bot });
                    for (const group of groups)
                        broadcast({ kind: "group", group });
                    return json(res, 201, { ...imported, bots, groups });
                }
                catch (error) {
                    return json(res, 400, { error: error instanceof Error ? error.message : "Backup could not be imported" });
                }
            }
            // Read as a FILE: it cannot claim a publisher, its skills and routines arrive off; only the org library imports with trust "org".
            let packageDocument = null;
            let manifest = null;
            try {
                if (isBotPackage(body))
                    packageDocument = parsePackageDocument(body, { trust: "file" });
                else
                    manifest = parseTeamManifest(body);
            }
            catch (error) {
                return json(res, 400, { error: error instanceof Error ? error.message : "Invalid bot package" });
            }
            const deps = { ...packageImportDeps(await defaultSelection()), ...teamCreator(auth) };
            const options = {
                mode: importMode,
                cwd: projectCwd,
                room: url.searchParams.get("room") ?? undefined,
                ...(importVisibility ? { visibility: importVisibility } : {}),
            };
            let imported;
            try {
                const result = packageDocument
                    ? importPackageDocument(packageDocument, { ...options, trust: "file" }, deps)
                    : importTeamManifest(manifest, options, deps);
                if (result.alreadyAdded)
                    return json(res, 200, result);
                imported = result;
            }
            catch (error) {
                if (error instanceof PackageImportError)
                    return json(res, error.status, { error: error.message, code: error.code });
                throw error;
            }
            return json(res, 201, {
                name: imported.name,
                section: imported.section,
                bots: imported.bots.map((bot) => publicBot(store.bot(bot.id) ?? bot)),
                group: imported.group,
                groups: imported.groups.map((created) => ({ ...created, messages: [] })),
                routines: imported.routines,
                offeredSkills: imported.offeredSkills,
                connections: imported.connections,
                skipped: imported.skipped,
                brief: imported.brief,
                notes: imported.notes,
                presets: imported.presets ?? [],
            });
        }
        return PASS;
    };
}
