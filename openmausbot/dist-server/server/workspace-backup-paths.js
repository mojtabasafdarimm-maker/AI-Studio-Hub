import { isAbsolute, join } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { escapeAttribute, splitTranscriptAttachments } from "../src/lib/composer-attachments.js";
const PATH_KEYS = new Set(["cwd", "pinnedCwd", "workspace", "configDir", "profileDirectory", "agentDir", "dataDir", "home", "cli", "path", "filePath", "localPath"]);
const FOLDER_KEYS = new Set(["cwd", "pinnedCwd"]);
const FILE_KEYS = new Set(["path", "filePath", "localPath"]);
const MAX_LEFT_BEHIND = 20;
/** Standing instructions and memory, which name paths in prose. */
export const INSTRUCTION_FILE = /^(?:bots\/[^/]+\/SOUL\.md|workspaces\/[^/]+\/(?:MEMORY\.md|memory\/.+\.md))$/;
const WINDOWS_ROOT = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/;
const WINDOWS_PATH = /(?<![\w\\/])(?:[A-Za-z]:|\\\\[^\s"'`<>|\\/]+)[\\/][^\s"'`<>|]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;
export function validRelative(path) {
    return !!path && path.length <= 4096 && !isAbsolute(path) && !/[\\\0:]/.test(path) &&
        path.split("/").every((part) => !!part && part !== "." && part !== ".." && !/[. ]$/.test(part) &&
            !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
const windowsPath = (path) => WINDOWS_ROOT.test(path);
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function restorePaths(source, destination) {
    const windows = windowsPath(source);
    const crossing = windows !== windowsPath(destination);
    const root = source.replaceAll("\\", "/").replace(/\/$/, "");
    const fold = (text) => windows ? text.toLowerCase() : text;
    const separators = windows ? "[\\\\/]+" : "/+";
    const name = windows ? "[^\\s\"'`<>|\\\\/]+" : "[^\\s\"'`<>|/]+";
    const mention = new RegExp(`(?<![\\w.\\\\/-])${root.split("/").map(literal).join(separators)}((?:${separators}${name})*(?:${separators})?)(?=[.,;:!?)\\]}]*(?:[\\s"'\`<>|]|$))`, windows ? "gi" : "g");
    const runs = new RegExp(separators, "g");
    const separator = windowsPath(destination) ? "\\" : "/";
    const left = new Map();
    const bots = new Set();
    const inside = (value) => {
        const normalized = value.replaceAll("\\", "/");
        if (fold(normalized.slice(0, root.length)) !== fold(root))
            return null;
        if (normalized.length === root.length)
            return "";
        return normalized[root.length] === "/" ? normalized.slice(root.length + 1) : null;
    };
    const rebase = (value) => {
        const suffix = inside(value);
        if (suffix === null || (suffix && !validRelative(suffix)))
            return value;
        return suffix ? join(destination, suffix) : destination;
    };
    const foreign = (value) => crossing && inside(value) === null && (windows ? windowsPath(value) : value.startsWith("/"));
    const leave = (path) => {
        const key = fold(path.replaceAll("\\", "/"));
        if (left.size < MAX_LEFT_BEHIND && !left.has(key))
            left.set(key, path);
    };
    const fields = (value, definitions, bot) => {
        if (Array.isArray(value)) {
            for (const item of value)
                fields(item, definitions, bot);
            return;
        }
        if (!record(value))
            return;
        for (const [key, item] of Object.entries(value)) {
            if (typeof item === "object")
                fields(item, definitions, bot);
            else if (typeof item !== "string" || !PATH_KEYS.has(key))
                continue;
            else if (!definitions || !foreign(item))
                value[key] = rebase(item);
            else if (FILE_KEYS.has(key))
                leave(item);
            else if (FOLDER_KEYS.has(key)) {
                leave(item);
                delete value[key];
                // Engine sessions are tied to the folder they started in, and their files stayed there too.
                if (record(value.resumeCursors))
                    value.resumeCursors = {};
                if (bot !== undefined)
                    bots.add(bot);
            }
        }
    };
    const text = (value) => {
        if (source === destination)
            return value;
        const next = value.replace(mention, (_whole, rest) => destination + rest.replace(runs, separator));
        if (crossing && windows) {
            for (const [match] of next.matchAll(WINDOWS_PATH)) {
                const path = match.replace(TRAILING_PUNCTUATION, "");
                if (inside(path) === null)
                    leave(path);
            }
        }
        return next;
    };
    const message = (value) => {
        if (!record(value))
            return;
        for (const field of ["attachments", "images", "fileAttachments", "file", "card"])
            fields(value[field], false);
        if (typeof value.text !== "string")
            return;
        const body = value.text;
        const edits = [];
        // After a single newline a tag is inline HTML in a Markdown paragraph, though the app's parser shows it as a card.
        const candidates = fromMarkdown(body).children.flatMap((node) => node.type === "html" ? [node] :
            node.type === "paragraph" ? node.children.filter((child) => child.type === "html") : []);
        for (const node of candidates) {
            if (node.position?.start.offset === undefined || node.position.end.offset === undefined || node.position.start.column !== 1)
                continue;
            const lineEnd = body.indexOf("\n", node.position.end.offset);
            if (body.slice(node.position.end.offset, lineEnd < 0 ? body.length : lineEnd).trim())
                continue;
            const parsed = splitTranscriptAttachments(node.value, false);
            if (parsed.display.trim() || !parsed.images.length && !parsed.files.length)
                continue;
            const next = node.value.replace(/(<attached-(?:image|file)[\t ]+path=")([^"\r\n]*)(")/g, (whole, before, encoded, after) => {
                const attachment = [...parsed.images, ...parsed.files].find((item) => escapeAttribute(item.path) === encoded);
                return attachment ? `${before}${escapeAttribute(rebase(attachment.path))}${after}` : whole;
            });
            if (next !== node.value)
                edits.push({ from: node.position.start.offset, to: node.position.end.offset, text: next });
        }
        let next = body;
        for (const edit of edits.reverse())
            next = next.slice(0, edit.from) + edit.text + next.slice(edit.to);
        value.text = next;
    };
    return {
        fields: (value) => fields(value, false),
        /** Bots, rooms, routines and settings: a working folder left on another kind of computer is cleared and noted. */
        definitions: (value, bot) => fields(value, true, bot),
        text,
        message,
        leftBehind: () => left.size || bots.size ? { bots: bots.size, paths: [...left.values()] } : null,
    };
}
