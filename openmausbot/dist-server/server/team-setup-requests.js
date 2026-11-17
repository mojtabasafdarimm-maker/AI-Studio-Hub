import { createHash } from "node:crypto";
import { botOwner, chiefScope } from "../shared/bot-owner.js";
import { z } from "zod";
import { soulDiffLines } from "../shared/line-diff.js";
import { newId } from "./contracts.js";
import { fitsOnOneLine, parseBotProfilePatch } from "./bot-profile.js";
import { profileSnapshot } from "./profile-revision.js";
import { recordProfileChange } from "./profile-versions.js";
import { validateBotCwd } from "./bot-cwd.js";
import { UNDO_STALE } from "./direct-apply.js";
import { harnessCapabilityLines } from "./harness-capabilities.js";
import { redactSecretsInText } from "./redact.js";
import { chiefLevel } from "./chief-level.js";
import { defaultBotRefusal } from "./default-bot.js";
import { outsideDepartmentReason } from "./peer-roster.js";
const section = (value) => value?.trim() || "";
const teamName = z.string().trim().min(1).max(60).refine(fitsOnOneLine).refine((value) => redactSecretsInText(value) === value, "Team names cannot contain credentials");
const FIELD_LABELS = { name: "Name", title: "Title", description: "Description", section: "Department", cwd: "Working folder" };
const modelSelectionText = (selection) => `${selection.instanceId}/${selection.model}${selection.variant ? ` (variant ${selection.variant})` : " (no variant)"}${selection.effort ? ` (effort ${selection.effort})` : ""}`;
/** One setup may edit a whole department at once (a model switch, an added rule), but each new bot still needs a close review. */
const MAX_SETUP_BOTS = 40;
const MAX_NEW_BOTS = 8;
const fieldsSchema = z.object({
    chiefOfStaff: z.boolean().optional(),
    name: z.string().optional(), title: z.string().optional(), description: z.string().optional(), soul: z.string().optional(),
    soulAppend: z.string().trim().min(1).optional(),
    cwd: z.string().optional(),
    section: z.string().trim().max(60).refine(fitsOnOneLine).refine((value) => redactSecretsInText(value) === value, "Team names cannot contain credentials").optional(),
    modelSelection: z.object({ instanceId: z.string().trim().min(1), model: z.string().trim().min(1), effort: z.string().optional(), variant: z.string().optional() }).strict().optional(),
}).strict();
const planSchema = z.object({
    reason: z.string().trim().min(1).max(500),
    newTeams: z.array(teamName).max(8).default([]),
    operations: z.array(z.discriminatedUnion("action", [
        z.object({ action: z.literal("create"), key: z.string().trim().min(1).max(80), fields: fieldsSchema }).strict(),
        z.object({ action: z.literal("update"), botId: z.string().min(1).max(128), fields: fieldsSchema }).strict(),
    ])).min(1).max(MAX_SETUP_BOTS, `Review at most ${MAX_SETUP_BOTS} bots in one setup`),
}).strict();
function takenKeys(path) {
    const last = path.at(-1);
    if (last === "fields")
        return Object.keys(fieldsSchema.shape).join(", ");
    if (last === "modelSelection")
        return "instanceId, model, effort, variant";
    return path.length ? "action, key (create) or botId (update), fields" : Object.keys(planSchema.shape).join(", ");
}
function planProblem(error) {
    const issue = error.issues[0];
    if (issue?.code !== "unrecognized_keys")
        return issue?.message ?? "Invalid team setup";
    return `${issue.path.length ? `${issue.path.map(String).join(".")}: ` : ""}${issue.message}. It takes ${takenKeys(issue.path)}.`;
}
export class TeamSetupError extends Error {
    status;
    code;
    constructor(message, status = 400, code) { super(message); this.status = status; this.code = code; }
}
/** Without `fields` (deletions) any drift cancels; with them it pins only the before-values the card showed, and authority is re-checked at confirm. */
export function teamSetupRevision(bot, fields) {
    if (fields === undefined) {
        return createHash("sha256").update(JSON.stringify({
            ...profileSnapshot(bot), section: section(bot.section), modelSelection: bot.modelSelection,
            hidden: Boolean(bot.hidden), chiefOfStaff: Boolean(bot.chiefOfStaff),
            managedSections: bot.managedSections,
            approvalMode: bot.approvalMode, autoApprove: bot.autoApprove, approvalGrant: bot.approvalGrant,
            receipt: bot.lastTeamSetupReceipt?.requestId,
        })).digest("hex");
    }
    const snapshot = profileSnapshot(bot);
    const scope = {};
    if (fields.name !== undefined)
        scope.name = snapshot.name;
    if (fields.title !== undefined)
        scope.title = snapshot.title;
    if (fields.description !== undefined)
        scope.description = snapshot.description;
    if (fields.soul !== undefined)
        scope.soul = snapshot.soul;
    if (fields.section !== undefined)
        scope.section = section(bot.section);
    if (fields.modelSelection !== undefined)
        scope.modelSelection = bot.modelSelection;
    if (fields.chiefOfStaff !== undefined)
        scope.chiefOfStaff = Boolean(bot.chiefOfStaff);
    return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}
