import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { ATTACHMENTS_DIR, FILE_MAX_BYTES, IMAGE_MAX_BYTES } from "./attachments.js";
import { decodeAttachmentAttribute } from "./message-file.js";
import { videoFrameImages } from "./turn-video.js";
export const TURN_IMAGE_MAX_COUNT = 10;
/** Total image bytes one turn may carry: the 40 MB it was when a turn took four images, so engine requests don't grow. */
export const TURN_IMAGE_MAX_BYTES = 4 * IMAGE_MAX_BYTES;
// A video is sampled into several frames before it reaches a model, so only the first one in a message is sampled.
export const TURN_VIDEO_MAX_COUNT = 1;
const OWNED_IMAGE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;
const OWNED_VIDEO_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(mp4|webm|mov)$/;
// Composer video attachments use the generic <attached-file> tag (the same one documents and audio use); only its
// path decides whether it resolves to a video, so every other file kind keeps going through unexamined.
const ATTACHMENT_TAG = /^<attached-(image|file)[\t ]+path="([^"\r\n]*)"(?:[\t ]+name="([^"\r\n]*)")?[\t ]*\/>$/;
const MIME_BY_EXTENSION = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
};
const VIDEO_MIME_BY_EXTENSION = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
};
function statusError(status, message) {
    return Object.assign(new Error(message), { status });
}
function walk(node, visit) {
    const pending = [node];
    while (pending.length > 0) {
        const current = pending.pop();
        visit(current);
        const children = current.children ?? [];
        for (let index = children.length - 1; index >= 0; index -= 1)
            pending.push(children[index]);
    }
}
/** Standalone tags only: prose that contains a tag literal must not become an attachment capability. */
function attachmentTagCandidates(text) {
    const candidates = [];
    walk(fromMarkdown(text), (node) => {
        if (node.type !== "html" || !node.value || !node.position)
            return;
        const start = node.position.start.offset;
        const end = node.position.end.offset;
        if (start === undefined || end === undefined)
            return;
        const lineStart = text.lastIndexOf("\n", start - 1) + 1;
        const nextLine = text.indexOf("\n", end);
        const lineEnd = nextLine < 0 ? text.length : nextLine;
        if (text.slice(lineStart, start).trim() || text.slice(end, lineEnd).trim())
            return;
        const match = ATTACHMENT_TAG.exec(node.value);
        if (!match)
            return;
        candidates.push({ start, end, kind: match[1] === "file" ? "file" : "image", path: decodeAttachmentAttribute(match[2]) });
    });
    return candidates;
}
function ownedAttachment(path, attachmentsDir, nameFormat, mimeByExtension, maxBytes) {
    if (!path || path.includes("\0"))
        return null;
    const name = path.split(/[\\/]/).at(-1) ?? "";
    if (!nameFormat.test(name))
        return null;
    // A basename match alone would let any /tmp/<uuid>.ext pose as an app attachment: the path must point into this store.
    const expected = resolve(attachmentsDir, name);
    if (resolve(path) !== expected)
        return null;
    try {
        const entry = lstatSync(expected);
        if (!entry.isFile() || entry.isSymbolicLink() || entry.size <= 0 || entry.size > maxBytes)
            return null;
        const canonicalRoot = realpathSync(attachmentsDir);
        const canonicalFile = realpathSync(expected);
        if (dirname(canonicalFile) !== canonicalRoot)
            return null;
        const finalEntry = statSync(canonicalFile);
        if (!finalEntry.isFile() || finalEntry.size !== entry.size)
            return null;
        const mime = mimeByExtension[extname(name)];
        return mime ? { path: expected, mime, bytes: entry.size } : null;
    }
    catch {
        return null;
    }
}
const ownedImage = (path, attachmentsDir) => ownedAttachment(path, attachmentsDir, OWNED_IMAGE_NAME, MIME_BY_EXTENSION, IMAGE_MAX_BYTES);
const ownedVideo = (path, attachmentsDir) => ownedAttachment(path, attachmentsDir, OWNED_VIDEO_NAME, VIDEO_MIME_BY_EXTENSION, FILE_MAX_BYTES);
/**
 * Left where a replayed message's image was: the image itself rides on the current turn, so without this the model
 * reads an old screenshot as part of the latest message.
 */
