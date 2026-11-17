// Content-addressed app documents under DATA_DIR/app-docs/: html/<sha256>.html, data/<sha256>.json, file/<sha256>.bin
// (a folder page's other files), and doc/<sha256>.json, the manifest an AppPayload.doc names. A file written in the last ten minutes is never
// swept, so a document stored a moment before its row is appended cannot be lost to a sweep in between.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const APP_DOCS_MAX_BYTES = 512 * 1024 * 1024;
export const APP_DOCS_SWEEP_GRACE_MS = 10 * 60_000;
const ID = /^[0-9a-f]{64}$/;
const KINDS = { html: ".html", data: ".json", doc: ".json", file: ".bin" };
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
export class AppDocs {
    dir;
    maxBytes;
    used = null;
    constructor(dir, options = {}) {
        this.dir = dir;
        this.maxBytes = options.maxBytes ?? APP_DOCS_MAX_BYTES;
    }
    path(kind, id) {
        return join(this.dir, kind, `${id}${KINDS[kind]}`);
    }
    usage() {
        if (this.used === null) {
            let total = 0;
            for (const kind of Object.keys(KINDS)) {
                for (const name of this.list(kind)) {
                    try {
                        total += statSync(join(this.dir, kind, name)).size;
                    }
                    catch { /* gone meanwhile */ }
                }
            }
            this.used = total;
        }
        return this.used;
    }
    list(kind) {
        try {
            return readdirSync(join(this.dir, kind));
        }
        catch {
            return [];
        }
    }
    /** An existing blob's time is refreshed, so the sweep's grace covers the row about to name it. */
    write(kind, id, text) {
        const target = this.path(kind, id);
        try {
            const now = new Date();
            utimesSync(target, now, now);
            return;
        }
        catch { /* not there yet */ }
        const before = this.usage();
        mkdirSync(join(this.dir, kind), { recursive: true, mode: 0o700 });
        const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
        writeFileSync(temp, text, { mode: 0o600 });
        renameSync(temp, target);
        this.used = before + (typeof text === "string" ? Buffer.byteLength(text) : text.byteLength);
    }
    /** A file beside a folder page's index.html, by its path in the folder; null when the document has none by that path. */
    readFile(doc, path) {
        const id = this.read(doc)?.data?.files?.[path];
        if (!id || !ID.test(id))
            return null;
        try {
            return readFileSync(this.path("file", id));
        }
        catch {
            return null;
        }
    }
    /** A video this document recorded when it was shown; nothing else is ever a video of this page. */
    video(doc, path) {
        const videos = this.read(doc)?.data?.videos;
        return videos && Object.hasOwn(videos, path) ? videos[path] : null;
    }
    put(input) {
        const html = input.html;
        const blobs = (input.files ?? []).map((file) => ({ path: file.path, data: file.data, id: createHash("sha256").update(file.data).digest("hex") }));
        const withFiles = blobs.length ? { ...input.data, files: Object.fromEntries(blobs.map((blob) => [blob.path, blob.id])) } : input.data;
        const data = withFiles ? JSON.stringify(withFiles) : null;
        const htmlId = sha256(html);
        const dataId = data === null ? null : sha256(data);
        const manifest = { v: 1, source: input.source, html: htmlId, data: dataId };
        const manifestText = JSON.stringify(manifest);
        const doc = sha256(JSON.stringify({ html: htmlId, data: dataId }));
        const exists = (kind, id) => {
            if (id === null)
                return true;
            try {
                statSync(this.path(kind, id));
                return true;
            }
            catch {
                return false;
            }
        };
        const unique = [...new Map(blobs.map((blob) => [blob.id, blob])).values()];
        const adding = unique.reduce((sum, blob) => sum + (exists("file", blob.id) ? 0 : blob.data.byteLength), 0) +
            (exists("html", htmlId) ? 0 : Buffer.byteLength(html)) +
            (exists("data", dataId) ? 0 : Buffer.byteLength(data ?? "")) +
            (exists("doc", doc) ? 0 : Buffer.byteLength(manifestText));
        if (adding > 0 && this.usage() + adding > this.maxBytes)
            return { ok: false, reason: "too-large" };
        for (const blob of unique)
            this.write("file", blob.id, blob.data);
        this.write("html", htmlId, html);
        if (data !== null && dataId !== null)
            this.write("data", dataId, data);
        this.write("doc", doc, manifestText);
        return { ok: true, doc, bytes: Buffer.byteLength(html) };
    }
    read(doc) {
        if (!ID.test(doc))
            return null;
        try {
            const manifest = JSON.parse(readFileSync(this.path("doc", doc), "utf8"));
            if (manifest.v !== 1 || !ID.test(manifest.html) || (manifest.data !== null && !ID.test(manifest.data)))
                return null;
            if (manifest.source !== "html" && manifest.source !== "mcp")
                return null;
            const html = readFileSync(this.path("html", manifest.html), "utf8");
            const data = manifest.data ? JSON.parse(readFileSync(this.path("data", manifest.data), "utf8")) : undefined;
            return { doc, source: manifest.source, html, ...(data ? { data } : {}) };
        }
        catch {
            return null;
        }
    }
    sweep(referenced, now = Date.now()) {
        const wanted = new Set([...referenced].filter((id) => ID.test(id)));
        const old = (kind, name) => {
            try {
                return now - statSync(join(this.dir, kind, name)).mtimeMs >= APP_DOCS_SWEEP_GRACE_MS;
            }
            catch {
                return false;
            }
        };
        let removed = 0;
        const remove = (kind, name) => {
            const file = join(this.dir, kind, name);
            try {
                const size = statSync(file).size;
                unlinkSync(file);
                removed += 1;
                if (this.used !== null)
                    this.used = Math.max(0, this.used - size);
            }
            catch { /* gone meanwhile */ }
        };
        const keepHtml = new Set();
        const keepData = new Set();
        const keepFiles = new Set();
        for (const name of this.list("doc")) {
            const id = name.slice(0, -KINDS.doc.length);
            if (name.endsWith(".tmp") || !ID.test(id) || !wanted.has(id)) {
                if (old("doc", name))
                    remove("doc", name);
                else if (ID.test(id))
                    this.keepBlobsOf(id, keepHtml, keepData, keepFiles);
                continue;
            }
            this.keepBlobsOf(id, keepHtml, keepData, keepFiles);
        }
        for (const [kind, keep] of [["html", keepHtml], ["data", keepData], ["file", keepFiles]]) {
            for (const name of this.list(kind)) {
                const id = name.slice(0, -KINDS[kind].length);
                if ((name.endsWith(".tmp") || !keep.has(id)) && old(kind, name))
                    remove(kind, name);
            }
        }
        return removed;
    }
    keepBlobsOf(doc, html, data, files) {
        try {
            const manifest = JSON.parse(readFileSync(this.path("doc", doc), "utf8"));
            if (typeof manifest.html === "string")
                html.add(manifest.html);
            if (typeof manifest.data === "string") {
                data.add(manifest.data);
                const named = JSON.parse(readFileSync(this.path("data", manifest.data), "utf8")).files ?? {};
                for (const id of Object.values(named))
                    if (typeof id === "string")
                        files.add(id);
            }
        }
        catch { /* an unreadable manifest keeps nothing */ }
    }
}
