// Files on a Cloud home: what the /api/sync routes do. The desktop drives every pass; this side lists, takes whole files
// in resumable parts, serves them back, and keeps what it replaces or removes in the trash. A folder shared from the
// person's computer is a read-only copy for bots; a bot's own folder goes the other way. A bot's turn ending says its
// folder changed (`noteBotTurn`), so nothing watches the disk.
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statfsSync, writeSync, existsSync } from "node:fs";
import { dirname, join, posix, sep, win32 } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { clashPath, cloudReserveBytes, validWirePath } from "../electron/cloud-sync-rules.mjs";
import { SyncPathError, insideFolder } from "./cloud-sync-paths.js";
import { CloudSyncStore, sha256File, walk } from "./cloud-sync-store.js";
const PART_MAX = 64 * 1024 ** 2;
const UPLOAD_STALE_MS = 24 * 60 * 60_000;
const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANGE_LOG = 1_000;
export class SyncError extends Error {
    status;
    body;
    constructor(status, body) {
        super(String(body.error ?? status));
        this.status = status;
        this.body = body;
    }
}
const text = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0");
export function createCloudSync(options) {
    const store = new CloudSyncStore(options);
    const now = options.now ?? Date.now;
    const statfs = options.statfs ?? ((path) => { const stats = statfsSync(path); return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize }; });
    const uploadsDir = join(store.syncDir(), "uploads");
    let cursor = now();
    const changes = [];
    const waiters = new Set();
    const mutations = new Map();
    const mutate = (folderId, path, work) => {
        let pending = mutations.get(folderId);
        if (!pending)
            mutations.set(folderId, pending = new Map());
        const queue = pending;
        const previous = path === null ? [...queue.values()] : [queue.get(null), queue.get(path)];
        const run = Promise.all(previous).then(work);
        const settled = run.catch(() => undefined);
        queue.set(path, settled);
        void settled.then(() => {
            if (queue.get(path) === settled)
                queue.delete(path);
            if (!queue.size)
                mutations.delete(folderId);
        });
        return run;
    };
    const folderOf = (id) => {
        const folder = store.folder(id);
        if (!folder)
            throw new SyncError(404, { error: "no such synced folder" });
        // A link in its place is as good as missing: following it would sync, or trash, whatever it points at.
        if (!lstatSync(folder.cloudPath, { throwIfNoEntry: false })?.isDirectory())
            throw new SyncError(410, { error: "this folder is missing on My Cloud" });
        return folder;
    };
    const unreadable = (error) => {
        if (error instanceof SyncError)
            throw error;
        throw new SyncError(503, { error: "Part of this folder can't be read on My Cloud right now.", code: error?.code ?? null });
    };
    const fileOf = (folder, path) => {
        try {
            return insideFolder(folder.cloudPath, path);
        }
        catch (error) {
            if (error instanceof SyncPathError)
                throw new SyncError(400, { error: error.message });
            throw error;
        }
    };
    const noteChange = (folderId) => {
        changes.push({ seq: ++cursor, folderId });
        if (changes.length > CHANGE_LOG)
            changes.shift();
        for (const wake of waiters)
            wake();
    };
    const disk = () => {
        const { totalBytes, freeBytes } = statfs(store.root);
        const { pc, bot } = store.bytesByKind();
        return { totalBytes, freeBytes, syncedBytes: pc, botFileBytes: bot, trashBytes: store.trashBytes(), reserveBytes: cloudReserveBytes(totalBytes) };
    };
    const uploadFile = (id, ext) => join(uploadsDir, `${id}.${ext}`);
    const readUpload = (id) => {
        if (!UUID.test(id))
            throw new SyncError(404, { error: "no such upload" });
        try {
            return JSON.parse(readFileSync(uploadFile(id, "json"), "utf8"));
        }
        catch {
            throw new SyncError(404, { error: "no such upload" });
        }
    };
    const pendingUploads = new Map();
    const mutateUpload = (id, work) => {
        const run = (pendingUploads.get(id) ?? Promise.resolve()).then(() => work(readUpload(id)));
        const settled = run.catch(() => undefined);
        pendingUploads.set(id, settled);
        void settled.then(() => { if (pendingUploads.get(id) === settled)
            pendingUploads.delete(id); });
        return run;
    };
    const saveUpload = (upload) => writeFileAtomic(uploadFile(upload.id, "json"), JSON.stringify(upload), { mode: 0o600 });
    const dropUpload = (id) => { rmSync(uploadFile(id, "json"), { force: true }); rmSync(uploadFile(id, "part"), { force: true }); };
    const uploads = () => {
        const found = [];
        for (const name of readdirSync(uploadsDir)) {
            if (!name.endsWith(".json"))
                continue;
            try {
                found.push(readUpload(name.slice(0, -5)));
            }
            catch {
                rmSync(join(uploadsDir, name), { force: true });
            }
        }
        return found;
    };
    const removeEmptyParents = (folder, file) => {
        for (let dir = dirname(file); dir.startsWith(folder.cloudPath + sep); dir = dirname(dir)) {
            try {
                rmdirSync(dir);
            }
            catch {
                return;
            }
        }
    };
    return {
        store,
        noteChange,
        summary() {
            store.sweepTrash();
            for (const upload of uploads())
                if (!pendingUploads.has(upload.id) && upload.updatedAt + UPLOAD_STALE_MS < now())
                    dropUpload(upload.id);
            return { folders: store.folders(), cursor, disk: disk() };
        },
        register(body) {
            const input = (body ?? {});
            if (!UUID.test(String(input.computerId)) || !text(input.computerName, 200) || !text(input.pcPath, 4096) || !text(input.name, 200) || (input.lent !== undefined && typeof input.lent !== "boolean")) {
                throw new SyncError(400, { error: "invalid folder" });
            }
            if (!posix.isAbsolute(input.pcPath) && !win32.isAbsolute(input.pcPath))
                throw new SyncError(400, { error: "the folder on the computer must be an absolute path" });
            const folder = store.register({ computerId: String(input.computerId), computerName: input.computerName, pcPath: input.pcPath, name: input.name, lent: input.lent === true });
            noteChange(folder.id);
            return folder;
        },
        async unregister(id, keepCloudCopy) {
            return mutate(id, null, () => {
                const folder = store.unregister(id);
                if (!folder)
                    throw new SyncError(404, { error: "no such synced folder" });
                // Never through a link; synced files go to the trash, and what sync never carried (.git, node_modules) stays.
                if (!keepCloudCopy && lstatSync(folder.cloudPath, { throwIfNoEntry: false })?.isDirectory()) {
                    let files;
                    try {
                        files = Array.from(walk(folder.cloudPath));
                    }
                    catch (error) {
                        unreadable(error);
                    }
                    for (const entry of files)
                        store.toTrash(folder, entry.path, join(folder.cloudPath, ...entry.path.split("/")));
                    pruneEmptyDirectories(folder.cloudPath);
                }
                noteChange(id);
            });
        },
        async files(id) {
            const folder = folderOf(id);
            try {
                return await store.list(folder);
            }
            catch (error) {
                return unreadable(error);
            }
        },
        beginUpload(id, body) {
            const folder = folderOf(id);
            const input = (body ?? {});
            const base = input.baseSha256;
            if (!validWirePath(input.path) || !Number.isSafeInteger(input.size) || input.size < 0 || typeof input.sha256 !== "string" || !SHA.test(input.sha256)
                || !(base === null || (typeof base === "string" && SHA.test(base))))
                throw new SyncError(400, { error: "invalid upload" });
            fileOf(folder, input.path);
            const size = input.size;
            const open = uploads().find((upload) => upload.folderId === folder.id && upload.path === input.path && upload.sha256 === input.sha256 && upload.size === size);
            if (open)
                return { uploadId: open.id, received: open.received };
            // Uploads still open will land too: count what they have left to send against the reserve.
            const pending = uploads().reduce((sum, upload) => sum + Math.max(0, upload.size - upload.received), 0);
            const { totalBytes, freeBytes } = statfs(store.root), reserve = cloudReserveBytes(totalBytes);
            if (freeBytes - pending - size < reserve)
                throw new SyncError(507, { error: "My Cloud is full", neededBytes: size + pending + reserve, freeBytes });
            const upload = { id: randomUUID(), folderId: folder.id, path: input.path, size, sha256: input.sha256, baseSha256: base, received: 0, updatedAt: now() };
            closeSync(openSync(uploadFile(upload.id, "part"), "w", 0o600));
            saveUpload(upload);
            return { uploadId: upload.id, received: 0 };
        },
        async writePart(uploadId, offset, body) {
            return mutateUpload(uploadId, async (upload) => {
                if (offset !== upload.received)
                    throw new SyncError(409, { error: "wrong offset", received: upload.received });
                const fd = openSync(uploadFile(uploadId, "part"), "r+");
                let written = 0;
                try {
                    for await (const chunk of body) {
                        if (written + chunk.length > PART_MAX || upload.received + written + chunk.length > upload.size)
                            throw new SyncError(413, { error: "part too large" });
                        let offset = 0;
                        while (offset < chunk.length) {
                            const count = writeSync(fd, chunk, offset, chunk.length - offset, upload.received + written);
                            if (count === 0)
                                throw new Error("The upload could not be written to My Cloud.");
                            offset += count;
                            written += count;
                        }
                    }
                }
                finally {
                    closeSync(fd);
                }
                upload.received += written;
                upload.updatedAt = now();
                saveUpload(upload);
                return { received: upload.received };
            });
        },
        async commit(uploadId) {
            return mutateUpload(uploadId, async (upload) => {
                if (upload.received !== upload.size)
                    throw new SyncError(409, { error: "upload incomplete", received: upload.received });
                const part = uploadFile(uploadId, "part");
                if (await sha256File(part) !== upload.sha256) {
                    dropUpload(uploadId);
                    throw new SyncError(422, { error: "the file's bytes do not match its hash" });
                }
                return mutate(upload.folderId, upload.path, async () => {
                    const folder = folderOf(upload.folderId);
                    const target = fileOf(folder, upload.path);
                    const current = await store.current(folder, upload.path);
                    if ((current?.sha256 ?? null) !== upload.baseSha256) {
                        dropUpload(uploadId);
                        throw new SyncError(409, { error: "changed on My Cloud", current });
                    }
                    if (current)
                        store.toTrash(folder, upload.path, target);
                    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
                    renameSync(part, target);
                    // A copy from the person's computer: bots read it, and save their own work in their own folder.
                    if (folder.kind === "pc")
                        chmodSync(target, 0o444);
                    dropUpload(uploadId);
                    const stat = lstatSync(target);
                    store.remember(folder, { path: upload.path, size: stat.size, mtimeMs: stat.mtimeMs, sha256: upload.sha256 });
                    noteChange(folder.id);
                    return { sha256: upload.sha256 };
                });
            });
        },
        async download(id, path) {
            const folder = folderOf(id);
            const file = fileOf(folder, path);
            const current = await store.current(folder, path);
            if (!current)
                throw new SyncError(404, { error: "no such file" });
            return { file, size: current.size, sha256: current.sha256 };
        },
        async ops(id, body) {
            const folder = folderOf(id);
            const list = body?.ops;
            if (!Array.isArray(list) || list.length > 1_000)
                throw new SyncError(400, { error: "invalid ops" });
            const results = [];
            for (const op of list) {
                if (op?.op === "delete" && typeof op.baseSha256 === "string") {
                    fileOf(folder, op.path);
                    await mutate(id, op.path, async () => {
                        const folder = folderOf(id);
                        const file = fileOf(folder, op.path);
                        const current = await store.current(folder, op.path);
                        if (!current) {
                            results.push({ ok: true });
                            return;
                        }
                        if (current.sha256 !== op.baseSha256) {
                            results.push({ conflict: true, current });
                            return;
                        }
                        store.toTrash(folder, op.path, file);
                        removeEmptyParents(folder, file);
                        results.push({ ok: true });
                    });
                }
                else {
                    throw new SyncError(400, { error: "invalid op" });
                }
            }
            noteChange(folder.id);
            return { results };
        },
        async restore(entryId) {
            const found = typeof entryId === "string" ? store.trashEntry(entryId) : null;
            if (!found)
                throw new SyncError(404, { error: "no such deleted file" });
            // Its folder may no longer sync (turned off) or list (a bot folder emptied): put it back where it came from.
            const home = found.cloudPath && [store.root, store.lentRoot(), join(options.dataDir, "task-workspaces")].some((root) => found.cloudPath.startsWith(root + sep)) ? found.cloudPath : null;
            return mutate(found.entry.folderId, found.entry.path, () => {
                if (!store.trashEntry(found.entry.id))
                    throw new SyncError(404, { error: "no such deleted file" });
                const known = store.folder(found.entry.folderId);
                if (!known && !home)
                    throw new SyncError(404, { error: "the folder this file came from is gone" });
                if (!known)
                    mkdirSync(home, { recursive: true, mode: 0o700 });
                const folder = known ?? { id: found.entry.folderId, kind: found.entry.folderId.startsWith("bot-") ? "bot" : "pc", cloudPath: home };
                if (!lstatSync(folder.cloudPath, { throwIfNoEntry: false })?.isDirectory())
                    throw new SyncError(410, { error: "this folder is missing on My Cloud" });
                let path = found.entry.path;
                if (existsSync(fileOf(folder, path)))
                    path = clashPath(path, now(), (candidate) => mutations.get(folder.id)?.has(candidate) || existsSync(fileOf(folder, candidate)), "restored");
                const target = fileOf(folder, path);
                mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
                renameSync(found.file, target);
                store.dropTrash(found.entry.id);
                noteChange(folder.id);
                return { folderId: folder.id, path };
            });
        },
        trash() {
            return { entries: store.trash() };
        },
        /** A bot's turn ended: its folder may hold new work for the desktop. */
        noteBotTurn(botId, threadId) { noteChange(`bot-${botId}-${threadId}`); },
        async changes(since, waitMs, signal) {
            const pick = () => {
                const issued = since === cursor || changes.some((change) => change.seq === since) || (changes.length > 0 && since === changes[0].seq - 1);
                if (!issued)
                    return { cursor, folderIds: store.folders().map((folder) => folder.id) };
                return { cursor, folderIds: [...new Set(changes.filter((change) => change.seq > since).map((change) => change.folderId))] };
            };
            const ready = pick();
            if (ready.folderIds.length || signal.aborted)
                return ready;
            await new Promise((resolve) => {
                const done = () => { clearTimeout(timer); waiters.delete(done); signal.removeEventListener("abort", done); resolve(); };
                const timer = setTimeout(done, Math.min(Math.max(waitMs, 0), 60_000));
                waiters.add(done);
                signal.addEventListener("abort", done, { once: true });
            });
            return pick();
        },
        close() {
            for (const wake of waiters)
                wake();
            store.close();
        },
    };
}
/** Removes directories left empty under (and including) `dir`, bottom up, never through a link. */
function pruneEmptyDirectories(dir) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries)
        if (entry.isDirectory())
            pruneEmptyDirectories(join(dir, entry.name));
    try {
        rmdirSync(dir);
    }
    catch { }
}