export const REPLAYED_IMAGE_NOTE = "[An image was attached to this earlier message. It is attached again to this turn only so you can still see it; it is not new and was not sent with the latest message.]";
/**
 * Invalid tags stay visible as ordinary text and never become native image input. A video's <attached-file> tag
 * always stays in the text, so an engine that reads files still gets its path; sampled frames only add to it.
 */
export function extractTurnImages(text, options = {}) {
    if (!text.includes("<attached-image") && !text.includes("<attached-file"))
        return { text, images: [], videos: [] };
    const attachmentsDir = options.attachmentsDir ?? ATTACHMENTS_DIR;
    const maxCount = options.maxCount ?? TURN_IMAGE_MAX_COUNT;
    const maxBytes = options.maxBytes ?? TURN_IMAGE_MAX_BYTES;
    const maxVideoCount = options.maxVideoCount ?? TURN_VIDEO_MAX_COUNT;
    const candidates = attachmentTagCandidates(text);
    const admittedImages = candidates
        .filter((tag) => tag.kind === "image")
        .map((tag) => ({ tag, image: ownedImage(tag.path, attachmentsDir) }))
        .filter((item) => item.image !== null);
    if (admittedImages.length > maxCount) {
        throw statusError(413, `Send no more than ${maxCount} images at a time`);
    }
    const aggregateBytes = admittedImages.reduce((total, item) => total + item.image.bytes, 0);
    if (aggregateBytes > maxBytes) {
        throw statusError(413, `Attached images exceed ${Math.floor(maxBytes / (1024 * 1024))} MB total`);
    }
    const videos = candidates
        .filter((tag) => tag.kind === "file")
        .map((tag) => ownedVideo(tag.path, attachmentsDir))
        .filter((video) => video !== null)
        .slice(0, maxVideoCount);
    let providerText = text;
    const removedTags = admittedImages.map((item) => item.tag).sort((a, b) => b.start - a.start);
    const note = options.imageNote ?? "";
    for (const tag of removedTags)
        providerText = providerText.slice(0, tag.start) + note + providerText.slice(tag.end);
    return { text: providerText, images: admittedImages.map((item) => item.image), videos };
}
/** Stills sampled from a message's video, never taking a turn that already carries `earlier` images past its image count. */
export function videoFramesWithin(earlier, videos) {
    return videoFrameImages(videos, TURN_IMAGE_MAX_COUNT - earlier);
}
export function extractSteerImages(texts, options = {}) {
    const maxCount = options.maxCount ?? TURN_IMAGE_MAX_COUNT;
    const maxBytes = options.maxBytes ?? TURN_IMAGE_MAX_BYTES;
    const resolved = [];
    const images = [];
    try {
        for (const text of texts) {
            const item = extractTurnImages(text, options);
            resolved.push(item.text);
            images.push(...item.images);
        }
    }
    catch {
        return null;
    }
    if (images.length > maxCount)
        return null;
    if (images.reduce((total, image) => total + image.bytes, 0) > maxBytes)
        return null;
    return { texts: resolved, images };
}
export function extractReplayImages(transcript, current, options = {}) {
    let maxCount = (options.maxCount ?? TURN_IMAGE_MAX_COUNT) - current.length;
    let maxBytes = (options.maxBytes ?? TURN_IMAGE_MAX_BYTES) - current.reduce((total, image) => total + image.bytes, 0);
    const replayed = [...transcript];
    const images = [];
    for (let index = replayed.length - 1; index >= 0 && maxCount > 0; index -= 1) {
        const entry = replayed[index];
        if (entry.role !== "user")
            continue;
        const item = extractTurnImages(entry.text, { ...options, maxCount: Infinity, maxBytes: Infinity, imageNote: REPLAYED_IMAGE_NOTE });
        if (!item.images.length)
            continue;
        const bytes = item.images.reduce((total, image) => total + image.bytes, 0);
        if (item.images.length > maxCount || bytes > maxBytes)
            break;
        replayed[index] = { ...entry, text: item.text };
        images.unshift(...item.images);
        maxCount -= item.images.length;
        maxBytes -= bytes;
    }
    return { transcript: replayed, images };
}