export class TeamSetupRequestService {
    resolving = new Set();
    options;
    constructor(options) { this.options = options; }
    chief(botId) {
        const chief = this.options.store.bot(botId);
        if (!chief || chief.hidden || !chiefLevel(chief))
            throw new TeamSetupError("Only an active Chief of Staff can propose team setup", 403);
        return chief;
    }
    requesterScope(request) {
        if (request.deletion)
            return undefined;
        const scope = {};
        for (const operation of request.operations)
            if (operation.botId === request.botId)
                Object.assign(scope, operation.fields);
        return scope;
    }
    fields(input, current) {
        const { section: targetSection, modelSelection, chiefOfStaff, cwd: rawCwd, ...profile } = input;
        const safe = Object.fromEntries(Object.entries(profile).map(([key, value]) => [key, redactSecretsInText(value)]));
        const parsed = parseBotProfilePatch(safe, true);
        if (!parsed.ok)
            throw new TeamSetupError(parsed.error);
        const result = { ...parsed.patch };
        if (targetSection !== undefined)
            result.section = targetSection;
        if (chiefOfStaff !== undefined)
            result.chiefOfStaff = chiefOfStaff;
        if (rawCwd !== undefined) {
            if (current)
                throw new TeamSetupError("A working folder can only be chosen when creating a bot; propose_profile changes it later");
            const checked = validateBotCwd(rawCwd);
            if (!checked.ok)
                throw new TeamSetupError(checked.error);
            result.cwd = checked.cwd ?? "";
        }
        if (modelSelection) {
            const selection = modelSelection;
            const error = this.options.validateModel(selection, current);
            if (error)
                throw new TeamSetupError(error);
            result.modelSelection = selection;
        }
        return result;
    }
    validate(request, confirming, immediate = false) {
        const chief = this.chief(request.botId);
        if (!this.options.ownsThread(request.botId, request.threadId))
            throw new TeamSetupError("The requesting conversation no longer exists", 409);
        if (immediate && !this.options.autoApply?.(request.botId, request.threadId))
            throw new TeamSetupError("This conversation can no longer apply team setup on its own; ask the owner", 409);
        if (confirming && !immediate && !this.options.store.messagesFor(request.threadId).some((message) => message.card?.requestId === request.requestId && !message.card.answered && !message.card.dismissed))
            throw new TeamSetupError("This setup card is no longer pending", 409);
        if (confirming && teamSetupRevision(chief, this.requesterScope(request)) !== request.requesterRevision)
            throw new TeamSetupError("The Chief's settings changed. This setup was cancelled; review a new proposal.", 409);
        const existingTeams = new Set(this.options.teams().map(section));
        if (new Set([...(chief.managedSections ?? []), ...request.newTeams]).size > 100)
            throw new TeamSetupError("A Chief may coordinate at most 100 additional teams", 409);
        for (const name of request.newTeams)
            if (existingTeams.has(name))
                throw new TeamSetupError(`Team ${JSON.stringify(name)} now exists. Review a new proposal.`, 409);
        const allowed = (name) => request.newTeams.includes(section(name)) || this.options.hasTeamAuthority(chief, name);
        const targets = new Set();
        const projected = this.options.store.bots.map((bot) => ({ id: bot.id, name: bot.name, section: section(bot.section), chiefOfStaff: bot.chiefOfStaff, hidden: bot.hidden, createdBy: bot.createdBy, reportsTo: bot.reportsTo }));
        for (const operation of request.operations) {
            if (targets.has(operation.botId))
                throw new TeamSetupError("A bot appears twice in the prepared setup");
            targets.add(operation.botId);
            const target = this.options.store.bot(operation.botId);
            if (operation.action === "create") {
                if (target)
                    throw new TeamSetupError("A proposed bot already exists. Review a new proposal.", 409);
                if (!operation.fields.name?.trim() || !operation.fields.title?.trim() || !operation.fields.soul?.trim() || !operation.fields.modelSelection)
                    throw new TeamSetupError("Each new bot needs a name, title, soul instructions, and exact model selection");
            }
            else {
                if (!target || target.hidden)
                    throw new TeamSetupError("A target bot is outside this Chief's authorized team", 403);
                if (!this.options.hasTeamAuthority(chief, target.section))
                    throw new TeamSetupError(outsideDepartmentReason(chief, target), 403);
                if (teamSetupRevision(target, operation.fields) !== operation.expectedRevision)
                    throw new TeamSetupError(`@${target.name} changed. This setup was cancelled; review a new proposal.`, 409);
                const sourceThreadId = immediate && target.id === chief.id ? request.threadId : undefined;
                if (this.options.targetBusy(target.id, sourceThreadId) && (confirming || target.id !== chief.id))
                    throw new TeamSetupError(`Stop @${target.name}'s work before changing its setup`, 409);
            }
            const fields = this.fields(operation.fields, target ?? undefined);
            if (fields.chiefOfStaff !== undefined && !chief.chiefOfStaff)
                throw new TeamSetupError(`Only the Chief of Staff changes who the Chief is; ${chief.name} doesn't.`, 403);
            if (confirming && target)
                this.options.validateChange?.(target, fields);
            const destination = fields.section ?? target?.section ?? chief.section;
            if (!allowed(destination))
                throw new TeamSetupError(outsideDepartmentReason(chief, { section: destination }), 403);
            if (!request.newTeams.includes(section(destination)) && !existingTeams.has(section(destination)))
                throw new TeamSetupError("The destination team no longer exists", 409);
            const next = { id: operation.botId, name: fields.name ?? target.name, section: section(destination), chiefOfStaff: fields.chiefOfStaff ?? target?.chiefOfStaff, hidden: false,
                createdBy: target ? target.createdBy : botOwner(chief) ?? undefined, reportsTo: target?.reportsTo };
            const at = projected.findIndex((bot) => bot.id === operation.botId);
            if (at < 0)
                projected.push(next);
            else
                projected[at] = next;
        }
        const creating = request.operations.filter((op) => op.action === "create").length;
        if (this.options.store.bots.length + creating > this.options.maxBots)
            throw new TeamSetupError("This setup exceeds the workspace bot limit", 409);
        for (const name of request.newTeams)
            if (!request.operations.some((op) => section(op.fields.section) === name))
                throw new TeamSetupError(`New team ${JSON.stringify(name)} needs a specialist in this setup`);
        for (const operation of request.operations) {
            const candidate = projected.find((bot) => bot.id === operation.botId);
            if (projected.some((bot) => bot.id !== candidate.id && !bot.hidden && bot.section === candidate.section && bot.name.trim().toLowerCase() === candidate.name.trim().toLowerCase()))
                throw new TeamSetupError(`@${candidate.name} already exists in that team`, 409);
            if (candidate.chiefOfStaff && projected.some((bot) => bot.id !== candidate.id && bot.chiefOfStaff && chiefScope(bot) === chiefScope(candidate)))
                throw new TeamSetupError("Each team can have one Chief. Include the current Chief's demotion in this plan.", 409);
        }
        if (request.deletion) {
            const target = this.options.store.bot(request.deletion.botId);
            if (!target || target.hidden || target.id === chief.id)
                throw new TeamSetupError("This deletion target is no longer an authorized teammate", 403);
            if (!this.options.hasTeamAuthority(chief, target.section))
                throw new TeamSetupError(outsideDepartmentReason(chief, target), 403);
            if (target.defaultBot)
                throw new TeamSetupError(defaultBotRefusal(target.name), 409);
            if (teamSetupRevision(target) !== request.deletion.expectedRevision || this.options.targetBusy(target.id))
                throw new TeamSetupError("The deletion target changed or is working. Review a new deletion proposal.", 409);
        }
    }
    prepare(args) {
        const parsed = planSchema.safeParse(args.plan);
        if (!parsed.success)
            throw new TeamSetupError(planProblem(parsed.error));
        const chief = this.chief(args.botId);
        const combined = new Map();
        for (const operation of parsed.data.operations) {
            const key = operation.action === "create" ? `create:${operation.key}` : `update:${operation.botId}`;
            const previous = combined.get(key);
            if (operation.fields.soul !== undefined && operation.fields.soulAppend !== undefined)
                throw new TeamSetupError("Use either soul or soulAppend for a bot, not both");
            // Repeated added rules for one bot all land, in order; any other repeated field keeps its last value.
            const soulAppend = [previous?.fields.soulAppend, operation.fields.soulAppend].filter(Boolean).join("\n\n") || undefined;
            combined.set(key, { ...operation, fields: { ...previous?.fields, ...operation.fields, soulAppend } });
        }
        const entries = [...combined.values()];
        if (entries.filter((operation) => operation.action === "create").length > MAX_NEW_BOTS)
            throw new TeamSetupError(`Review at most ${MAX_NEW_BOTS} new bots in one setup`);
        const operations = entries.map((operation) => {
            const target = operation.action === "update" ? this.options.store.bot(operation.botId) : undefined;
            const { soulAppend, ...requested } = operation.fields;
            if (soulAppend !== undefined) {
                if (operation.action === "create")
                    throw new TeamSetupError("soulAppend only adds to an existing bot's instructions; give a new bot its full soul");
                if (requested.soul !== undefined)
                    throw new TeamSetupError("Use either soul or soulAppend for a bot, not both");
                // A bot this Chief may not change is never read here; validate() refuses it.
                if (target && !target.hidden && this.options.hasTeamAuthority(chief, target.section)) {
                    // Re-saving runs the whole text through redaction; never let an added rule rewrite what the bot already had.
                    // Check the joined text: an added rule can complete a pattern that starts in the existing instructions.
                    const kept = (target.soul ?? "").trimEnd();
                    const joined = kept ? `${kept}\n\n${soulAppend}` : soulAppend;
                    if (!redactSecretsInText(joined).startsWith(kept))
                        throw new TeamSetupError(`@${target.name}'s instructions hold credential-like text; change them with a full soul instead`);
                    requested.soul = joined;
                }
            }
            const fields = this.fields({ ...requested, section: requested.section ?? target?.section ?? chief.section ?? "" }, target ?? undefined);
            return { action: operation.action, botId: operation.action === "create" ? newId() : operation.botId,
                ...(operation.action === "create" ? { threadId: newId() } : {}),
                fields,
                ...(target ? { expectedRevision: teamSetupRevision(target, fields) } : {}),
            };
        });
        const requesterScope = {};
        for (const operation of operations)
            if (operation.botId === chief.id)
                Object.assign(requesterScope, operation.fields);
        const request = { version: 1, requestId: newId(), botId: args.botId, threadId: args.threadId,
            reason: redactSecretsInText(parsed.data.reason), createdAt: Date.now(), requesterRevision: teamSetupRevision(chief, requesterScope),
            newTeams: [...new Set(parsed.data.newTeams)], operations };
        this.validate(request, false);
        return request;
    }
    prepareDeletion(args) {
        const chief = this.chief(args.botId);
        const target = this.options.store.bot(args.targetBotId);
        if (!target)
            throw new TeamSetupError("That bot no longer exists", 404);
        if (!args.reason.trim() || args.reason.length > 500)
            throw new TeamSetupError("A deletion reason of at most 500 characters is required");
        const request = { version: 1, requestId: newId(), botId: args.botId, threadId: args.threadId,
            reason: redactSecretsInText(args.reason), createdAt: Date.now(), requesterRevision: teamSetupRevision(chief), newTeams: [], operations: [],
            deletion: { botId: target.id, name: target.name, expectedRevision: teamSetupRevision(target) } };
        this.validate(request, false);
        return request;
    }
    propose(args) { return this.card(this.prepare(args), args.from); }
    proposeDeletion(args) { return this.card(this.prepareDeletion(args), args.from); }
    async submit(args) {
        const grant = this.options.autoApply?.(args.botId, args.threadId) ?? null;
        if (grant)
            return { ...await this.applyImmediately(this.prepare(args), args.from, args.canCommit), appliedBy: grant };
        return { ...this.propose(args), applied: false, state: "pending" };
    }
    async submitDeletion(args) {
        const grant = this.options.autoApply?.(args.botId, args.threadId) ?? null;
        if (grant)
            return { ...await this.applyImmediately(this.prepareDeletion(args), args.from, args.canCommit), appliedBy: grant };
        return { ...this.proposeDeletion(args), applied: false, state: "pending" };
    }
    cardData(request, immediate = false) {
        const permission = this.options.canPersist(request.botId, request.threadId);
        if (!permission.ok)
            throw new TeamSetupError(permission.error, permission.status);
        const chief = this.chief(request.botId);
        const lines = [`Why: ${request.reason}`];
        if (request.deletion)
            lines.push(`Delete @${request.deletion.name} (${request.deletion.botId}).`, "Permanently removes this bot, all its conversations, memory, instructions, skills, and any computer owned only by it. Generated project files and shared department computers remain. Active work or an unavailable provider can block deletion safely.");
        if (request.newTeams.length) {
            lines.push(`Create departments: ${request.newTeams.map((name) => JSON.stringify(name)).join(", ")}.`);
            if (!request.operations.some(op => op.botId === chief.id && op.fields.chiefOfStaff === false)) {
                lines.push(`Authorize @${chief.name} to coordinate and propose setup changes in these new departments.`);
            }
        }
        for (const operation of request.operations) {
            const current = this.options.store.bot(operation.botId);
            lines.push(`\n${operation.action === "create" ? "Create" : "Update"} @${operation.fields.name ?? current?.name} (${operation.action === "create" ? "new bot" : operation.botId})`);
            for (const [key, value] of Object.entries(operation.fields)) {
                if (key === "chiefOfStaff") {
                    lines.push(`Chief of Staff: ${current?.chiefOfStaff ? "Yes" : "No"} → ${value ? "Yes" : "No"}.${value ? " May coordinate and configure bots in this department." : " Access to additional departments is removed."}`);
                    continue;
                }
                if (key === "soul") {
                    lines.push(...soulDiffLines(current?.soul ?? "", value));
                }
                else if (key === "modelSelection") {
                    lines.push(`Default AI and model: ${current ? `${modelSelectionText(current.modelSelection)} → ` : ""}${modelSelectionText(value)}`);
                    if (current && typeof value === "object" && value !== null &&
                        value.instanceId !== current.modelSelection.instanceId && this.options.driverCapabilities) {
                        lines.push(...harnessCapabilityLines(this.options.driverCapabilities(current.modelSelection.instanceId), this.options.driverCapabilities(value.instanceId)));
                    }
                }
                else {
                    const before = current ? (key === "section" ? current.section || "General" : String(current[key] ?? "")) : undefined;
                    const after = key === "section" ? value || "General" : String(value);
                    lines.push(`${FIELD_LABELS[key] ?? key}: ${current ? `"${before}" → ` : ""}"${after}"`);
                }
            }
        }
        if (!request.deletion) {
            lines.push("\nDefault models apply to groups and new threads. Every existing thread keeps its current model and permissions.");
            if (request.operations.some((operation) => operation.action === "create")) {
                lines.push(`New bots stay owner-owned after creation: the same connected apps as @${chief.name}, the workspace's default access level, a private workspace by default, avatar untouched.`);
            }
            lines.push("Existing execution permissions are unchanged.");
        }
        if (!immediate)
            lines.push("After this decision the Chief continues once with the result.");
        const title = request.deletion ? `Delete @${request.deletion.name}?`
            : `Apply setup for ${request.operations.length} ${request.operations.length === 1 ? "bot" : "bots"}?`;
        const detail = lines.join("\n");
        return {
            title, subtitle: detail, options: request.deletion ? ["Delete bot", "Cancel"] : ["Apply setup", "Cancel"], requestId: request.requestId,
            tool: request.deletion ? "delete_bot" : "set_up_team", teamSetupRequest: request,
        };
    }
    card(request, from) {
        const card = this.cardData(request);
        const message = this.options.store.appendMessage(request.threadId, { role: "bot", kind: "options", ...(from ? { from } : {}), card });
        const { title, subtitle: detail } = card;
        return { requestId: request.requestId, messageId: message.id, title, summary: title, detail };
    }
    applySetup(request, actor, via) {
        const before = request.operations.flatMap((operation) => {
            const bot = operation.action === "update" ? this.options.store.bot(operation.botId) : undefined;
            return bot ? [{ id: bot.id, profile: profileSnapshot(bot) }] : [];
        });
        const result = this.options.store.applyTeamSetup(request);
        for (const { id, profile } of before) {
            const bot = this.options.store.bot(id);
            if (bot)
                recordProfileChange(id, actor, via, profile, profileSnapshot(bot));
        }
        return result;
    }
    async apply(request, immediate = false, canCommit) {
        const receipt = this.options.store.bot(request.botId)?.lastTeamSetupReceipt;
        if (receipt?.requestId === request.requestId)
            return receipt.result;
        try {
            const revalidate = () => {
                // A still-Full conversation is not authority for an invocation that Stop or replacement revoked.
                if (immediate && canCommit && !canCommit())
                    throw new TeamSetupError("The requesting turn has expired; this setup was cancelled", 409);
                this.validate(request, true, immediate);
            };
            revalidate();
            if (!request.deletion)
                return this.applySetup(request, "bot", "team-setup");
            await this.options.deleteBot(request.deletion.botId, revalidate, request);
            return { state: "applied", bots: [{ id: request.deletion.botId, name: request.deletion.name, action: "deleted" }], newTeams: [] };
        }
        catch (error) {
            const saved = this.options.store.bot(request.botId)?.lastTeamSetupReceipt;
            const detail = redactSecretsInText(error instanceof Error ? error.message : String(error));
            return saved?.requestId === request.requestId
                ? { ...saved.result, error: `The changes were saved, but cleanup needs attention: ${detail}` }
                : { state: error instanceof TeamSetupError ? "cancelled" : "failed", bots: [], newTeams: [], error: detail };
        }
    }
    async applyImmediately(request, from, canCommit) {
        const card = this.cardData(request, true);
        const before = request.deletion ? undefined : this.undoBefore(request);
        let result = await this.apply(request, true, canCommit);
        const undo = before && result.state === "applied" && !result.error ? this.undoRecord(result, before) : undefined;
        const title = result.state === "applied" ? (request.deletion ? `Deleted @${request.deletion.name}` : "Team setup applied") : "Team setup not applied";
        let messageId;
        try {
            messageId = this.options.store.appendMessage(request.threadId, { role: "bot", kind: "options", ...(from ? { from } : {}), card: {
                    ...card, title, options: [], ...(result.state === "applied" ? { answered: "allow", autoApplied: true } : { expired: true }), held: result.error,
                    teamSetupRequest: { ...request, result, resumed: true, ...(undo ? { undo } : {}) },
                } }).id;
        }
        catch (error) {
            const detail = redactSecretsInText(error instanceof Error ? error.message : String(error));
            result = { ...result, error: [result.error, `The result could not be added to the conversation: ${detail}`].filter(Boolean).join(" ") };
        }
        return { requestId: request.requestId, messageId, title, summary: title, detail: card.subtitle, applied: result.state === "applied", state: result.state, result };
    }
    undoBefore(request) {
        const before = [];
        for (const operation of request.operations) {
            const bot = operation.action === "update" ? this.options.store.bot(operation.botId) : undefined;
            if (!bot)
                continue;
            const fields = {};
            for (const key of Object.keys(operation.fields)) {
                if (key !== "cwd")
                    fields[key] = key === "section" ? section(bot.section) : key === "chiefOfStaff" ? Boolean(bot.chiefOfStaff) : structuredClone(bot[key]) ?? "";
            }
            const teams = operation.fields.chiefOfStaff !== undefined || (bot.id === request.botId && request.newTeams.length > 0);
            before.push({ botId: bot.id, fields, ...(teams ? { managedSections: bot.managedSections ? [...bot.managedSections] : null } : {}) });
        }
        const chief = this.options.store.bot(request.botId);
        if (request.newTeams.length && chief && !before.some((entry) => entry.botId === chief.id)) {
            before.push({ botId: chief.id, fields: {}, managedSections: chief.managedSections ? [...chief.managedSections] : null });
        }
        return before;
    }
    undoRecord(result, before) {
        const created = result.bots.filter((bot) => bot.action === "created").map((bot) => bot.id);
        const revisions = {};
        for (const id of new Set([...created, ...before.map((entry) => entry.botId)])) {
            const bot = this.options.store.bot(id);
            if (bot)
                revisions[id] = teamSetupRevision(bot);
        }
        return { created, before, revisions };
    }
    /** Reverses a setup that applied on its own; changes nothing once a bot it touched changed since or a new bot was used. */
    async undo(args) {
        const message = this.options.store.messagesFor(args.threadId).find((item) => item.card?.requestId === args.requestId && item.card.teamSetupRequest);
        const card = message?.card, request = card?.teamSetupRequest;
        if (!message || !card || !request)
            return { claimed: false };
        if (card.undone)
            return { claimed: true, state: "already_undone" };
        const cannot = (error, status = 409) => ({ claimed: true, state: "invalid", error, status });
        if (!card.autoApplied || card.answered !== "allow" || !request.undo)
            return cannot("This change can't be undone here.");
        if (request.botId !== args.botId || request.threadId !== args.threadId)
            return cannot("This setup belongs to another conversation", 403);
        const { created, before, revisions } = request.undo;
        const changed = (ids) => ids.some((id) => {
            const bot = this.options.store.bot(id);
            return !bot || teamSetupRevision(bot) !== revisions[id] || (created.includes(id) &&
                ((bot.tasks?.length ?? 1) > 1 || this.options.store.messagesFor(bot.threadId).some((line) => line.role === "user")));
        });
        const ids = Object.keys(revisions);
        if (changed(ids))
            return { ...cannot(UNDO_STALE), stale: true };
        if (ids.some((id) => this.options.targetBusy(id)))
            return cannot("Wait for the bots this setup changed to finish their work, then undo.");
        const refusal = created.map((id) => this.options.deletionRefusal(id)).find((reason) => reason !== null);
        if (refusal)
            return cannot(refusal);
        try {
            for (const id of created)
                await this.options.deleteBot(id, () => { if (changed([id]))
                    throw new TeamSetupError(UNDO_STALE, 409); });
            const restore = before.filter((entry) => Object.keys(entry.fields).length);
            if (restore.length) {
                this.applySetup({ version: 1, requestId: newId(), botId: request.botId, threadId: request.threadId, reason: request.reason,
                    createdAt: Date.now(), requesterRevision: request.requesterRevision, newTeams: [],
                    operations: restore.map((entry) => ({ action: "update", botId: entry.botId, fields: entry.fields })) }, "user", "revert");
            }
            for (const entry of before)
                if (entry.managedSections !== undefined)
                    this.options.store.patchBot(entry.botId, { managedSections: entry.managedSections ?? undefined });
        }
        catch (error) {
            return cannot(redactSecretsInText(error instanceof Error ? error.message : String(error)).slice(0, 500));
        }
        this.options.store.patchMessage(args.threadId, message.id, { card: { ...card, undone: true } });
        return { claimed: true, state: "undone" };
    }
    async resolve(args) {
        const message = this.options.store.messagesFor(args.threadId).find((item) => item.card?.requestId === args.requestId && item.card.teamSetupRequest);
        const card = message?.card, request = card?.teamSetupRequest;
        if (!message || !card || !request)
            return null;
        if (request.botId !== args.botId || request.threadId !== args.threadId || request.requestId !== args.requestId)
            throw new TeamSetupError("This setup belongs to another conversation", 403);
        if (args.behavior !== "allow" && args.behavior !== "deny")
            throw new TeamSetupError("Confirm or cancel this setup", 400);
        // A card closed by Stop/dismiss must never resurrect its review or wake the stopped conversation.
        if (card.answered || card.dismissed || card.expired) {
            const result = request.result ?? { state: "cancelled", bots: [], newTeams: [], error: "This setup card was closed" };
            return { result, request: { ...request, result }, messageId: message.id, duplicate: true };
        }
        if (this.resolving.has(request.requestId))
            throw new TeamSetupError("This setup is already being applied", 409);
        this.resolving.add(request.requestId);
        try {
            const receipt = this.options.store.bot(request.botId)?.lastTeamSetupReceipt;
            let result;
            if (receipt?.requestId === request.requestId)
                result = receipt.result;
            else if (args.behavior === "deny")
                result = { state: "denied", bots: [], newTeams: [] };
            else
                result = await this.apply(request);
            const dead = result.state !== "applied" && result.state !== "denied";
            this.options.store.patchMessage(args.threadId, message.id, { card: { ...card, ...(dead ? { expired: true, options: [] } : { answered: result.state === "applied" ? "allow" : "deny" }), held: result.error, teamSetupRequest: { ...request, result } } });
            return { result, request: { ...request, result }, messageId: message.id, duplicate: false };
        }
        finally {
            this.resolving.delete(request.requestId);
        }
    }
}
