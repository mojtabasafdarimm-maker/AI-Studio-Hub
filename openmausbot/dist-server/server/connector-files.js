// A connected-app tool that takes a file (GOOGLEDRIVE_UPLOAD_FILE's file_to_upload, a Gmail attachment) reads it from
// Composio's file storage by `s3key`: Composio runs the tool on its own servers and never sees this computer's disk. A
// bot that names a file in its working folder (C:\Users\…\report.pdf) gets the file uploaded here first, and the call
// carries the `{ name, mimetype, s3key }` Composio asks for. Without this, every such call failed at Composio with a
// storage error the bot could not act on. Files are read before the call's checks and approval card (which lists them),
// and uploaded only after its last check, right before it goes out.
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { connectorCallsIn } from "../shared/outbound.js";
import { FILE_MAX_BYTES, limitMegabytes } from "../shared/upload-limits.js";
import { guestWorkspaceToHost } from "./bot-attachment.js";
import { requestFileUpload } from "./composio-files.js";
import { withFailedCallHint } from "./connector-scope-hint.js";
import { serviceSlugFor, serviceSlugForCandidates } from "./connector-verdict.js";
import { openMessageFile } from "./message-file.js";
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** Fields Composio's tools take a file in, besides any `{ s3key }` object. */
const FILE_FIELDS = new Set(["file_to_upload", "file", "files", "file_upload", "upload", "attachment", "attachments", "document", "image", "media"]);
/** Where a `{ … }` file object may carry a path instead of a staged key. */
const PATH_KEYS = ["s3key", "path", "file_path", "local_path", "filepath"];
/** An absolute path on this computer, in any spelling a bot writes one: C:\…, C:/…, \\server\share, /…, ~/…, file://… */
const LOCAL_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\]|\/(?!\/)|~[\\/]|file:\/\/)/;
const MIME = /^[A-Za-z0-9][\w.+-]*\/[\w.+-]+$/;
const MAX_FILES_PER_REQUEST = 10;
const MAX_DEPTH = 6;
function localPath(value) {
    return typeof value === "string" && !/[\r\n]/.test(value) && LOCAL_PATH.test(value.trim());
}
function referenceIn(owner, key, field, call, value, found) {
    const set = (staged) => { owner[key] = staged; };
    const base = { tool: call.slug, field, source: call.source, replace: set };
    if (FILE_FIELDS.has(field.toLowerCase()) && localPath(value)) {
        found.push({ ...base, path: value.trim() });
        return true;
    }
    if (!isRecord(value))
        return false;
    const pathKey = PATH_KEYS.find((candidate) => localPath(value[candidate]));
    // Only a file object: `{ s3key }` anywhere, or a path inside a field that takes a file.
    if (!pathKey || (pathKey !== "s3key" && !FILE_FIELDS.has(field.toLowerCase())))
        return false;
    const name = typeof value.name === "string" && value.name.trim() ? basename(value.name.trim().replace(/\\/g, "/")) : undefined;
    const given = typeof value.mimetype === "string" ? value.mimetype : typeof value.mime_type === "string" ? value.mime_type : undefined;
    found.push({ ...base, path: value[pathKey].trim(), ...(name ? { name } : {}), ...(given && MIME.test(given.trim()) ? { mimetype: given.trim() } : {}) });
    return true;
}
function collect(node, field, call, found, depth) {
    if (depth > MAX_DEPTH)
        return;
    if (Array.isArray(node)) {
        node.forEach((item, index) => {
            if (!referenceIn(node, index, field, call, item, found))
                collect(item, field, call, found, depth + 1);
        });
        return;
    }
    if (!isRecord(node))
        return;
    for (const [key, value] of Object.entries(node)) {
        if (!referenceIn(node, key, key, call, value, found))
            collect(value, key, call, found, depth + 1);
    }
}
/** The values a tools/call frame gives where a connected-app tool takes a file and that read as a path on this
 * computer, in a copy of the frame whose values can be replaced. Search, schema and connection tools carry none. */
export function localFileReferences(frame) {
    if (!isRecord(frame) || frame.method !== "tools/call" || !isRecord(frame.params) || typeof frame.params.name !== "string")
        return { frame, references: [] };
    const copy = structuredClone(frame);
    const sent = connectorCallsIn(frame.params.name, frame.params.arguments);
    const references = [];
    connectorCallsIn(copy.params.name, copy.params.arguments).forEach((call, index) => {
        if (call.slug === "COMPOSIO_PROXY_EXECUTE" || call.arguments === undefined)
            return;
        collect(call.arguments, "", { slug: call.slug, source: sent[index]?.arguments }, references, 0);
    });
    return { frame: copy, references };
}
const SENSITIVE = "it is in a hidden folder or in the app's own data, which is never sent to an app";
const within = (root, path) => {
    const rel = relative(root, path);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};
