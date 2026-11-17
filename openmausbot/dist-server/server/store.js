import { chmodSync, existsSync, readFileSync, mkdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { OwnedFile, writeFileAtomic } from "./atomic.js";
import { saveLater, saveSoon, supersedeLaterSave } from "./save-batch.js";
import { discardNativeLog } from "./drivers/native.js";
import { commitRegistryChange, deferrablePatch, keptRevocation, saveRegistryFor, touchesPermissions } from "./registry-save.js";
import { parseToolScope, toolScopeWidens } from "../shared/tool-scope.js";
import { grantScopedApps } from "../shared/connector-scopes.js";
import { dropRetiredApps } from "./retired-apps.js";
import { reorderInPlace } from "../shared/bot-order.js";
import { trimOutboundPolicy } from "../shared/outbound.js";
import { botOwner, chiefConflict, chiefScope, ownerEmail } from "../shared/bot-owner.js";
import { reshowWhenMoved } from "../shared/default-bot.js";
import { ensureSections, readSections, changeEmptySection } from "./section-context.js";
import { grantNewDepartments } from "./department-grants.js";
import { removeBotFolder, soulFile, soulHash, writeSoulMirror } from "./bot-folder.js";
import { DATA_DIR, EVENTS_DIR, NATIVE_DIR, loadBrowserProfileIdAliases } from "./config.js";
import * as mdb from "./message-db.js";
import { forgetBotMemoryJournal, journalFile } from "./memory-journal.js";
import { runCommand } from "./commands.js";
import { workspaceDir } from "./workspace.js";
import { newId } from "./contracts.js";
import { pickBotName } from "./names.js";
import { rotationColor } from "./bot-look.js";
import { redactBotAuthored } from "./message-redaction.js";
import { AVATAR_FOCUS_CENTER, AVATAR_ZOOM_MIN, botAvatarProfile, clampAvatarFocus, clampAvatarZoom } from "../shared/bot-avatar.js";
import { approvalModeFor, isApprovalMode, modelSwitchNeedsAsk, threadApproval } from "../shared/approval-mode.js";
import { lastChangeRequestUrl } from "../shared/thread-link.js";
import { REMOVED_COMPUTER_DRIVER } from "./computer-engine-removal.js";
import { isMentionBoundary, isMentionNameContinuation } from "../shared/mention-boundary.js";
import { resolveMentions } from "../shared/room-mentions.js";
import { movesThreadToTop, nextOpenThread } from "../shared/wire.js";
import { parseConnectorTools } from "./connector-tools.js";
import { recoverThreadGrantsOnce, rewriteGrantLists } from "./always-allow.js";
import { sameModelSelection } from "../shared/thread-model.js";
import { initialGreetingMessage } from "./initial-greeting.js";
import { createDefaultBot, defaultBotRefusal } from "./default-bot.js";
import { appsFromCreator } from "./inherited-apps.js";
import { newBotOwner, sharedAsMaker, sharedUnlessRestricted } from "./new-bot-sharing.js";
import { ThreadCache } from "./thread-cache.js";
import { titleFromMessage, UNTITLED_TASK } from "./thread-title.js";
import { buildTask, threadTitleFrom, UNTITLED_THREAD } from "./task-record.js";
import { createBotFork, createGroupFork } from "./store-forks.js";
import { activeGroupTask, groupTaskByThread, groupTasks, migrateGroupTaskRead, mirrorActiveGroupTask, refreshGroupUnread, setGroupTaskRead, syncGroupReadPatch } from "./group-task-state.js";
export { titleFromMessage, UNTITLED_TASK } from "./thread-title.js";
export { threadTitleFrom, UNTITLED_THREAD } from "./task-record.js";
export const groupWireProjectionIsExact = true;
// Unicode counts a lone digit, skin tone or regional indicator as an emoji component, not an emoji.
const projectEmojiPattern = new RegExp("^(?!\\p{Emoji_Component}$)(?:\\p{RGI_Emoji}|[\\p{Emoji}--\\p{Emoji_Component}])$", "v");
export function isProjectEmoji(value) {
    return typeof value === "string" && value.length <= 64 && projectEmojiPattern.exec(value)?.[0] === value;
}
export const taskWireProjectionIsExact = true;
export function toWireTask(task, botModel) {
    const { resumeCursors: _resumeCursors, lastInstanceId: _lastInstanceId, handedMessages: _handedMessages, appliedCompactionId: _appliedCompactionId, contextFloor: _contextFloor, lastContextModel: _lastContextModel, surfaceSource, askedAt: _askedAt, ...stored } = task;
    const wire = { ...stored, modelSelection: structuredClone(task.modelSelection ?? botModel), followsBotModel: task.modelSelection === undefined };
    return surfaceSource === "auto" && wire.surface !== undefined ? { ...wire, surfaceAuto: true } : wire;
}
const ASK_NOW = { approvalMode: "ask", autoApprove: false, alwaysAllow: [] };
const TASK_PATCH_FIELDS = [
    "title", "projectId", "modelSelection", "approvalMode", "autoApprove", "alwaysAllow",
    "unread", "lastReadMessageId", "rewound", "archivedAt", "pinned", "pinnedMessageId", "resumeCursors", "lastInstanceId", "cwd",
    "routineRunId", "surface", "surfaceSource", "snoozedUntil", "link", "linkAuto", "appliedCompactionId", "contextFloor", "lastContextModel", "usage", "setupRequest", "botApi", "botApiAsOwner", "outside",
];
function persistedPin(task) {
    if (task.pinned === true)
        return task;
    if (!("pinned" in task))
        return task;
    const { pinned: _pinned, ...rest } = task;
    return rest;
}
export const ACTIVITY_BUSY = new Set(["working", "waiting-on-you", "no-signal"]);
export function titleFromLlm(raw) {
    const line = raw
        .trim()
        .split("\n")[0]
        .replace(/^[#*\-\u2022]+/, "")
        .replace(/^["'\u201C\u201D\u2018\u2019\u0060]+/, "")
        .replace(/["'\u201C\u201D\u2018\u2019\u0060]+$/, "")
        .replace(/^[#*\-\u2022]+/, "")
        .replace(/[#*]+$/, "")
        .replace(/[.\u3002]+$/, "")
        .replace(/\s+/g, " ")
        .trim();
    return line.length >= 1 && line.length <= 48 ? line : null;
}
export const botWireProjectionIsExact = true;
const BOTS_FILE = join(DATA_DIR, "bots.json");
const GROUPS_FILE = join(DATA_DIR, "groups.json");
const THREAD_MODEL_COPIES_CLEARED = join(DATA_DIR, "thread-model-copies-cleared");
const ASKED_AT_FILLED = join(DATA_DIR, "asked-at-filled");
/** Owner-only (0600): the registries hold souls, project paths and per-bot settings. Best effort; Windows has no POSIX mode bits. */
function tightenRegistryFile(file) {
    if (process.platform === "win32")
        return;
    try {
        if ((statSync(file).mode & 0o077) !== 0)
            chmodSync(file, 0o600);
    }
    catch {
    }
}
const messagesFile = (threadId) => join(DATA_DIR, `messages-${threadId}.json`);
export const sectionKey = (section) => section?.trim() || "";
export function mentionedBots(text, peers, picked = []) {
    return resolveMentions(text, peers, picked).bots;
}
export function normalizeGroupDefaultResponder(value, memberIds, dm = false) {
    if (dm)
        return { kind: "mentions" };
    if (value && typeof value === "object") {
        const candidate = value;
        if (candidate.kind === "everyone")
            return { kind: "everyone" };
        if (candidate.kind === "mentions")
            return { kind: "mentions" };
        if (candidate.kind === "auto") {
            return typeof candidate.fallbackBotId === "string" && memberIds.includes(candidate.fallbackBotId)
                ? { kind: "auto", fallbackBotId: candidate.fallbackBotId }
                : { kind: "auto" };
        }
        if (candidate.kind === "member" &&
            typeof candidate.botId === "string" &&
            memberIds.includes(candidate.botId)) {
            return { kind: "member", botId: candidate.botId };
        }
    }
    if (memberIds.length === 0)
        return { kind: "mentions" };
    return { kind: "member", botId: memberIds[0] };
}
export function roomResponders(text, members, defaultResponder, picked = []) {
    const available = members.filter((member) => !member.hidden);
    const everyone = "everyone";
    for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
        const candidate = text.slice(at + 1, at + 1 + everyone.length);
        if (isMentionBoundary(text, at) &&
            candidate.toLocaleLowerCase() === everyone &&
            !isMentionNameContinuation(text.slice(at + 1 + everyone.length))) {
            return available;
        }
    }
    const { bots, ambiguous } = resolveMentions(text, available, picked);
    const mentioned = bots.filter((bot) => !ambiguous.some((sharing) => sharing.includes(bot)));
    if (mentioned.length)
        return mentioned;
    if (defaultResponder.kind === "everyone")
        return available;
    if (defaultResponder.kind === "member") {
        const lead = available.find((member) => member.id === defaultResponder.botId);
        return lead ? [lead] : [];
    }
    if (defaultResponder.kind === "auto") {
        const fallback = available.find((member) => member.id === defaultResponder.fallbackBotId) ?? available[0];
        return fallback ? [fallback] : [];
    }
    return [];
}
export function pruneRoomHolds(group) {
    for (const key of ["holds", "heldMessages"]) {
        const map = group[key];
        if (!map)
            continue;
        const kept = Object.fromEntries(Object.entries(map).filter(([botId]) => group.memberIds.includes(botId)));
        if (Object.keys(kept).length !== Object.keys(map).length)
            group[key] = kept;
    }
}
function taskCountsAsBotUnread(task) {
    return Boolean(task.unread) && !task.routineRunId;
}
export class Store {
    bots = []; /** Bots that live in another of the person's places (server/bot-link/), by their address here: found by id, never listed, counted, saved, moved or backed up. */
    standIns = new Map();
    groups = []; /** Told before a delete of these conversations is tried; "thread.deleted" follows only for those that went. Must not throw. */
    threadsGoing = () => { };
    threads = new ThreadCache(() => this.busyThreadIds());
    defaultSelection;
    completeNewBotSelection;
    driverKindOf;
    initialLanguage;
    personName;
    /** How a new bot is shared; a Team Cloud sets its own rule. */
    newBotSharing = sharedUnlessRestricted;
    listeners = new Set();
    registeringInitialSections = true;
    botsFile = new OwnedFile(BOTS_FILE, { mode: 0o600 });
    groupsFile = new OwnedFile(GROUPS_FILE, { mode: 0o600 });
    /** Clearing this slot must not clear a concurrently running task's activity. */
    legacyActivities = new Map();
    constructor(defaultSelection, completeNewBotSelection = (selection) => selection, 
    /** Unknown counts as another driver, so Full and Custom fall back to Ask. */
    driverKindOf = () => undefined, initialLanguage = Intl.DateTimeFormat().resolvedOptions().locale, 
    /** The person a new bot's greeting names, read as each bot is created; undefined where no one person owns the
     * server. */
    personName = () => undefined) {
        this.defaultSelection = defaultSelection;
        this.completeNewBotSelection = completeNewBotSelection;
        this.driverKindOf = driverKindOf;
        this.initialLanguage = initialLanguage;
        this.personName = personName;
        mkdirSync(DATA_DIR, { recursive: true });
        for (const file of [BOTS_FILE, GROUPS_FILE])
            tightenRegistryFile(file);
        // An unreadable bots.json must never read as "every member was deleted".
        let botsLoaded = false;
        try {
            supersedeLaterSave(BOTS_FILE);
            const text = readFileSync(BOTS_FILE, "utf8");
            this.bots = JSON.parse(text);
            this.botsFile.loaded(text);
            botsLoaded = Array.isArray(this.bots);
        }
        catch {
            this.bots = [];
        }
        try {
            const text = readFileSync(GROUPS_FILE, "utf8");
            this.groups = JSON.parse(text);
            this.groupsFile.loaded(text);
        }
        catch {
            this.groups = [];
        }
        this.rememberSections([...this.bots, ...this.groups].map((record) => record.section));
        let botsMigrated = false;
        const browserProfileAliases = loadBrowserProfileIdAliases();
        const chiefSectionsSeen = new Set();
        let groupsMigrated = false;
        for (const b of this.bots) {
            if (b.busy || (b.activity !== undefined && b.activity !== "idle"))
                botsMigrated = true;
            b.busy = false;
            b.activity = "idle";
            if (dropRetiredApps(b))
                botsMigrated = true;
            if (grantScopedApps(b))
                botsMigrated = true;
            if (trimOutboundPolicy(b))
                botsMigrated = true;
            if (typeof b.soul !== "string") {
                b.soul = "";
                botsMigrated = true;
            }
            if (b.soulHash !== soulHash(b.soul)) {
                b.soulHash = soulHash(b.soul);
                botsMigrated = true;
            }
            if (!existsSync(soulFile(b.id))) {
                try {
                    writeSoulMirror(b.id, b.soul);
                }
                catch (e) {
                    console.warn(`[bot-folder] could not create SOUL.md for ${b.id}: ${e.message}`);
                }
            }
            if (b.browserProfile) {
                const browserProfile = browserProfileAliases.get(b.browserProfile);
                if (browserProfile && browserProfile !== b.browserProfile) {
                    b.browserProfile = browserProfile;
                    botsMigrated = true;
                }
            }
            if (b.cloudBackend !== undefined && b.cloudBackend !== "box" && b.cloudBackend !== "vps") {
                delete b.cloudBackend;
                botsMigrated = true;
            }
            if (b.autoStartVps !== undefined && b.autoStartVps !== true && b.autoStartVps !== false) {
                delete b.autoStartVps;
                botsMigrated = true;
            }
            if (b.managedSections !== undefined && (!b.chiefOfStaff || !Array.isArray(b.managedSections) ||
                b.managedSections.length > 100 || b.managedSections.some(section => typeof section !== "string" || section.length > 60))) {
                delete b.managedSections;
                botsMigrated = true;
            }
            if (b.approvalMode !== undefined && !isApprovalMode(b.approvalMode)) {
                delete b.approvalMode;
                botsMigrated = true;
            }
            // Revoke an unactivated elevation before schedulers, listeners or HTTP can start any new work.
            if (b.approvalGrant !== undefined) {
                const threadOnly = b.approvalGrant.threadOnly === true;
                if (threadOnly) {
                    const target = b.tasks?.find(task => task.threadId === b.approvalGrant?.threadId);
                    if (target) {
                        target.approvalMode = "ask";
                        target.autoApprove = false;
                    }
                }
                if (!threadOnly) {
                    b.approvalMode = "ask";
                    b.autoApprove = false;
                    for (const task of b.tasks ?? []) {
                        if (task.approvalMode === "full" || task.approvalMode === "custom") {
                            task.approvalMode = "ask";
                            task.autoApprove = false;
                        }
                    }
                }
                delete b.approvalGrant;
                botsMigrated = true;
            }
            const avatar = botAvatarProfile(b);
            if (b.avatarUrl !== undefined && avatar.avatarUrl !== b.avatarUrl) {
                delete b.avatarUrl;
                botsMigrated = true;
            }
            if (b.avatarCrop !== undefined && avatar.avatarCrop !== b.avatarCrop) {
                delete b.avatarCrop;
                botsMigrated = true;
            }
            if (b.avatarZoom !== undefined) {
                const zoom = clampAvatarZoom(b.avatarZoom);
                if (zoom === AVATAR_ZOOM_MIN) {
                    delete b.avatarZoom;
                    botsMigrated = true;
                }
                else if (b.avatarZoom !== zoom) {
                    b.avatarZoom = zoom;
                    botsMigrated = true;
                }
            }
            for (const key of ["avatarFocusX", "avatarFocusY"]) {
                if (b[key] === undefined)
                    continue;
                const focus = clampAvatarFocus(b[key]);
                if (focus === AVATAR_FOCUS_CENTER) {
                    delete b[key];
                    botsMigrated = true;
                }
                else if (b[key] !== focus) {
                    b[key] = focus;
                    botsMigrated = true;
                }
            }
        }
        for (const b of this.bots) {
            if (!b.chiefOfStaff)
                continue;
            const key = chiefScope(b);
            if (!chiefSectionsSeen.has(key)) {
                chiefSectionsSeen.add(key);
                if (b.hidden) {
                    b.hidden = false;
                    botsMigrated = true;
                }
                continue;
            }
            b.chiefOfStaff = false;
            delete b.managedSections;
            botsMigrated = true;
        }
        for (const b of this.bots) {
            if (!("peers" in b) && !("approvePeerComms" in b))
                continue;
            delete b.peers;
            delete b.approvePeerComms;
            botsMigrated = true;
        }
        if (recoverThreadGrantsOnce(DATA_DIR, this.bots))
            botsMigrated = true;
        const botIds = new Set(this.bots.map((b) => b.id));
        for (const g of this.groups) {
            g.busyBotId = null;
            delete g.turnStartedAt;
            if (botsLoaded && !g.dm && g.memberIds.some((id) => !botIds.has(id) && !id.startsWith("link-"))) {
                g.memberIds = g.memberIds.filter((id) => botIds.has(id) || id.startsWith("link-")); // A member that lives in another of the person's places (server/bot-link/) is no bot of bots.json: the link, which starts later, says whether it is still there.
                groupsMigrated = true;
            }
            const normalized = normalizeGroupDefaultResponder(g.defaultResponder, g.memberIds, Boolean(g.dm));
            if (JSON.stringify(normalized) !== JSON.stringify(g.defaultResponder))
                groupsMigrated = true;
            g.defaultResponder = normalized;
            if (g.holds !== undefined || g.heldMessages !== undefined) {
                const before = JSON.stringify([g.holds, g.heldMessages]);
                pruneRoomHolds(g);
                if (JSON.stringify([g.holds, g.heldMessages]) !== before)
                    groupsMigrated = true;
            }
            if (g.dm) {
                if (g.tasks !== undefined) {
                    delete g.tasks;
                    groupsMigrated = true;
                }
                continue;
            }
            if (!g.tasks?.length) {
                const initialTask = {
                    threadId: g.threadId,
                    title: this.firstUserLine(g.threadId) ?? UNTITLED_TASK,
                    createdAt: g.createdAt,
                    updatedAt: g.createdAt,
                };
                if (g.pinnedCwd !== undefined)
                    initialTask.pinnedCwd = g.pinnedCwd;
                if (g.pinnedMessageId)
                    initialTask.pinnedMessageId = g.pinnedMessageId;
                g.tasks = [initialTask];
                groupsMigrated = true;
            }
            let active = g.tasks.find((task) => task.threadId === g.threadId);
            if (!active) {
                active = g.tasks[0];
                g.threadId = active.threadId;
                groupsMigrated = true;
            }
            g.pinnedCwd = active.pinnedCwd;
            g.pinnedMessageId = active.pinnedMessageId;
            if (migrateGroupTaskRead(g, active))
                groupsMigrated = true;
        }
        if (groupsMigrated)
            this.saveGroups();
        const clearModelCopies = !existsSync(THREAD_MODEL_COPIES_CLEARED) && (botsLoaded || !existsSync(BOTS_FILE));
        const fillAskedAts = !existsSync(ASKED_AT_FILLED) && (botsLoaded || !existsSync(BOTS_FILE));
        for (const b of this.bots) {
            if (b.projects?.some((project) => "modelSelection" in project)) {
                b.projects = b.projects.map(({ id, name, emoji }) => ({ id, name, ...(isProjectEmoji(emoji) ? { emoji } : {}) }));
                botsMigrated = true;
            }
            if (!b.tasks?.length) {
                b.tasks = [{
                        threadId: b.threadId,
                        title: this.firstUserLine(b.threadId) ?? UNTITLED_TASK,
                        createdAt: b.createdAt,
                        updatedAt: b.createdAt,
                        resumeCursors: b.resumeCursors ?? {},
                    }];
                botsMigrated = true;
            }
            let active = b.tasks.find((task) => task.threadId === b.threadId);
            if (!active) {
                active = {
                    threadId: b.threadId,
                    title: this.firstUserLine(b.threadId) ?? UNTITLED_TASK,
                    createdAt: b.createdAt,
                    updatedAt: b.createdAt,
                    resumeCursors: b.resumeCursors ?? {},
                };
                b.tasks.unshift(active);
                botsMigrated = true;
            }
            for (const task of b.tasks) {
                if (clearModelCopies && task.modelSelection !== undefined && sameModelSelection(task.modelSelection, b.modelSelection)) {
                    delete task.modelSelection;
                    botsMigrated = true;
                }
                if (!task.resumeCursors) {
                    task.resumeCursors = task === active ? (b.resumeCursors ?? {}) : {};
                    botsMigrated = true;
                }
                if (task.unread === undefined) {
                    task.unread = task === active && b.unread;
                    botsMigrated = true;
                }
                if (task.routineRunId && task.unread) {
                    task.unread = false;
                    botsMigrated = true;
                }
                if (task === active) {
                    if (task.rewound === undefined && b.rewound !== undefined) {
                        task.rewound = b.rewound;
                        botsMigrated = true;
                    }
                    if (task.pinnedMessageId === undefined && b.pinnedMessageId !== undefined) {
                        task.pinnedMessageId = b.pinnedMessageId;
                        botsMigrated = true;
                    }
                }
                if (task.approvalMode !== undefined && !isApprovalMode(task.approvalMode)) {
                    delete task.approvalMode;
                    botsMigrated = true;
                }
                if (task.busy !== undefined || task.activity !== undefined || task.turnStartedAt !== undefined)
                    botsMigrated = true;
                task.busy = false;
                task.activity = "idle";
                task.turnStartedAt = undefined;
            }
            this.mirrorActiveTask(b, active);
            b.unread = b.tasks.some(taskCountsAsBotUnread);
        }
        if (botsMigrated)
            this.saveBots();
        if (clearModelCopies)
            writeFileAtomic(THREAD_MODEL_COPIES_CLEARED, "Threads follow their bot's model; the copies older builds made are cleared.\n", { mode: 0o600 });
        const knownThreads = new Set([
            ...this.bots.flatMap((b) => [b.threadId, ...(b.tasks ?? []).map((task) => task.threadId)]),
            ...this.groups.flatMap((group) => [group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)]),
        ]);
        for (const threadId of knownThreads) {
            const legacyFile = messagesFile(threadId);
            if (existsSync(legacyFile))
                mdb.readThread(threadId, legacyFile);
        }
        // After the transcript migration, so each stamp sees its thread's newest message.
        this.repairThreadUpdatedAts();
        if (fillAskedAts)
            this.fillTaskAskedAts();
        // After the roster loads, so identity resolution sees which opener ids are live.
        this.repairDuplicatePairConversations();
        this.registeringInitialSections = false;
    }
    /** In memory only: message writes must not rewrite bots.json. */
    noteThreadActivity(threadId, at, forOrder = false, orderAt = at) {
        if (!Number.isFinite(at))
            return;
        for (const task of [...this.bots, ...this.groups].map((owner) => owner.tasks?.find((candidate) => candidate.threadId === threadId))) {
            if (!task)
                continue;
            task.updatedAt = Math.max(task.updatedAt ?? 0, at);
            if (forOrder)
                task.lastThreadOrderAt = Math.max(task.lastThreadOrderAt ?? 0, orderAt);
        }
    }
    /** Never moves a stamp backwards: a clock skew must not reshuffle the list on every boot. */
    repairThreadUpdatedAts() {
        const botTasks = this.bots.flatMap((bot) => bot.tasks ?? []);
        const groupTasks = this.groups.flatMap((group) => group.tasks ?? []);
        const latest = mdb.latestMessageAts([...botTasks, ...groupTasks].map((task) => task.threadId));
        const latestOrder = mdb.latestMessageAts([...botTasks, ...groupTasks].map((task) => task.threadId), true);
        let botsDirty = false;
        let groupsDirty = false;
        const repair = (task) => {
            const fromMessages = latest.get(task.threadId);
            const next = fromMessages !== undefined && (task.updatedAt === undefined || fromMessages > task.updatedAt)
                ? fromMessages
                : task.updatedAt ?? task.createdAt;
            const fromOrder = latestOrder.get(task.threadId);
            const orderAt = fromOrder === undefined ? task.lastThreadOrderAt : Math.max(task.lastThreadOrderAt ?? task.createdAt, fromOrder);
            const changed = task.updatedAt !== next || task.lastThreadOrderAt !== orderAt;
            task.updatedAt = next;
            task.lastThreadOrderAt = orderAt;
            return changed;
        };
        for (const task of botTasks)
            if (repair(task))
                botsDirty = true;
        for (const task of groupTasks)
            if (repair(task))
                groupsDirty = true;
        if (botsDirty)
            this.saveBots();
        if (groupsDirty)
            this.saveGroups();
    }
    fillTaskAskedAts() {
        const tasks = this.bots.flatMap((bot) => bot.tasks ?? []).filter((task) => task.askedAt === undefined && !task.routineRunId);
        const asked = mdb.latestPersonLineAts(tasks.map((task) => task.threadId));
        for (const task of tasks) {
            const at = asked.get(task.threadId);
            if (at !== undefined)
                task.askedAt = at;
        }
        if (asked.size)
            this.saveBots();
        writeFileAtomic(ASKED_AT_FILLED, "Threads from before askedAt have it from the lines people wrote there.\n", { mode: 0o600 });
    }
    openerIdentity(openedBy) {
        if (this.bot(openedBy.botId))
            return openedBy.botId;
        const named = this.bots.filter((bot) => bot.name === openedBy.name);
        return named.length === 1 ? named[0].id : openedBy.botId;
    }
    /** At most one live pair row per (recipient, sender identity); extra rows become closed plain threads, never deleted. */
    repairDuplicatePairConversations() {
        let botsDirty = false;
        const sweep = (tasks, repaired) => {
            const pairs = new Map();
            for (const task of tasks ?? []) {
                const by = task.openedBy;
                if (by?.kind !== "pair" || task.closedBy)
                    continue;
                const identity = this.openerIdentity(by);
                pairs.set(identity, [...(pairs.get(identity) ?? []), task]);
            }
            for (const rows of pairs.values()) {
                for (const duplicate of rows.slice(1)) {
                    const by = duplicate.openedBy;
                    const identity = this.openerIdentity(by);
                    const { kind: _kind, ...opened } = by;
                    duplicate.openedBy = opened;
                    duplicate.closedBy = {
                        botId: identity,
                        name: this.bot(identity)?.name ?? by.name,
                        at: Date.now(),
                    };
                    repaired();
                }
            }
        };
        for (const bot of this.bots)
            sweep(bot.tasks, () => { botsDirty = true; });
        if (botsDirty)
            this.saveBots();
    }
    commitBotChange(bot, action, change, onRollback, bookkeeping = false) {
        commitRegistryChange(bot, "bots.json", action, bookkeeping === "later" ? () => this.saveBotsLater() : bookkeeping ? () => this.saveBotsSoon() : () => this.saveBots(), change, onRollback);
    }
    commitGroupChange(group, action, change) {
        commitRegistryChange(group, "groups.json", action, () => this.saveGroups(), change);
    }
    saveBotsSoon() { saveSoon(this.botsFile, () => this.saveBots()); }
    saveBotsLater() { saveLater(BOTS_FILE, () => this.saveBots()); }
    saveBots(bots = this.bots, registerSections = true) {
        if (registerSections)
            this.rememberSections([...this.bots, ...bots].map((bot) => bot.section));
        this.botsFile.write(JSON.stringify(bots.map(({ busy: _busy, activity: _activity, ...bot }) => ({ ...bot,
            tasks: bot.tasks?.map(({ busy: _taskBusy, activity: _taskActivity, turnStartedAt: _taskTurnStarted, ...task }) => persistedPin(task)),
        }))));
        if (bots === this.bots)
            supersedeLaterSave(BOTS_FILE);
    }
    saveGroups(groups = this.groups, registerSections = true) {
        if (registerSections)
            this.rememberSections(groups.map((group) => group.section));
        this.groupsFile.write(JSON.stringify(groups.map(({ busyBotId: _busyBotId, turnStartedAt: _turnStartedAt, ...g }) => ({
            ...g,
            ...(g.tasks ? { tasks: g.tasks.map((task) => persistedPin(task)) } : {}),
        }))));
    }
    get sections() { return readSections(); }
    rememberSections(names) {
        try {
            const added = ensureSections(names); // a name an older save left unregistered at startup is not a new department
            if (added.length) {
                this.emit({ type: "sections" });
                if (!this.registeringInitialSections)
                    grantNewDepartments(this, added);
            }
        }
        catch (error) {
            if (!this.registeringInitialSections)
                throw error;
            console.warn(`[teams] Startup could not register team names; saved teams and shared instructions were left unchanged: ${error.message}`);
        }
    }
    renameSection(name, nextName, computers) {
        if (!name || !this.sections.includes(name))
            return "No such department";
        nextName = nextName.trim();
        if (!nextName || nextName.length > 60 || [...nextName].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
            return "Department name must be 1 to 60 characters without control characters";
        if (name === nextName)
            return undefined;
        if (this.sections.includes(nextName) || computers?.forSection(nextName))
            return "A department with that name already exists";
        const members = this.bots.filter(bot => sectionKey(bot.section) === name);
        const rooms = this.groups.filter(group => sectionKey(group.section) === name);
        const affected = this.bots.filter(bot => members.includes(bot) || bot.managedSections?.some(section => sectionKey(section) === name));
        if (affected.some(bot => bot.busy || bot.tasks?.some(task => task.busy)) || rooms.some(group => group.busyBotId)) {
            return "Stop this department's active work before renaming it";
        }
        // Removing an empty identity revokes its old grants, so recreating it cannot restore access.
        if (!members.length && !rooms.length && !computers?.forSection(name))
            return this.changeEmptySection(name, nextName);
        const nextBots = this.bots.map(bot => ({ ...bot,
            ...(members.includes(bot) ? { section: nextName } : {}),
            ...(bot.managedSections ? { managedSections: [...new Set(bot.managedSections.map(section => sectionKey(section) === name ? nextName : section))] } : {}),
        }));
        const nextGroups = this.groups.map(group => rooms.includes(group) ? { ...group, section: nextName } : group);
        let computerChanged = false;
        try {
            // Register the new name only after saving, or the registry's duplicate-name check rejects this rename.
            this.saveBots(nextBots, false);
            this.saveGroups(nextGroups, false);
            computerChanged = computers?.renameSection(name, nextName) ?? false;
            changeEmptySection(name, nextName);
        }
        catch (error) {
            this.saveBots(this.bots, false);
            this.saveGroups(this.groups, false);
            if (computerChanged)
                computers.renameSection(nextName, name);
            throw error;
        }
        // Mutate in place: schedulers and other consumers hold these objects.
        for (let i = 0; i < nextBots.length; i++)
            Object.assign(this.bots[i], nextBots[i]);
        for (let i = 0; i < nextGroups.length; i++)
            Object.assign(this.groups[i], nextGroups[i]);
        for (const bot of affected)
            this.emit({ type: "bot", botId: bot.id });
        for (const room of rooms)
            this.emit({ type: "group", groupId: room.id });
        this.emit({ type: "sections" });
        return undefined;
    }
    changeEmptySection(name, nextName) {
        if (!this.sections.includes(name))
            return "No such department";
        if ([...this.bots, ...this.groups].some((record) => sectionKey(record.section) === name)) {
            return "Move all bots (including archived bots) and group chats out of this department first";
        }
        if (nextName !== null && nextName !== name && this.sections.includes(nextName)) {
            return "A department with that name already exists";
        }
        if (nextName === name)
            return undefined;
        const revoked = this.bots.filter((bot) => bot.managedSections?.some((section) => sectionKey(section) === name));
        if (revoked.length) {
            const grants = new Map(revoked.map((bot) => [bot.id, bot.managedSections.filter((section) => sectionKey(section) !== name)]));
            // Revoke durably before freeing the name, so recreating it can never revive its old grants.
            this.saveBots(this.bots.map((bot) => grants.has(bot.id) ? { ...bot, managedSections: grants.get(bot.id) } : bot));
            for (const bot of revoked)
                bot.managedSections = grants.get(bot.id);
            for (const bot of revoked)
                this.emit({ type: "bot", botId: bot.id });
        }
        changeEmptySection(name, nextName);
        this.emit({ type: "sections" });
        return undefined;
    }
    deleteSection(name) {
        if (!name || !this.sections.includes(name))
            return "No such department";
        const members = this.bots.filter(bot => sectionKey(bot.section) === name);
        const rooms = this.groups.filter(group => sectionKey(group.section) === name);
        if (members.some(bot => bot.busy || bot.tasks?.some(task => task.busy)) || rooms.some(group => group.busyBotId)) {
            return "Stop this department's active work before deleting it";
        }
        const nextBots = this.bots.map(bot => ({ ...bot,
            ...(sectionKey(bot.section) === name ? reshowWhenMoved(bot, { section: undefined }) : {}),
            ...(bot.managedSections ? { managedSections: bot.managedSections.filter(section => sectionKey(section) !== name) } : {}),
        }));
        if (chiefConflict(nextBots)) {
            return "General already has a Chief of Staff. Move or change this department's Chief before deleting it";
        }
        const nextGroups = this.groups.map(group => sectionKey(group.section) === name ? { ...group, section: undefined } : group);
        try {
            this.saveBots(nextBots);
            this.saveGroups(nextGroups);
            changeEmptySection(name, null);
        }
        catch (error) {
            this.saveBots();
            this.saveGroups();
            throw error;
        }
        for (let i = 0; i < nextBots.length; i++)
            Object.assign(this.bots[i], nextBots[i]);
        for (let i = 0; i < nextGroups.length; i++)
            Object.assign(this.groups[i], nextGroups[i]);
        for (const bot of this.bots)
            this.emit({ type: "bot", botId: bot.id });
        for (const group of rooms)
            this.emit({ type: "group", groupId: group.id });
        this.emit({ type: "sections" });
        return undefined;
    }
    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    emit(change) {
        for (const listener of Array.from(this.listeners)) {
            try {
                listener(change);
            }
            catch (error) {
                console.error("store: change listener threw", error);
            }
        }
    }
    group(id) {
        return this.groups.find((g) => g.id === id);
    }
    groupByThread(threadId) {
        return this.groups.find((group) => group.threadId === threadId || group.tasks?.some((task) => task.threadId === threadId));
    }
    createGroup(name, memberIds, dm = false, section, setup) {
        this.rememberSections([section]);
        const threadId = setup?.threadId ?? newId();
        const createdAt = Date.now();
        const group = {
            id: setup?.id ?? newId(),
            threadId,
            name,
            memberIds,
            defaultResponder: dm
                ? { kind: "mentions" }
                : normalizeGroupDefaultResponder(setup?.defaultResponder, memberIds, false),
            bulletin: setup?.bulletin ?? "",
            unread: false,
            createdAt,
            dm: dm || undefined,
            busyBotId: null,
            section,
        };
        if (!dm) {
            group.tasks = [{ threadId, title: UNTITLED_TASK, createdAt, updatedAt: createdAt }];
            group.setupCompletedAt = setup?.completed ? createdAt : null;
            group.setupSkippedAt = null;
        }
        saveRegistryFor("groups.json", dm ? "the new chat" : "the new room", () => this.saveGroups([group, ...this.groups]));
        this.groups.unshift(group);
        this.emit({ type: "group", groupId: group.id });
        return group;
    }
    dmGroup(a, b) {
        return this.groups.find((g) => g.dm && g.memberIds.length === 2 && g.memberIds.includes(a) && g.memberIds.includes(b));
    }
    patchGroup(id, patch) {
        const group = this.group(id);
        if (!group)
            return null;
        if (Object.prototype.hasOwnProperty.call(patch, "section")) {
            this.rememberSections([patch.section]);
        }
        const { busyBotId, ...stored } = patch;
        if (Object.prototype.hasOwnProperty.call(patch, "busyBotId")) {
            if (busyBotId && busyBotId !== group.busyBotId)
                group.turnStartedAt = Date.now();
            else if (!busyBotId)
                delete group.turnStartedAt;
            group.busyBotId = busyBotId ?? null;
        }
        this.commitGroupChange(group, group.dm ? "the chat's settings" : "the room's settings", () => {
            Object.assign(group, stored);
            syncGroupReadPatch(group, stored);
            if (Object.prototype.hasOwnProperty.call(stored, "turnTimeoutMinutes") && stored.turnTimeoutMinutes == null) {
                delete group.turnTimeoutMinutes;
            }
            if (!group.dm && Object.prototype.hasOwnProperty.call(stored, "pinnedMessageId")) {
                const active = this.activeGroupTask(group.id);
                if (active)
                    active.pinnedMessageId = stored.pinnedMessageId;
            }
            group.defaultResponder = normalizeGroupDefaultResponder(group.defaultResponder, group.memberIds, Boolean(group.dm));
            if (Object.prototype.hasOwnProperty.call(stored, "memberIds"))
                pruneRoomHolds(group);
        });
        this.emit({ type: "group", groupId: group.id });
        return group;
    }
    deleteThreadRecord(threadId, dbAlreadyDeleted = false) {
        this.threads.delete(threadId);
        discardNativeLog(threadId);
        if (!dbAlreadyDeleted)
            mdb.deleteThread(threadId);
        for (const file of [
            messagesFile(threadId),
            `${messagesFile(threadId)}.imported`,
            join(EVENTS_DIR, `${threadId}.ndjson`),
            join(NATIVE_DIR, `${threadId}.ndjson`),
        ]) {
            try {
                unlinkSync(file);
            }
            catch { }
        }
        this.emit({ type: "thread.deleted", threadId });
    }
    deleteGroup(id) {
        const group = this.group(id);
        if (!group)
            return false;
        const remaining = this.groups.filter((g) => g.id !== id);
        this.threadsGoing([group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)]);
        saveRegistryFor("groups.json", group.dm ? "the chat deletion" : "the room deletion", () => this.saveGroups(remaining));
        this.groups = remaining;
        for (const threadId of new Set([group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)])) {
            this.deleteThreadRecord(threadId);
        }
        this.emit({ type: "group.deleted", groupId: id });
        return true;
    }
    reconcileInterruptedGroupGoals(resolve, fallbackDetail = "OpenMausBot restarted before this goal finished.", fallbackFinishedAt = Date.now()) {
        const ownedThreadIds = new Set(this.bots.flatMap((bot) => (bot.tasks ?? []).map((task) => task.threadId)));
        for (const group of this.groups) {
            ownedThreadIds.add(group.threadId);
            for (const task of group.tasks ?? [])
                ownedThreadIds.add(task.threadId);
        }
        let recovered = 0;
        for (const hit of mdb.workingGoalRunMessages()) {
            if (!ownedThreadIds.has(hit.threadId) || !hit.message.goalRun)
                continue;
            const resolution = resolve?.(hit.message.goalRun.runId, hit.threadId) ?? {
                status: "failed",
                detail: fallbackDetail,
                finishedAt: fallbackFinishedAt,
            };
            const state = resolution.status === "needs-input"
                ? "needs your input"
                : resolution.status === "limit-reached"
                    ? "reached its turn limit"
                    : resolution.status;
            this.patchMessage(hit.threadId, hit.message.id, {
                text: `Goal ${state}: ${resolution.detail}`,
                goalRun: {
                    ...hit.message.goalRun,
                    status: resolution.status,
                    detail: resolution.detail,
                    finishedAt: resolution.finishedAt,
                },
            });
            recovered += 1;
        }
        return recovered;
    }
    groupTasks(groupId) { return groupTasks(this.group(groupId)); }
    activeGroupTask(groupId) { return activeGroupTask(this.group(groupId)); }
    groupTaskByThread(groupId, threadId) {
        return groupTaskByThread(this.group(groupId), threadId);
    }
    markGroupThreadUnread(groupId, threadId, unread, lastReadMessageId) {
        const group = this.group(groupId);
        if (group?.dm && group.threadId === threadId)
            return this.patchGroup(groupId, { unread, ...(!unread && lastReadMessageId ? { lastReadMessageId } : {}) });
        const task = this.groupTaskByThread(groupId, threadId);
        if (!group || !task)
            return null;
        this.commitGroupChange(group, "the thread's read state", () => setGroupTaskRead(group, task, unread, lastReadMessageId));
        this.emit({ type: "group", groupId });
        return group;
    }
    createGroupTask(groupId, title, activate = true) {
        const group = this.group(groupId);
        if (!group || group.dm)
            return null;
        const createdAt = Date.now();
        const task = {
            threadId: newId(),
            title: title?.trim().slice(0, 80) || UNTITLED_TASK,
            createdAt,
            updatedAt: createdAt,
        };
        this.commitGroupChange(group, "the new thread", () => {
            group.tasks = [task, ...(group.tasks ?? [])];
            if (activate)
                mirrorActiveGroupTask(group, task);
        });
        this.emit({ type: "group", groupId });
        return task;
    }
    forkGroupTask(groupId, sourceThreadId, messageId) {
        const group = this.group(groupId);
        const source = this.groupTaskByThread(groupId, sourceThreadId);
        if (!group || !source)
            return null;
        const task = createGroupFork(source, this.activePath(sourceThreadId), messageId, (created) => this.commitGroupChange(group, "the forked thread", () => { group.tasks = [created, ...(group.tasks ?? [])]; }));
        if (task)
            this.emit({ type: "group", groupId });
        return task;
    }
    switchGroupTask(groupId, threadId) {
        const group = this.group(groupId);
        const task = group?.tasks?.find((candidate) => candidate.threadId === threadId);
        if (!group || group.dm || !task)
            return null;
        this.commitGroupChange(group, "the thread switch", () => mirrorActiveGroupTask(group, task));
        this.emit({ type: "group", groupId });
        return group;
    }
    patchGroupTask(groupId, threadId, patch) {
        const group = this.group(groupId);
        const task = this.groupTaskByThread(groupId, threadId);
        if (!group || !task)
            return null;
        this.commitGroupChange(group, "the thread change", () => {
            if (patch.title !== undefined)
                task.title = patch.title.trim().slice(0, 80) || UNTITLED_TASK;
            if (patch.pinned)
                task.pinned = true;
            else if (patch.pinned === false)
                delete task.pinned;
            if (patch.activity)
                task.activity = patch.activity;
            else if (patch.activity === null)
                delete task.activity;
            for (const key of ["turnTimeoutMinutes", "archivedAt"])
                if (patch[key] === null)
                    delete task[key];
                else if (patch[key] !== undefined)
                    task[key] = patch[key];
        });
        this.emit({ type: "group", groupId });
        return task;
    }
    titleGroupTaskFromFirstMessage(groupId, text, threadId) {
        const group = this.group(groupId);
        const task = threadId ? this.groupTaskByThread(groupId, threadId) : this.activeGroupTask(groupId);
        if (!group || !task || task.titleFromFirstMessage || task.title !== UNTITLED_TASK)
            return null;
        this.commitGroupChange(group, "the thread's title", () => {
            task.title = titleFromMessage(text);
            task.titleFromFirstMessage = true;
        });
        this.emit({ type: "group", groupId });
        return task;
    }
    retitleGroupTask(groupId, threadId, machineTitle, title) {
        const task = this.groupTaskByThread(groupId, threadId);
        if (!task || task.title !== machineTitle)
            return null;
        return this.patchGroupTask(groupId, threadId, { title: threadTitleFrom(title) });
    }
    deleteGroupTask(groupId, threadId) {
        const result = this.deleteGroupTasks(groupId, [threadId]);
        return result?.deleted.length ? result.group : null;
    }
    /** Null when nothing may go: no such channel, a bot-to-bot channel, or a request that would leave it with no task. */
    deleteGroupTasks(groupId, threadIds) {
        const group = this.group(groupId);
        if (!group || group.dm || !group.tasks)
            return null;
        const present = new Set(group.tasks.map((task) => task.threadId));
        const unique = [...new Set(threadIds)];
        const deleted = unique.filter((id) => present.has(id));
        const missing = unique.filter((id) => !present.has(id));
        if (deleted.length >= group.tasks.length)
            return null;
        if (!deleted.length)
            return { group, deleted, missing };
        const doomed = new Set(deleted);
        this.threadsGoing(deleted);
        mdb.deleteThreads(deleted, () => this.commitGroupChange(group, "the thread deletion", () => {
            group.tasks = group.tasks.filter((task) => !doomed.has(task.threadId));
            if (doomed.has(group.threadId))
                mirrorActiveGroupTask(group, group.tasks[0]);
            refreshGroupUnread(group);
        }));
        for (const id of deleted)
            this.deleteThreadRecord(id, true);
        this.emit({ type: "group", groupId });
        return { group, deleted, missing };
    }
    setReaction(threadId, messageId, by, reaction) {
        const existing = this.messagesFor(threadId).find((m) => m.id === messageId);
        if (!existing)
            return null;
        const next = [...(existing.reactions ?? []).filter((r) => r.by !== by), ...(reaction ? [{ ...reaction, by }] : [])];
        return this.patchMessage(threadId, messageId, { reactions: next.length ? next : undefined });
    }
    thread(threadId) {
        return this.threads.get(threadId) ?? this.threads.load(threadId, mdb.readThread(threadId, messagesFile(threadId)));
    }
    busyThreadIds() {
        const busy = new Set();
        for (const bot of this.bots) {
            if (bot.busy)
                busy.add(bot.threadId);
            for (const task of bot.tasks ?? [])
                if (task.busy)
                    busy.add(task.threadId);
        }
        for (const group of this.groups) {
            if (group.busyBotId)
                for (const threadId of [group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)])
                    busy.add(threadId);
        }
        return busy;
    }
    messagesFor(threadId) {
        return this.thread(threadId).messages;
    }
    /** Legacy rows without a parentId chain only on a full load, so a bounded page missing that context falls back to one. */
    messagesTail(threadId, limit) {
        let state = this.threads.get(threadId);
        if (!state) {
            const tail = mdb.readThreadTail(threadId, messagesFile(threadId), limit);
            const legacyRows = tail.hasMore !== undefined && tail.messages.some((m) => m.parentId === undefined);
            if (tail.hasMore !== true || legacyRows) {
                state = this.threads.load(threadId, legacyRows ? mdb.readThread(threadId, messagesFile(threadId)) : tail);
            }
            else {
                return {
                    messages: tail.messages,
                    hasMore: tail.hasMore,
                    activeLeafId: tail.activeLeafId ?? tail.messages.at(-1)?.id ?? null,
                };
            }
        }
        const { messages, activeLeafId } = state;
        const start = Math.max(0, messages.length - limit);
        return { messages: messages.slice(start), hasMore: start > 0, activeLeafId };
    }
    importTranscript(threadId, messages, activeLeafId, relinked) {
        if (!relinked && this.messagesFor(threadId).length)
            throw new Error("Cannot import over an existing conversation");
        mdb.importThread(threadId, messages, activeLeafId, relinked);
        this.threads.delete(threadId);
        const newest = messages.reduce((max, message) => Math.max(max, message.at), Number.NEGATIVE_INFINITY);
        const newestOrder = messages.reduce((max, message) => movesThreadToTop(message) ? Math.max(max, message.turnCompletedAt ?? message.at) : max, Number.NEGATIVE_INFINITY);
        if (Number.isFinite(newest))
            this.noteThreadActivity(threadId, newest, Number.isFinite(newestOrder), newestOrder);
    }
    activeLeaf(threadId) {
        return this.thread(threadId).activeLeafId;
    }
    activePath(threadId) {
        const t = this.thread(threadId);
        const byId = new Map(t.messages.map((m) => [m.id, m]));
        const path = [];
        let cur = t.activeLeafId ? byId.get(t.activeLeafId) : undefined;
        while (cur) {
            path.push(cur);
            cur = cur.parentId ? byId.get(cur.parentId) : undefined;
        }
        return path.reverse();
    }
    markTerminalAssistantMessage(threadId, turnId) {
        const path = this.activePath(threadId);
        for (let i = path.length - 1; i >= 0; i -= 1) {
            const message = path[i];
            if (message.role === "bot" && message.kind === "text" && message.turnId === turnId) {
                if (message.turnTerminal)
                    return message;
                return this.patchMessage(threadId, message.id, { turnTerminal: true, turnCompletedAt: Date.now() });
            }
        }
        return null;
    }
    appendMessage(threadId, message, command) {
        const t = this.thread(threadId);
        const full = { id: newId(), at: Date.now(), parentId: t.activeLeafId, ...redactBotAuthored(message) };
        const persist = () => { mdb.appendMessage(threadId, full); return full; };
        const committed = command ? runCommand(command, persist) : persist();
        if (committed.id !== full.id)
            return committed;
        t.messages.push(full);
        this.threads.grew(threadId, full);
        t.activeLeafId = full.id;
        if (full.kind === "screen") {
            for (const pruned of this.pruneScreenFrames(t, threadId)) {
                mdb.updateMessage(threadId, pruned);
                this.emit({ type: "message.patch", threadId, message: pruned });
            }
        }
        this.noteThreadActivity(threadId, full.at, movesThreadToTop(full), full.turnCompletedAt ?? full.at);
        this.emit({ type: "message", threadId, message: full });
        if (full.role === "user" && full.kind === "text")
            this.dismissOnboardingCard(threadId);
        return full;
    }
    insertMessageAfter(threadId, anchorId, message) {
        const t = this.thread(threadId);
        const anchorExists = anchorId !== undefined && t.messages.some((m) => m.id === anchorId);
        if (!anchorExists || t.activeLeafId === anchorId)
            return this.appendMessage(threadId, message);
        const full = { id: newId(), at: Date.now(), ...redactBotAuthored(message), parentId: anchorId };
        const children = t.messages.filter((m) => m.parentId === anchorId);
        t.messages.push(full);
        this.threads.grew(threadId, full);
        mdb.insertMessage(threadId, full);
        if (full.kind === "screen") {
            for (const pruned of this.pruneScreenFrames(t, threadId)) {
                mdb.updateMessage(threadId, pruned);
                this.emit({ type: "message.patch", threadId, message: pruned });
            }
        }
        this.noteThreadActivity(threadId, full.at, movesThreadToTop(full), full.turnCompletedAt ?? full.at);
        this.emit({ type: "message", threadId, message: full });
        // After the insert, so no client ever sees two siblings claiming the same parent.
        for (const child of children)
            this.patchMessage(threadId, child.id, { parentId: full.id });
        return full;
    }
    dismissOnboardingCard(threadId) {
        const t = this.thread(threadId);
        const card = t.messages.find((message) => message.kind === "options" && message.card && !message.card.requestId && !message.card.dismissed);
        if (!card?.card)
            return null;
        return this.patchMessage(threadId, card.id, { card: { ...card.card, dismissed: true } });
    }
    pruneScreenFrames(t, threadId, keep = 4) {
        const pruned = [];
        let seen = 0;
        for (let i = t.messages.length - 1; i >= 0 && seen < t.messages.length; i--) {
            const m = t.messages[i];
            if (m.kind !== "screen" || !m.png)
                continue;
            seen += 1;
            if (seen > keep) {
                this.threads.grew(threadId, { ...m, png: undefined }, m);
                m.png = undefined;
                pruned.push(m);
            }
        }
        return pruned;
    }
    branchMessage(threadId, sourceId, text, sendId, sender, dataContext) {
        const t = this.thread(threadId);
        const source = t.messages.find((m) => m.id === sourceId);
        if (!source)
            return null;
        const full = {
            id: newId(),
            at: Date.now(),
            role: "user",
            kind: "text",
            text,
            parentId: source.parentId ?? null,
            replyToId: source.replyToId,
            ...(source.reaction && source.text === text ? { reaction: source.reaction } : {}),
            ...(sendId ? { sendId } : {}),
            ...(sender ? { sender } : {}),
            ...(dataContext ? { dataContext } : {}),
        };
        t.messages.push(full);
        this.threads.grew(threadId, full);
        t.activeLeafId = full.id;
        mdb.appendMessage(threadId, full);
        this.noteThreadActivity(threadId, full.at, true);
        this.emit({ type: "message", threadId, message: full });
        // A client adopts a new message as its leaf only when it chains onto its leaf; a sibling needs this pointer.
        this.emit({ type: "thread", threadId, activeLeafId: full.id });
        return full;
    }
    setActiveLeaf(threadId, messageId) {
        const t = this.thread(threadId);
        if (!t.messages.some((m) => m.id === messageId))
            return null;
        let cur = messageId;
        for (;;) {
            const children = t.messages.filter((m) => m.parentId === cur);
            if (!children.length)
                break;
            cur = children.reduce((a, b) => (b.at >= a.at ? b : a)).id;
        }
        t.activeLeafId = cur;
        mdb.setActiveLeaf(threadId, cur);
        this.emit({ type: "thread", threadId, activeLeafId: cur });
        return cur;
    }
    patchMessage(threadId, messageId, patch, command) {
        const t = this.thread(threadId);
        const idx = t.messages.findIndex((m) => m.id === messageId);
        if (idx === -1)
            return null;
        const next = { ...t.messages[idx], ...patch, card: patch.card ?? t.messages[idx].card };
        // Persist before memory: a failed write must not mark a card answered that a restart shows pending.
        let applied = false;
        const persist = () => { mdb.updateMessage(threadId, next); applied = true; return next; };
        const committed = command ? runCommand(command, persist) : persist();
        if (!applied)
            return committed;
        if (!movesThreadToTop(t.messages[idx]) && movesThreadToTop(next))
            this.noteThreadActivity(threadId, next.at, true, next.turnCompletedAt ?? next.at);
        this.threads.grew(threadId, next, t.messages[idx]);
        t.messages[idx] = next;
        this.emit({ type: "message.patch", threadId, message: next });
        return next;
    }
    bot(id) {
        return this.bots.find((b) => b.id === id) ?? this.standIns.get(id) ?? null;
    } /** One of this place's own bots. Every method that changes a bot looks here and never among the stand-ins: a record with `home` is read-only on this place. */
    own(id) {
        return this.bots.find((b) => b.id === id) ?? null;
    }
    botByThread(threadId) {
        return this.bots.find((b) => b.threadId === threadId || b.tasks?.some((t) => t.threadId === threadId)) ?? null;
    }
    newBotSelection(requested) {
        return this.completeNewBotSelection(requested ?? this.defaultSelection());
    }
    createBot(profile = {}, opts = {}) {
        const toolScope = parseToolScope(profile.toolScope);
        if (!toolScope.ok)
            throw new Error(toolScope.error);
        this.rememberSections([profile.section]);
        const name = profile.name?.trim() || pickBotName(this.bots.map((b) => b.name));
        const section = sectionKey(profile.section);
        const bot = {
            id: opts.id ?? newId(),
            threadId: opts.threadId ?? newId(),
            name,
            title: profile.title ?? "",
            description: profile.description ?? "",
            soul: profile.soul ?? "",
            soulHash: soulHash(profile.soul ?? ""),
            notifications: true,
            color: profile.color ?? rotationColor(this.bots.length), mascotFaceColor: profile.mascotFaceColor ?? undefined,
            ...(profile.mascotExpression ? { mascotExpression: profile.mascotExpression } : {}),
            ...(profile.mascotBody ? { mascotBody: profile.mascotBody } : {}),
            ...this.newBotSharing(profile.visibility, newBotOwner(profile)),
            ...(toolScope.scope ? { toolScope: toolScope.scope } : {}),
            unread: false,
            modelSelection: this.newBotSelection(profile.modelSelection),
            resumeCursors: {},
            createdAt: Date.now(),
        };
        if (section)
            bot.section = section;
        if (profile.createdBy?.trim())
            bot.createdBy = ownerEmail(profile.createdBy);
        if (profile.reportsTo?.trim())
            bot.reportsTo = ownerEmail(profile.reportsTo);
        if (profile.cwd)
            bot.cwd = profile.cwd;
        bot.tasks = [{
                threadId: bot.threadId,
                title: UNTITLED_THREAD,
                createdAt: bot.createdAt,
                updatedAt: bot.createdAt,
                resumeCursors: {},
                unread: false,
                activity: "idle",
                busy: false,
            }];
        // Persist before publishing or greeting, so an interrupted creation cannot inherit tools.
        this.saveBots([bot, ...this.bots]);
        this.bots.unshift(bot);
        try {
            writeSoulMirror(bot.id, bot.soul ?? "");
        }
        catch (e) {
            console.warn(`[bot-folder] could not write SOUL.md mirror for ${bot.id}: ${e.message}`);
        }
        // Before its transcript: clients need the bot/thread mapping to place either message.
        opts.beforeShown?.(bot);
        this.emit({ type: "bot", botId: bot.id });
        if (opts.seedMessages !== false) {
            this.appendMessage(bot.threadId, initialGreetingMessage(name, this.initialLanguage, !bot.soul?.trim() && !bot.description.trim(), this.personName()));
        }
        return bot;
    }
    applyTeamSetup(request) {
        const chief = this.own(request.botId);
        if (!chief)
            throw new Error("The requesting Chief no longer exists");
        if (chief.lastTeamSetupReceipt?.requestId === request.requestId)
            return chief.lastTeamSetupReceipt.result;
        const managedSections = [...new Set([...(chief.managedSections ?? []), ...request.newTeams])];
        if (managedSections.length > 100 || managedSections.some((name) => name.trim() !== name || name.length > 60) ||
            request.newTeams.some((name) => !name) || (request.newTeams.length && !chief.chiefOfStaff))
            throw new Error("Invalid reviewed Chief team scope");
        const nextBots = [...this.bots];
        const changed = [];
        for (const operation of request.operations) {
            const at = nextBots.findIndex((bot) => bot.id === operation.botId);
            let next;
            if (operation.action === "create") {
                if (at >= 0 || !operation.threadId || !operation.fields.name || !operation.fields.modelSelection)
                    throw new Error("Invalid new bot in team setup");
                const createdAt = Date.now();
                const modelSelection = this.newBotSelection(operation.fields.modelSelection);
                next = { id: operation.botId, threadId: operation.threadId, name: operation.fields.name,
                    title: "", description: "", soul: "", notifications: true, color: rotationColor(nextBots.length), unread: false,
                    resumeCursors: {}, createdAt, ...operation.fields, modelSelection,
                    autoApprove: false,
                    ...sharedAsMaker(chief),
                    // A Chief's new specialist reports to the Chief's own person.
                    ...(botOwner(chief) ? { createdBy: botOwner(chief) } : {}),
                    tasks: [{ threadId: operation.threadId, title: UNTITLED_THREAD, createdAt, updatedAt: createdAt, resumeCursors: {},
                            unread: false, activity: "idle", busy: false }], };
                Object.assign(next, appsFromCreator(chief, next));
                if (!next.cwd)
                    delete next.cwd;
                nextBots.unshift(next);
            }
            else {
                if (at < 0)
                    throw new Error("A setup target no longer exists");
                const previous = nextBots[at];
                next = { ...previous, ...reshowWhenMoved(previous, operation.fields) };
                if (operation.fields.modelSelection)
                    next.tasks = this.withDefaultModel(previous, operation.fields.modelSelection);
                nextBots[at] = next;
            }
            if (operation.fields.chiefOfStaff === false)
                delete next.managedSections;
            next.section = sectionKey(next.section) || undefined;
            if (operation.fields.soul !== undefined) {
                next.soulHash = soulHash(operation.fields.soul);
                next.soulDrift = false;
            }
            changed.push(next);
        }
        const result = { state: "applied", newTeams: request.newTeams, bots: changed.map((bot, index) => ({
                id: bot.id, name: bot.name, section: bot.section, modelSelection: structuredClone(bot.modelSelection), chiefOfStaff: Boolean(bot.chiefOfStaff),
                action: request.operations[index].action === "create" ? "created" : "updated",
            })) };
        const chiefAt = nextBots.findIndex((bot) => bot.id === chief.id);
        const nextChief = { ...nextBots[chiefAt], lastTeamSetupReceipt: { requestId: request.requestId, result } };
        // Only new teams the human review named may extend this Chief's reach.
        if (request.newTeams.length && nextChief.chiefOfStaff) {
            nextChief.managedSections = managedSections;
        }
        nextBots[chiefAt] = nextChief;
        this.saveBots(nextBots);
        this.bots = nextBots;
        for (const bot of changed) {
            try {
                writeSoulMirror(bot.id, bot.soul ?? "");
            }
            catch (error) {
                console.warn(`[bot-folder] could not refresh reviewed setup mirror for ${bot.id}: ${error.message}`);
            }
            this.emit({ type: "bot", botId: bot.id });
        }
        this.emit({ type: "bot", botId: chief.id });
        return result;
    }
    switchNeedsAsk(botId, threadId, from, to) {
        if (from.instanceId === to.instanceId)
            return false;
        const thread = this.projectBotForTask(botId, threadId);
        return Boolean(thread) && modelSwitchNeedsAsk(approvalModeFor(thread), this.driverKindOf(from.instanceId), this.driverKindOf(to.instanceId));
    }
    withDefaultModel(bot, next) {
        return bot.tasks?.map((task) => ({
            ...task,
            approvalMode: approvalModeFor(this.projectBotForTask(bot.id, task.threadId)),
            autoApprove: task.autoApprove ?? bot.autoApprove,
            alwaysAllow: structuredClone(task.alwaysAllow ?? bot.alwaysAllow ?? []),
            ...(task.modelSelection === undefined && this.switchNeedsAsk(bot.id, task.threadId, bot.modelSelection, next) ? structuredClone(ASK_NOW) : {}),
        }));
    }
    applyModelDefault(id, modelSelection) {
        const previous = this.own(id);
        if (!previous)
            return null;
        const next = { ...previous, modelSelection: structuredClone(modelSelection), tasks: this.withDefaultModel(previous, modelSelection) };
        this.saveBots(this.bots.map((candidate) => candidate.id === id ? next : candidate));
        this.bots = this.bots.map((candidate) => candidate.id === id ? next : candidate);
        this.emit({ type: "bot", botId: id });
        return next;
    }
    deleteBot(id, setupRequest) {
        const bot = this.own(id);
        if (!bot)
            return false;
        if (bot.defaultBot)
            throw Object.assign(new Error(defaultBotRefusal(bot.name)), { status: 409 });
        let nextBots = this.bots.filter((b) => b.id !== id);
        this.threadsGoing([bot.threadId, ...(bot.tasks ?? []).map((t) => t.threadId)]);
        if (setupRequest) {
            const chief = this.own(setupRequest.botId);
            if (!chief || chief.id === id || setupRequest.deletion?.botId !== id)
                throw new Error("The reviewed deletion no longer has a valid owner");
            const lastTeamSetupReceipt = { requestId: setupRequest.requestId, result: { state: "applied", newTeams: [], bots: [
                        { id: bot.id, name: bot.name, action: "deleted" },
                    ] } };
            nextBots = nextBots.map((candidate) => candidate.id === chief.id ? { ...candidate, lastTeamSetupReceipt } : candidate);
        }
        // Persist removal before deleting data: a failed save must leave the bot recoverable.
        this.saveBots(nextBots);
        this.bots = nextBots;
        this.legacyActivities.delete(id);
        const rooms = this.groups.filter((g) => !g.dm && g.memberIds.includes(id));
        for (const g of rooms) {
            g.memberIds = g.memberIds.filter((member) => member !== id);
            if (g.busyBotId === id) {
                g.busyBotId = null;
                delete g.turnStartedAt;
            }
            g.defaultResponder = normalizeGroupDefaultResponder(g.defaultResponder, g.memberIds, false);
        }
        if (rooms.length) {
            try {
                this.saveGroups();
            }
            catch (error) {
                console.warn("store: room cleanup will retry on restart", error);
            }
        }
        for (const threadId of new Set([bot.threadId, ...(bot.tasks ?? []).map((t) => t.threadId)])) {
            this.deleteThreadRecord(threadId);
        }
        try {
            rmSync(workspaceDir(id), { recursive: true, force: true });
        }
        catch { }
        try {
            rmSync(journalFile(id), { force: true });
        }
        catch { }
        mdb.deleteBotMemoryFiles(id);
        forgetBotMemoryJournal(id);
        try {
            rmSync(join(DATA_DIR, "skill-state", id), { recursive: true, force: true });
        }
        catch { }
        removeBotFolder(id);
        this.emit({ type: "bot.deleted", botId: id });
        for (const g of rooms)
            this.emit({ type: "group", groupId: g.id });
        return true;
    }
    patchBot(id, patch) {
        const bot = this.own(id);
        if (!bot)
            return null;
        patch = reshowWhenMoved(bot, patch);
        if (patch.connectorTools !== undefined) {
            const parsed = parseConnectorTools(patch.connectorTools);
            if (!parsed.ok)
                throw new Error(parsed.error);
            patch = { ...patch, connectorTools: parsed.grants };
        }
        if (Object.hasOwn(patch, "toolScope")) {
            const parsed = parseToolScope(patch.toolScope);
            if (!parsed.ok)
                throw new Error(parsed.error);
            patch = { ...patch, toolScope: parsed.scope };
        }
        const wideningToolScope = Object.hasOwn(patch, "toolScope") && toolScopeWidens(bot.toolScope, patch.toolScope);
        const nextToolScope = patch.toolScope;
        if (wideningToolScope) {
            patch = { ...patch };
            delete patch.toolScope;
        }
        const toAsk = patch.modelSelection ? (bot.tasks ?? []).filter((task) => task.modelSelection === undefined &&
            this.switchNeedsAsk(id, task.threadId, bot.modelSelection, patch.modelSelection)) : [];
        // Revocations take effect in memory even when the disk write fails.
        Object.assign(bot, patch);
        if (patch.connectorScopes !== undefined)
            grantScopedApps(bot);
        for (const task of toAsk)
            Object.assign(task, structuredClone(ASK_NOW));
        const task = this.activeTask(id);
        if (task) {
            for (const key of ["resumeCursors", "rewound", "pinnedMessageId", "unread"]) {
                if (Object.prototype.hasOwnProperty.call(patch, key)) {
                    Object.assign(task, { [key]: structuredClone(patch[key]) });
                }
            }
            bot.unread = bot.tasks.some(taskCountsAsBotUnread);
        }
        if (wideningToolScope) {
            // New authority goes live only after its durable save succeeds.
            this.saveBots(this.bots.map((candidate) => candidate === bot ? { ...bot, toolScope: nextToolScope } : candidate));
            bot.toolScope = nextToolScope;
        }
        else
            this.saveBots();
        this.emit({ type: "bot", botId: id });
        return bot;
    }
    clearVoiceSelections() {
        const changed = this.bots.filter((bot) => bot.voice !== undefined && bot.voice !== "");
        if (!changed.length)
            return [];
        const next = this.bots.map((bot) => bot.voice === undefined || bot.voice === "" ? bot : { ...bot, voice: undefined });
        this.saveBots(next);
        for (const bot of changed) {
            delete bot.voice;
            this.emit({ type: "bot", botId: bot.id });
        }
        return changed;
    }
    patchBotProfile(id, patch) {
        const bot = this.own(id);
        if (!bot)
            return null;
        const next = { ...bot, ...reshowWhenMoved(bot, patch) };
        if (patch.soul !== undefined) {
            next.soulHash = soulHash(patch.soul);
            next.soulDrift = false;
        }
        this.saveBots(this.bots.map((candidate) => candidate.id === id ? next : candidate));
        Object.assign(bot, next);
        if (patch.soul !== undefined) {
            try {
                writeSoulMirror(id, patch.soul);
            }
            catch (e) {
                console.warn(`[bot-folder] could not write SOUL.md mirror for ${id}: ${e.message}`);
            }
        }
        this.emit({ type: "bot", botId: id });
        return bot;
    }
    setSoul(id, soul) {
        return this.patchBotProfile(id, { soul });
    }
    setBotsSection(botIds, section) {
        const ids = [...new Set(botIds)];
        const targets = ids.map((id) => this.own(id));
        if (targets.some((bot) => !bot || bot.hidden))
            return { ok: false, reason: "unavailable" };
        const targetSection = sectionKey(section);
        const selected = targets;
        const patches = new Map();
        for (const bot of selected) {
            patches.set(bot.id, reshowWhenMoved(bot, { section: targetSection || undefined }));
        }
        if (chiefConflict(this.bots.map((bot) => ({ ...bot, ...patches.get(bot.id) }))))
            return { ok: false, reason: "chief-conflict" };
        const changedIds = new Set();
        const nextBots = this.bots.map((bot) => {
            const patch = patches.get(bot.id);
            if (!patch)
                return bot;
            const next = { ...bot, ...patch };
            if (JSON.stringify(next) !== JSON.stringify(bot))
                changedIds.add(bot.id);
            return next;
        });
        if (changedIds.size) {
            this.saveBots(nextBots);
            for (const bot of this.bots) {
                const patch = patches.get(bot.id);
                if (patch)
                    Object.assign(bot, patch);
            }
            for (const botId of changedIds)
                this.emit({ type: "bot", botId });
        }
        this.rememberSections([targetSection]);
        return { ok: true, bots: ids.map((id) => this.own(id)) };
    }
    updateTeamMembers(section, addIds, removeIds) {
        const key = sectionKey(section);
        if (!key || !this.sections.includes(key))
            return { ok: false, reason: "unavailable" };
        const adds = new Set(addIds), removes = new Set(removeIds);
        const ids = new Set([...adds, ...removes]);
        for (const id of ids) {
            const bot = this.own(id);
            if (!bot || bot.hidden)
                return { ok: false, reason: "unavailable" };
            if (adds.has(id) && removes.has(id))
                return { ok: false, reason: "membership-changed" };
            if (removes.has(id) && sectionKey(bot.section) !== key)
                return { ok: false, reason: "membership-changed" };
        }
        const next = this.bots.map(bot => ids.has(bot.id)
            ? { ...bot, ...reshowWhenMoved(bot, { section: adds.has(bot.id) ? key : undefined }) } : bot);
        if (chiefConflict(next))
            return { ok: false, reason: "chief-conflict" };
        if (ids.size) {
            this.saveBots(next);
            for (let i = 0; i < next.length; i++)
                if (ids.has(next[i].id))
                    Object.assign(this.bots[i], next[i]);
            for (const botId of ids)
                this.emit({ type: "bot", botId });
        }
        return { ok: true, bots: this.bots.filter(bot => ids.has(bot.id)) };
    }
    setActivity(botId, activity) {
        const bot = this.own(botId);
        if (!bot)
            return null;
        if ((this.legacyActivities.get(botId) ?? "idle") === activity)
            return bot;
        this.legacyActivities.set(botId, activity);
        this.refreshBotActivity(bot);
        this.emit({ type: "bot", botId });
        return bot;
    }
    setTaskActivity(botId, threadId, activity, noTurnRunning = false) {
        const bot = this.own(botId);
        const task = this.taskByThread(botId, threadId);
        if (!bot || !task)
            return null;
        const busy = ACTIVITY_BUSY.has(activity) && !noTurnRunning;
        if ((task.activity ?? "idle") === activity && Boolean(task.busy) === busy)
            return bot;
        const wasBusy = Boolean(task.busy);
        task.activity = activity;
        task.busy = busy;
        if (busy && !wasBusy)
            task.turnStartedAt = Date.now();
        else if (!busy)
            delete task.turnStartedAt;
        if (task.snoozedUntil === 0) {
            task.snoozedUntil = undefined;
            this.saveBots();
        }
        this.refreshBotActivity(bot);
        this.emit({ type: "bot", botId, threadId });
        return bot;
    }
    refreshBotActivity(bot) {
        const activities = [this.legacyActivities.get(bot.id), ...(bot.tasks ?? []).map((task) => task.activity)];
        bot.activity = ["waiting-on-you", "no-signal", "working", "dead"]
            .find((activity) => activities.includes(activity)) ?? "idle";
        bot.busy = ACTIVITY_BUSY.has(this.legacyActivities.get(bot.id) ?? "idle") || (bot.tasks ?? []).some((task) => task.busy);
    }
    /** Makes `id` its scope's one Chief (its owner's on a Team Cloud, else its department's), or with no `id` leaves
     * `section` without one. */
    setChiefOfStaff(id, section) {
        const selected = id ? this.own(id) : null;
        if (id && !selected)
            return null;
        const scope = selected ? chiefScope(selected) : chiefScope({ section: section ?? undefined });
        const changed = [];
        for (const bot of this.bots) {
            if (chiefScope(bot) !== scope)
                continue;
            const next = bot.id === id;
            if (Boolean(bot.chiefOfStaff) === next && !(next && bot.hidden))
                continue;
            if (next) {
                bot.chiefOfStaff = true;
                bot.hidden = false;
            }
            else {
                bot.chiefOfStaff = false;
                delete bot.managedSections;
            }
            changed.push(bot);
        }
        if (changed.length)
            this.saveBots();
        for (const bot of changed)
            this.emit({ type: "bot", botId: bot.id });
        return changed;
    }
    renameInstances(ids) {
        const touches = (record) => Boolean(record && Object.keys(record).some(key => ids.has(key)));
        const rename = (record) => {
            const next = {};
            for (const [key, value] of Object.entries(record)) {
                const target = ids.get(key);
                if (!target)
                    next[key] = value;
                else if (!Object.prototype.hasOwnProperty.call(record, target))
                    next[target] = value;
            }
            return next;
        };
        const changed = [];
        for (const bot of this.bots) {
            let dirty = false;
            const selected = ids.get(bot.modelSelection.instanceId);
            if (selected) {
                bot.modelSelection = { ...bot.modelSelection, instanceId: selected };
                dirty = true;
            }
            if (touches(bot.resumeCursors)) {
                bot.resumeCursors = rename(bot.resumeCursors);
                dirty = true;
            }
            for (const task of bot.tasks ?? []) {
                const taskSelected = task.modelSelection && ids.get(task.modelSelection.instanceId);
                if (task.modelSelection && taskSelected) {
                    task.modelSelection = { ...task.modelSelection, instanceId: taskSelected };
                    dirty = true;
                }
                if (touches(task.resumeCursors)) {
                    task.resumeCursors = rename(task.resumeCursors);
                    dirty = true;
                }
                if (task.handedMessages && touches(task.handedMessages)) {
                    task.handedMessages = rename(task.handedMessages);
                    dirty = true;
                }
                const last = task.lastInstanceId && ids.get(task.lastInstanceId);
                if (last) {
                    task.lastInstanceId = last;
                    dirty = true;
                }
            }
            if (dirty)
                changed.push(bot);
        }
        if (changed.length)
            this.saveBots();
        for (const bot of changed)
            this.emit({ type: "bot", botId: bot.id });
        return changed.length;
    }
    retireInstances(ids, replacement, options) {
        const retired = (selection) => Boolean(selection && ids.has(selection.instanceId));
        const without = (record) => Object.fromEntries(Object.entries(record).filter(([key]) => !ids.has(key)));
        const touches = (record) => Boolean(record && Object.keys(record).some(key => ids.has(key)));
        const needsAsk = (target) => modelSwitchNeedsAsk(approvalModeFor(target), REMOVED_COMPUTER_DRIVER, options.driverKind);
        const askNow = { approvalMode: "ask", autoApprove: false, alwaysAllow: [] };
        const changes = [];
        const moves = [];
        for (const bot of this.bots) {
            const patch = {};
            const tasks = (bot.tasks ?? []).map(() => ({}));
            const botMoved = retired(bot.modelSelection);
            const keepsCloud = options.canWorkOnCloud && options.keepCloud(bot);
            let botAsk = false;
            if (botMoved) {
                if (bot.computer === undefined && keepsCloud)
                    patch.computer = "cloud";
                if (needsAsk(bot)) {
                    Object.assign(patch, structuredClone(askNow));
                    botAsk = true;
                }
                patch.modelSelection = structuredClone(replacement);
            }
            if (bot.fallback?.some(retired)) {
                const kept = bot.fallback.filter(candidate => !retired(candidate));
                patch.fallback = kept.length ? kept : undefined;
            }
            if (touches(bot.resumeCursors))
                patch.resumeCursors = without(bot.resumeCursors);
            const computer = patch.computer ?? bot.computer;
            const cloudAfterMove = (pin, pinSource) => {
                const place = pin ?? bot.computer;
                const wasCloud = place === "cloud" || (place === undefined && options.keepCloud(bot));
                if (!wasCloud || options.canWorkOnCloud)
                    return { cloud: wasCloud, noComputer: false };
                const personPin = pin !== undefined && pinSource !== "auto";
                const still = personPin ? pin : bot.computer;
                return { cloud: false, noComputer: still !== "cloud" ? "auto" : personPin ? "pin" : "works-on" };
            };
            (bot.tasks ?? []).forEach((task, index) => {
                const taskPatch = tasks[index];
                // Read before anything changes: a thread that follows the bot's level has it here.
                const before = this.projectBotForTask(bot.id, task.threadId);
                if (botAsk) {
                    Object.assign(taskPatch, {
                        approvalMode: before.approvalMode, autoApprove: before.autoApprove, alwaysAllow: structuredClone(before.alwaysAllow ?? []),
                    });
                }
                const moved = task.modelSelection ? retired(task.modelSelection) : botMoved;
                if (moved) {
                    if (!botMoved && computer === undefined && task.surface === undefined && keepsCloud) {
                        taskPatch.surface = "cloud";
                        taskPatch.surfaceSource = "auto";
                    }
                    if (!options.canWorkOnCloud && task.surface === "cloud" && task.surfaceSource === "auto") {
                        taskPatch.surface = undefined;
                        taskPatch.surfaceSource = undefined;
                    }
                    const ask = needsAsk(before);
                    if (ask)
                        Object.assign(taskPatch, structuredClone(askNow));
                    if (task.modelSelection)
                        taskPatch.modelSelection = structuredClone(replacement);
                    const scope = botMoved && task.threadId === bot.threadId ? "bot" : "conversation";
                    moves.push({ botId: bot.id, threadId: task.threadId, scope, ...cloudAfterMove(task.surface, task.surfaceSource),
                        askNow: ask || (scope === "bot" && botAsk) });
                }
                else if (botMoved && task.threadId === bot.threadId) {
                    moves.push({ botId: bot.id, threadId: task.threadId, scope: "bot-only", ...cloudAfterMove(undefined, undefined), askNow: botAsk });
                }
                if (touches(task.resumeCursors))
                    taskPatch.resumeCursors = without(task.resumeCursors);
                if (task.handedMessages && touches(task.handedMessages))
                    taskPatch.handedMessages = without(task.handedMessages);
            });
            if (Object.keys(patch).length || tasks.some(taskPatch => Object.keys(taskPatch).length))
                changes.push({ bot, patch, tasks });
        }
        if (!changes.length)
            return moves;
        const next = new Map(changes.map(({ bot, patch, tasks }) => [bot, {
                ...bot, ...patch, tasks: bot.tasks?.map((task, index) => ({ ...task, ...tasks[index] })),
            }]));
        this.saveBots(this.bots.map(bot => next.get(bot) ?? bot));
        for (const { bot, patch, tasks } of changes) {
            bot.tasks?.forEach((task, index) => Object.assign(task, tasks[index]));
            Object.assign(bot, patch);
            this.emit({ type: "bot", botId: bot.id });
        }
        return moves;
    }
    setResumeCursor(botId, instanceId, cursor, threadId) {
        const bot = this.own(botId);
        if (!bot)
            return;
        const task = threadId ? this.taskByThread(botId, threadId) : this.activeTask(botId), mirrored = !threadId || bot.threadId === threadId;
        if (isDeepStrictEqual(task?.resumeCursors[instanceId], cursor) && (!mirrored || isDeepStrictEqual(bot.resumeCursors[instanceId], cursor)))
            return;
        if (task)
            task.resumeCursors[instanceId] = cursor;
        if (mirrored)
            bot.resumeCursors[instanceId] = cursor;
        saveRegistryFor("bots.json", "the conversation's engine session", () => this.saveBotsSoon());
        this.emit({ type: "bot", botId, ...(task ? { threadId: task.threadId } : {}) });
    }
    markTaskDispatched(botId, threadId, instanceId) {
        const task = this.taskByThread(botId, threadId);
        if (!task || task.lastInstanceId === instanceId)
            return;
        task.lastInstanceId = instanceId;
        saveRegistryFor("bots.json", "which engine has this conversation", () => this.saveBotsSoon());
    }
    setHandedMessages(botId, threadId, instanceId, state) {
        const task = this.taskByThread(botId, threadId);
        if (!task || JSON.stringify(task.handedMessages?.[instanceId]) === JSON.stringify(state))
            return;
        const live = Object.entries(task.handedMessages ?? {})
            .filter(([id, record]) => id !== instanceId && record.session !== undefined && record.session === task.resumeCursors[id]);
        task.handedMessages = { ...Object.fromEntries(live), [instanceId]: state };
        saveRegistryFor("bots.json", "what this conversation handed its engine", () => this.saveBotsSoon());
    }
    addTaskUsage(botId, threadId, turn) {
        const task = this.taskByThread(botId, threadId);
        if (!task)
            return null;
        const prev = { input: 0, output: 0, costUsd: null, turns: 0, ...task.usage };
        const cost = typeof turn.costUsd === "number" && Number.isFinite(turn.costUsd) ? turn.costUsd : null;
        const prevCost = typeof prev.costUsd === "number" ? prev.costUsd : null;
        // Providers occasionally report NaN or a negative on a partial turn.
        const clean = (n) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
        const cachedKnown = typeof prev.cachedInput === "number" || typeof turn.cachedInput === "number";
        const prevInput = clean(prev.input);
        const turnInput = clean(turn.input);
        const nextCachedInput = Math.min(clean(prev.cachedInput), prevInput)
            + Math.min(clean(turn.cachedInput), turnInput);
        const contextTokens = clean(turn.context?.tokens);
        const contextWindow = clean(turn.context?.window);
        task.usage = {
            input: prevInput + turnInput,
            output: prev.output + clean(turn.output),
            ...(cachedKnown ? { cachedInput: nextCachedInput } : {}),
            costUsd: cost === null ? prevCost : (prevCost ?? 0) + cost,
            turns: prev.turns + 1,
            lastTurn: {
                input: turnInput, output: clean(turn.output),
                ...(typeof turn.cachedInput === "number" ? { cachedInput: Math.min(clean(turn.cachedInput), turnInput) } : {}),
                costUsd: cost,
            },
            ...(contextTokens > 0
                ? { context: { tokens: contextTokens, ...(contextWindow > 0 ? { window: contextWindow } : {}) } }
                : prev.context ? { context: prev.context } : {}),
        };
        saveRegistryFor("bots.json", "the thread's usage", () => this.saveBotsLater());
        this.emit({ type: "bot", botId, threadId });
        return task.usage;
    }
    unpinTaskCwd(threadId) {
        const bot = this.botByThread(threadId);
        const task = bot ? this.taskByThread(bot.id, threadId) : undefined;
        if (!bot || !task || task.cwd === undefined)
            return false;
        this.commitBotChange(bot, "the thread's folder", () => { delete task.cwd; });
        this.emit({ type: "bot", botId: bot.id });
        return true;
    }
    pinTaskCwd(botId, threadId, fallbackCwd, opts = {}) {
        const bot = this.own(botId);
        const task = bot ? this.taskByThread(botId, threadId) : undefined;
        if (!bot || !task)
            return null;
        if (opts.privateOnly && task.cwd === undefined) {
            const cwd = fallbackCwd ?? null;
            this.commitBotChange(bot, "the thread's folder", () => { task.cwd = cwd; });
            this.emit({ type: "bot", botId, threadId });
            return cwd;
        }
        if (opts.none) {
            if (task.cwd !== null) {
                this.commitBotChange(bot, "the thread's folder", () => { task.cwd = null; });
                this.emit({ type: "bot", botId, threadId });
            }
            return null;
        }
        if (task.cwd !== undefined)
            return task.cwd;
        const cwd = Object.keys(task.resumeCursors).length === 0 ? (bot.cwd ?? fallbackCwd ?? null) : null;
        this.commitBotChange(bot, "the thread's folder", () => { task.cwd = cwd; });
        this.emit({ type: "bot", botId, threadId });
        return cwd;
    }
    /** Pinned, not read live: engines key their sessions and files to the folder a thread starts in. */
    pinGroupCwd(groupId, threadId) {
        const group = this.group(groupId);
        if (!group)
            return null;
        const task = threadId ? this.groupTaskByThread(groupId, threadId) : this.activeGroupTask(groupId);
        if (!task) {
            if (!group.dm)
                return null;
            if (group.pinnedCwd !== undefined)
                return group.pinnedCwd;
            const cwd = group.cwd ?? null;
            this.commitGroupChange(group, "the chat's folder", () => { group.pinnedCwd = cwd; });
            this.emit({ type: "group", groupId: group.id });
            return cwd;
        }
        if (task.pinnedCwd !== undefined)
            return task.pinnedCwd;
        const cwd = group.cwd ?? null;
        this.commitGroupChange(group, "the thread's folder", () => {
            task.pinnedCwd = cwd;
            if (group.threadId === task.threadId)
                group.pinnedCwd = cwd;
        });
        this.emit({ type: "group", groupId: group.id });
        return cwd;
    }
    project(botId, projectId) {
        return this.own(botId)?.projects?.find((project) => project.id === projectId);
    }
    createProject(botId, name, emoji) {
        const bot = this.own(botId);
        if (!bot || !name.trim() || (emoji != null && !isProjectEmoji(emoji)))
            return null;
        const project = {
            id: newId(), name: name.trim().slice(0, 80),
            ...(emoji == null ? {} : { emoji }),
        };
        bot.projects = [...(bot.projects ?? []), project];
        this.saveBots();
        this.emit({ type: "bot", botId });
        return project;
    }
    patchProject(botId, projectId, patch) {
        const project = this.project(botId, projectId);
        if (!project || (patch.name !== undefined && !patch.name.trim()) || (patch.emoji != null && !isProjectEmoji(patch.emoji)))
            return null;
        if (patch.name !== undefined)
            project.name = patch.name.trim().slice(0, 80);
        if (patch.emoji === null)
            delete project.emoji;
        else if (patch.emoji !== undefined)
            project.emoji = patch.emoji;
        this.saveBots();
        this.emit({ type: "bot", botId });
        return project;
    }
    reorderProjects(botId, projectIds) {
        const bot = this.own(botId);
        const projects = bot?.projects ?? [];
        if (!bot || projectIds.length !== projects.length || new Set(projectIds).size !== projects.length)
            return null;
        const byId = new Map(projects.map((project) => [project.id, project]));
        if (projectIds.some((id) => !byId.has(id)))
            return null;
        bot.projects = projectIds.map((id) => byId.get(id));
        this.saveBots();
        this.emit({ type: "bot", botId });
        return bot.projects;
    }
    /** A stable partial reorder of the fleet, or with reorderGroups of the rooms (shared/bot-order.ts): the listed bots take, in the order given, the positions
     * they already share; every other bot stays put. Empty, repeated or unknown ids change nothing and give null. */
    reorderBots(botIds) {
        if (!reorderInPlace(this.bots, botIds))
            return null;
        this.saveBots();
        this.emit({ type: "bots.order" });
        return this.bots;
    }
    reorderGroups(groupIds) {
        const next = [...this.groups];
        if (!reorderInPlace(next, groupIds))
            return null; // saved before the live list changes
        this.saveGroups(next, false);
        this.groups.splice(0, this.groups.length, ...next);
        this.emit({ type: "groups.order" });
        return this.groups;
    }
    deleteProject(botId, projectId) {
        const bot = this.own(botId);
        if (!bot || !this.project(botId, projectId))
            return null;
        bot.projects = bot.projects.filter((project) => project.id !== projectId);
        for (const task of bot.tasks ?? []) {
            if (task.projectId === projectId)
                delete task.projectId;
        }
        this.saveBots();
        this.emit({ type: "bot", botId });
        return bot;
    }
    firstUserLine(threadId) {
        const first = this.messagesFor(threadId).find((m) => m.role === "user" && m.kind === "text" && m.text?.trim());
        return first?.text ? titleFromMessage(first.text) : null;
    }
    tasks(botId) {
        return this.own(botId)?.tasks ?? [];
    }
    activeTask(botId) {
        const bot = this.own(botId);
        return bot?.tasks?.find((t) => t.threadId === bot.threadId);
    }
    taskByThread(botId, threadId) {
        return this.own(botId)?.tasks?.find((t) => t.threadId === threadId);
    }
    workThread(botId, fromBotId, fromThreadId, roomLane = false, also = () => true) {
        return this.tasks(botId).find((t) => t.openedBy?.kind === "work" && t.openedBy.botId === fromBotId &&
            t.openedBy.threadId === fromThreadId && Boolean(t.openedBy.roomLane) === roomLane && t.archivedAt === undefined && also(t));
    }
    projectBotForTask(botId, threadId) {
        const bot = this.own(botId);
        const task = this.taskByThread(botId, threadId);
        if (!bot || !task)
            return null;
        return {
            ...bot,
            threadId: task.threadId,
            approvalGrant: bot.approvalGrant?.threadOnly && bot.approvalGrant.threadId !== threadId ? undefined : bot.approvalGrant,
            modelSelection: structuredClone(task.modelSelection ?? bot.modelSelection),
            resumeCursors: structuredClone(task.resumeCursors),
            ...threadApproval(task, bot),
            unread: Boolean(task.unread),
            rewound: task.rewound,
            pinnedMessageId: task.pinnedMessageId,
            activity: task.activity ?? "idle",
            busy: Boolean(task.busy),
        };
    }
    patchTask(botId, threadId, patch, options = {}) {
        const bot = this.own(botId);
        const task = this.taskByThread(botId, threadId);
        if (!bot || !task)
            return null;
        if (patch.projectId !== undefined && !this.project(botId, patch.projectId))
            return null;
        const revocation = keptRevocation(threadApproval(task, bot), threadApproval({ ...task, ...patch }, bot), patch);
        this.commitBotChange(bot, "the thread change", () => {
            for (const key of TASK_PATCH_FIELDS) {
                if (Object.prototype.hasOwnProperty.call(patch, key)) {
                    Object.assign(task, { [key]: structuredClone(patch[key]) });
                }
            }
            if (task.snoozedUntil === 0 && patch.unread === true)
                task.snoozedUntil = undefined;
            if (typeof patch.title === "string")
                task.title = patch.title.trim().slice(0, 80) || UNTITLED_THREAD;
            if (Object.prototype.hasOwnProperty.call(patch, "pinned") && task.pinned !== true)
                delete task.pinned;
            if (task.routineRunId)
                task.unread = false;
            if (bot.threadId === threadId)
                this.mirrorActiveTask(bot, task);
            bot.unread = bot.tasks.some(taskCountsAsBotUnread);
        }, revocation && (() => Object.assign(task, revocation)), touchesPermissions(patch) ? false : deferrablePatch(patch, options.turnEnd) && !(task.snoozedUntil === 0 && patch.unread === true) ? "later" : true);
        this.emit({ type: "bot", botId, threadId });
        return task;
    }
    suggestTaskLink(botId, threadId, text) {
        const url = lastChangeRequestUrl(text);
        const task = this.taskByThread(botId, threadId);
        if (!url || !task || task.linkAuto === false || (task.link && !task.linkAuto) || task.link === url)
            return null;
        return this.patchTask(botId, threadId, { link: url, linkAuto: true });
    }
    clearAutoSurfacePins(botId, destination) {
        const bot = this.own(botId);
        const stale = bot?.tasks?.filter((task) => task.surface !== undefined && task.surfaceSource === "auto" && task.surface !== destination) ?? [];
        if (!bot || !stale.length)
            return 0;
        this.commitBotChange(bot, "the threads' destinations", () => {
            for (const task of stale) {
                task.surface = undefined;
                task.surfaceSource = undefined;
            }
        });
        this.emit({ type: "bot", botId });
        return stale.length;
    }
    /** One write: never publish a new provider before its approval downgrade. */
    switchTaskModel(botId, threadId, selection, updateBotDefault, resetApprovalToAsk, taskPatch = {}) {
        const bot = this.own(botId);
        const task = this.taskByThread(botId, threadId);
        if (!bot || !task)
            return null;
        const approval = resetApprovalToAsk ? structuredClone(ASK_NOW) : {};
        const own = sameModelSelection(selection, updateBotDefault ? selection : bot.modelSelection) ? undefined : structuredClone(selection);
        const nextTask = persistedPin({ ...task, ...taskPatch, modelSelection: own, ...approval,
            ...(typeof taskPatch.title === "string" ? { title: taskPatch.title.trim().slice(0, 80) || UNTITLED_THREAD } : {}) });
        const others = updateBotDefault ? this.withDefaultModel(bot, selection) : bot.tasks;
        const nextTasks = bot.tasks.map((candidate, index) => candidate === task ? nextTask : others[index]);
        const botPatch = updateBotDefault ? { modelSelection: structuredClone(selection), ...approval } : {};
        this.saveBots(this.bots.map((candidate) => candidate === bot ? { ...bot, ...botPatch, tasks: nextTasks } : candidate));
        bot.tasks.forEach((candidate, index) => Object.assign(candidate, nextTasks[index]));
        Object.assign(bot, botPatch);
        this.emit({ type: "bot", botId });
        return task;
    }
    followBotModel(botId, threadIds, reset = () => ({})) {
        const bot = this.own(botId);
        if (!bot?.tasks)
            return [];
        const listed = new Set(threadIds);
        const patches = bot.tasks.map((task) => !listed.has(task.threadId) || task.modelSelection === undefined ? null : {
            ...reset(task.modelSelection, bot.modelSelection),
            modelSelection: undefined,
            ...(this.switchNeedsAsk(botId, task.threadId, task.modelSelection, bot.modelSelection) ? structuredClone(ASK_NOW) : {}),
        });
        const moved = bot.tasks.filter((_, index) => patches[index]).map((task) => task.threadId);
        if (!moved.length)
            return [];
        const nextTasks = bot.tasks.map((task, index) => patches[index] ? { ...task, ...patches[index] } : task);
        this.saveBots(this.bots.map((candidate) => candidate === bot ? { ...bot, tasks: nextTasks } : candidate));
        bot.tasks.forEach((task, index) => { if (patches[index])
            Object.assign(task, patches[index]); });
        const active = bot.tasks.find((task) => task.threadId === bot.threadId);
        if (active)
            this.mirrorActiveTask(bot, active);
        this.emit({ type: "bot", botId });
        return moved;
    }
    setAllThreadApprovalMode(botId, mode) {
        const bot = this.own(botId);
        if (!bot)
            return null;
        const patch = { approvalMode: mode, autoApprove: mode === "auto" }; // saved grants stay through Full access, unused there, so a later Ask keeps them
        const tasks = (bot.tasks ?? []).map(task => ({ ...task, ...patch }));
        const next = { ...bot, ...patch, approvalGrant: undefined, tasks };
        this.saveBots(this.bots.map(candidate => candidate === bot ? next : candidate));
        bot.tasks?.forEach((task, index) => Object.assign(task, tasks[index]));
        Object.assign(bot, patch, { approvalGrant: undefined });
        this.emit({ type: "bot", botId });
        return bot;
    }
    /** Rewrites the bot's own "Always allow" list and each of its threads' in one save (always-allow.ts). */
    rewriteGrants(botId, rewrite, removal = false) {
        const bot = this.own(botId);
        if (!bot || !rewriteGrantLists(bot, rewrite, () => this.saveBots(), removal))
            return false;
        this.emit({ type: "bot", botId });
        return true;
    }
    /** An uncommitted grant is ignored, so a refresh cannot copy the temporary Ask mask. */
    refreshTaskPermissions(botId, threadId) {
        const bot = this.own(botId);
        const task = this.taskByThread(botId, threadId);
        if (!bot || !task)
            return null;
        const mode = approvalModeFor({ ...bot, approvalGrant: undefined });
        const alwaysAllow = structuredClone(bot.alwaysAllow ?? []);
        const autoApprove = mode === "auto";
        const sameAllow = JSON.stringify(task.alwaysAllow ?? []) === JSON.stringify(alwaysAllow);
        if (task.approvalMode === mode && task.autoApprove === autoApprove && sameAllow)
            return task;
        return this.patchTask(botId, threadId, { approvalMode: mode, autoApprove, alwaysAllow });
    }
    mirrorActiveTask(bot, task) {
        bot.threadId = task.threadId;
        bot.resumeCursors = structuredClone(task.resumeCursors);
        bot.rewound = task.rewound;
        bot.pinnedMessageId = task.pinnedMessageId;
    }
    createTask(botId, title, activate = true, projectId, openedBy, approvalMode, modelSelection, cwd, beforeShown) {
        const bot = this.own(botId);
        if (!bot)
            return null;
        if (projectId !== undefined && !this.project(botId, projectId))
            return null;
        const task = buildTask(bot, title, projectId, openedBy, approvalMode, modelSelection, cwd);
        this.commitBotChange(bot, "the new thread", () => {
            bot.tasks = [task, ...(bot.tasks ?? [])];
            if (activate)
                this.mirrorActiveTask(bot, task);
        });
        beforeShown?.(task);
        this.emit({ type: "bot", botId });
        return task;
    }
    forkTask(botId, sourceThreadId, messageId) {
        const bot = this.own(botId);
        const source = this.taskByThread(botId, sourceThreadId);
        if (!bot || !source)
            return null;
        const sourceView = this.projectBotForTask(botId, sourceThreadId);
        const task = createBotFork(bot, source, this.activePath(sourceThreadId), messageId, { mode: approvalModeFor(sourceView), alwaysAllow: sourceView.alwaysAllow ?? [] }, (created) => this.commitBotChange(bot, "the forked thread", () => { bot.tasks = [created, ...(bot.tasks ?? [])]; }));
        if (task)
            this.emit({ type: "bot", botId });
        return task;
    }
    setTaskOpenedBy(botId, threadId, openedBy) {
        const bot = this.own(botId);
        const task = this.taskByThread(botId, threadId);
        if (!bot || !task)
            return null;
        this.commitBotChange(bot, "who opened the thread", () => { task.openedBy = structuredClone(openedBy); });
        this.emit({ type: "bot", botId });
        return task;
    }
    setTaskAskedAt(botId, threadId, at) {
        const task = this.taskByThread(botId, threadId);
        if (!task || !Number.isFinite(at) || (task.askedAt ?? -1) >= at)
            return task ?? null;
        task.askedAt = at;
        saveRegistryFor("bots.json", "when you last wrote in this thread", () => this.saveBotsSoon());
        this.emit({ type: "bot", botId, threadId });
        return task;
    }
    setTaskClosedBy(botId, threadId, closedBy) {
        const bot = this.own(botId);
        const task = this.taskByThread(botId, threadId);
        if (!bot || !task)
            return null;
        if (!closedBy && !task.closedBy)
            return task;
        this.commitBotChange(bot, "who closed the thread", () => {
            if (closedBy)
                task.closedBy = structuredClone(closedBy);
            else
                delete task.closedBy;
        });
        this.emit({ type: "bot", botId });
        return task;
    }
    switchTask(botId, threadId) {
        const bot = this.own(botId);
        const task = bot?.tasks?.find((t) => t.threadId === threadId);
        if (!bot || !task)
            return null;
        this.commitBotChange(bot, "the thread switch", () => this.mirrorActiveTask(bot, task));
        this.emit({ type: "bot", botId });
        return bot;
    }
    renameTask(botId, threadId, title) {
        return this.patchTask(botId, threadId, { title });
    }
    titleTaskFromFirstMessage(botId, text, threadId) {
        const bot = this.own(botId);
        const task = threadId ? this.taskByThread(botId, threadId) : this.activeTask(botId);
        if (!bot || !task || task.titleFromFirstMessage || (task.title !== UNTITLED_TASK && task.title !== UNTITLED_THREAD))
            return null;
        this.commitBotChange(bot, "the thread's title", () => {
            task.title = titleFromMessage(text);
            task.titleFromFirstMessage = true;
        }, undefined, true);
        this.emit({ type: "bot", botId });
        return task;
    }
    retitleTask(botId, threadId, machineTitle, title) {
        const task = this.taskByThread(botId, threadId);
        if (!task || task.title !== machineTitle)
            return null;
        return this.renameTask(botId, threadId, threadTitleFrom(title));
    }
    deleteTask(botId, threadId) {
        const result = this.deleteTasks(botId, [threadId]);
        return result?.deleted.length ? result.bot : null;
    }
    /** Transcript rows and bots.json commit together, so either failing leaves every task, log file and subscriber untouched. */
    deleteTasks(botId, threadIds) {
        const bot = this.own(botId);
        if (!bot?.tasks)
            return null;
        const present = new Set(bot.tasks.map((t) => t.threadId));
        const unique = [...new Set(threadIds)];
        const deleted = unique.filter((id) => present.has(id));
        const missing = unique.filter((id) => !present.has(id));
        if (!deleted.length)
            return { bot, deleted, missing };
        const doomed = new Set(deleted);
        this.threadsGoing(deleted);
        mdb.deleteThreads(deleted, () => this.commitBotChange(bot, "the thread deletion", () => {
            const kept = bot.tasks.filter((t) => !doomed.has(t.threadId));
            const visible = nextOpenThread(kept) ?? buildTask(bot);
            bot.tasks = kept.includes(visible) ? kept : [visible, ...kept];
            if (doomed.has(bot.threadId) || this.taskByThread(botId, bot.threadId)?.routineRunId)
                this.mirrorActiveTask(bot, visible);
            bot.unread = bot.tasks.some(taskCountsAsBotUnread);
            this.refreshBotActivity(bot);
        }));
        for (const id of deleted)
            this.deleteThreadRecord(id, true);
        this.emit({ type: "bot", botId });
        return { bot, deleted, missing };
    }
    needsSeed() { return this.bots.length === 0; }
    /** A new place's first bot is its MausBot and its Chief; a Team Cloud's (`defaultBot: false`) is the team's Chief only. */
    seedIfEmpty({ defaultBot = true, intro } = {}) {
        if (!this.needsSeed())
            return;
        if (defaultBot)
            createDefaultBot(this, { chief: (id) => this.setChiefOfStaff(id), ...(intro ? { intro } : {}) });
        else
            this.setChiefOfStaff(this.createBot({ visibility: "everyone" }).id);
    }
}