const hiddenBelow = (root, path) => relative(root, path).split(/[\\/]/).some((part) => part.startsWith("."));
const real = (path) => realpath(path).catch(() => null);
/** The bot's file at `path`, read through the chat file-link resolver (realpath containment, no-follow, secret folders,
 * 100 MB), or null when nothing the bot may send is there. A Local VM path is read from the VM's host folder. */
export async function openBotFile(path, scope) {
    const target = (scope.guest ? guestWorkspaceToHost(path, scope.guest.root, scope.guest.host) : null) ?? path;
    const canonical = await real(target);
    const attachments = (await Promise.all(scope.attachments.map(real))).filter((one) => one !== null);
    const attached = canonical !== null && attachments.includes(canonical);
    const roots = attached ? [dirname(canonical)] : scope.guest ? [scope.guest.host, ...scope.roots] : scope.roots;
    let file;
    try {
        file = await openMessageFile(target, roots, FILE_MAX_BYTES);
    }
    catch (error) {
        const { status, code } = (error ?? {});
        if (code === "outside_workspace" || code === "directory" || status === 404)
            return null;
        if (code === "file_too_large")
            throw new Error(`it is larger than ${limitMegabytes(FILE_MAX_BYTES)} MB`);
        throw error;
    }
    try {
        const realRoots = (await Promise.all(roots.map(real))).filter((one) => one !== null);
        const root = realRoots.filter((one) => within(one, file.path)).sort((a, b) => b.length - a.length)[0] ?? dirname(file.path);
        const appData = (await Promise.all(scope.refuse.map(real))).filter((one) => one !== null);
        // A bot's own workspace sits inside the app's data folder: only a folder strictly inside it may send from there.
        const ownAppFolder = appData.some((data) => within(data, root));
        const home = await real(scope.home ?? homedir());
        if (hiddenBelow(root, file.path)
            || (!ownAppFolder && appData.some((data) => data === file.path || within(data, file.path)))
            || (!ownAppFolder && home !== null && within(home, file.path) && hiddenBelow(home, file.path))) {
            throw new Error(SENSITIVE);
        }
        return { name: file.name, mime: file.mime, bytes: await file.handle.readFile() };
    }
    finally {
        await file.handle.close().catch(() => undefined);
    }
}
/** The scope of one turn: the bot's folders without the attachment store (which holds every conversation's and every
 * team member's files), this conversation's own attachments by path, and the app's own data folders. */
export function connectorFileScope(input) {
    return {
        roots: input.roots.filter((root) => root !== input.attachmentStore),
        attachments: input.messages.flatMap((message) => (message.attachments ?? []).map((file) => file.path)),
        refuse: input.appData.filter((dir) => Boolean(dir)),
        ...(input.vm ? { guest: { root: input.guestRoot, host: input.vm.workspaceDir } } : {}),
    };
}
/** The relay's staging for one call: the bot's files, uploaded through the same connection the call goes out on. */
export function connectorFileDeps(options) {
    const toolkit = (tool) => serviceSlugForCandidates(tool, options.serviceSlugs) ?? serviceSlugFor(tool);
    return {
        open: (path) => openBotFile(path, options.scope),
        requestUpload: (request) => requestFileUpload(options.via[0], request, options.via[1]),
        toolkitFor: (tool) => toolkit(tool) ?? tool.toLowerCase(),
        appFor: (tool) => options.appFor(tool) ?? toolkit(tool) ?? "the app",
    };
}
/** A path as the file system reads it: ~/ is the home folder, file:// a file URL. */
function onDisk(path) {
    if (/^~[\\/]/.test(path))
        return join(homedir(), path.slice(2));
    if (/^file:\/\//i.test(path)) {
        try {
            return fileURLToPath(path);
        }
        catch {
            return path;
        }
    }
    return path;
}
async function putBytes(url, bytes, mimetype) {
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    // The link is Composio's own storage: a redirect elsewhere is refused, never followed with the file.
    const response = await fetch(url, { method: "PUT", body, redirect: "error", headers: { "content-type": mimetype }, signal: AbortSignal.timeout(5 * 60_000) });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok)
        throw new Error(`the upload was refused (HTTP ${response.status})`);
}
const reasonOf = (error) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 240);
/** What the bot is told when a file it named may not be sent. */
export function unreadableFileText(reference, app, reason) {
    return `OpenMausBot did not run ${reference.tool}: it could not send ${reference.path} to ${app} (${reason}). `
        + `Nothing was written to ${app}. Give ${reference.field || "the file field"} the full path of a file in your working folder or one `
        + "attached to this conversation, and OpenMausBot uploads it for the call. For plain text, a tool that takes the text itself, "
        + "such as GOOGLEDRIVE_CREATE_FILE_FROM_TEXT, needs no file.";
}
/** What the bot is told when the file was read but Composio did not take it. */
export function uploadFailedText(reference, name, app, reason) {
    return `OpenMausBot did not run ${reference.tool}: uploading ${name} for ${app} failed (${reason}). Nothing was written to ${app}. `
        + "This is usually brief: try the call once more. If it fails again, tell the person the upload to "
        + `${app} failed and why, and do not keep retrying.`;
}
/**
 * Reads, here and before anything goes out, each file of the bot's that `frame` names where a connected-app tool takes a
 * file. A value that is not one of the bot's files is left as it is (a Drive folder path such as /Apps/report.pdf, text
 * that starts with /). Answers the refusal the bot is told when a file it named may not be sent.
 */
export async function prepareConnectorFiles(frame, deps) {
    const found = localFileReferences(frame);
    const ready = [];
    for (const reference of found.references) {
        let file;
        try {
            file = await deps.open(onDisk(reference.path));
        }
        catch (error) {
            return { refusal: unreadableFileText(reference, deps.appFor(reference.tool), reasonOf(error)) };
        }
        if (!file)
            continue;
        if (ready.length === MAX_FILES_PER_REQUEST) {
            return { refusal: `OpenMausBot did not run this call: it names more than ${MAX_FILES_PER_REQUEST} files, and one call can upload at most ${MAX_FILES_PER_REQUEST}. Send them in smaller batches.` };
        }
        ready.push({ reference, file, name: reference.name ?? file.name, mimetype: reference.mimetype ?? file.mime.split(";")[0].trim() });
    }
    const files = ready.map(({ reference, file, name }) => ({ tool: reference.tool, source: reference.source, name, path: reference.path, bytes: file.bytes.byteLength }));
    const cardCalls = (calls) => calls.map((call) => {
        const mine = files.filter((one) => one.source !== undefined && one.source === call.arguments).map(({ name, path, bytes }) => ({ name, path, bytes }));
        return mine.length ? { ...call, files: mine } : call;
    });
    if (!ready.length)
        return { files, cardCalls };
    const put = deps.put ?? putBytes;
    const upload = async () => {
        for (const { reference, file, name, mimetype } of ready) {
            const app = deps.appFor(reference.tool);
            try {
                const md5 = createHash("md5").update(file.bytes).digest("hex");
                const link = await deps.requestUpload({ toolkit_slug: deps.toolkitFor(reference.tool), tool_slug: reference.tool, filename: name, mimetype, md5 });
                await put(link.url, file.bytes, mimetype);
                reference.replace({ name, mimetype, s3key: link.key });
            }
            catch (error) {
                throw new Error(uploadFailedText(reference, name, app, reasonOf(error)));
            }
        }
        return found.frame;
    };
    return { files, upload, cardCalls };
}
/** prepareConnectorFiles and its upload at once: the frame to send, or the refusal. */
export async function stageConnectorFiles(frame, deps) {
    const prepared = await prepareConnectorFiles(frame, deps);
    if ("refusal" in prepared)
        return prepared;
    if (!prepared.upload)
        return { frame };
    try {
        return { frame: await prepared.upload() };
    }
    catch (error) {
        return { refusal: error instanceof Error ? error.message : String(error) };
    }
}
/** Composio could not find the file a call named: a made-up key, a stale one, or a path it cannot reach. */
const MISSING_STAGED_FILE = /Failed to download file|storage returned HTTP 404|invalid s3key|s3key (?:was )?not found/i;
export function missingFileHint() {
    return "OpenMausBot note: Composio could not get the file this call named. Composio runs the tool on its own servers, so it "
        + "never reads this computer's disk and an s3key cannot be made up. Give the file field the full path of a file in your "
        + 'working folder or attached to this conversation, for example {"file_to_upload": "C:\\\\Users\\\\you\\\\report.pdf"} '
        + "or a path starting with /, and OpenMausBot uploads it for the call. For plain text, use a tool that takes the text itself, "
        + "such as GOOGLEDRIVE_CREATE_FILE_FROM_TEXT.";
}
/** Adds missingFileHint to a failed result whose error is Composio not finding the call's file. */
export function withMissingFileHint(bytes, contentType, slugs) {
    return withFailedCallHint(bytes, contentType, MISSING_STAGED_FILE, missingFileHint, slugs);
}
