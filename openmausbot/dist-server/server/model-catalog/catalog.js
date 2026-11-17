/*! Adapted from anomalyco/opencode@2fa3363c924c5c3e367b84a87ae478296a0ed59b
 * packages/core/src/models-dev.ts:160-258, MIT; modified.
 *
 * MIT License
 *
 * Copyright (c) 2025 opencode
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../atomic.js";
import { OPENAI_COMPATIBLE_NPM, PROVIDER_PRESETS } from "./presets.js";
import { MODEL_CATALOG_SCHEMA, catalogStats, packCatalog, trimModelsDevCatalog, unpackCatalog, } from "./trim.js";
export const MODELS_DEV_URL = "https://models.dev/api.json";
export const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CATALOG_FETCH_TIMEOUT_MS = 10_000;
export const CATALOG_MAX_BYTES = 20 * 1024 * 1024;
export const CATALOG_DISABLE_ENV = "OMB_DISABLE_MODEL_CATALOG_FETCH";
export const SNAPSHOT_FILE = "models-dev.snapshot.json";
/** Our cache, under providers/ so backups and Move to Cloud leave it out. */
export function modelCatalogCachePath(dataDir) {
    return join(dataDir, "providers", "model-providers", "models-dev.json");
}
/** Where OpenCode keeps models.dev (xdg-basedir's cache dir, on every OS). */
export function openCodeCatalogCachePath(env = process.env) {
    return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode", "models.json");
}
/** Beside this module in a checkout; under model-catalog/ beside the bundled server. */
function readBundledSnapshot() {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const path of [join(here, SNAPSHOT_FILE), join(here, "model-catalog", SNAPSHOT_FILE)]) {
        if (existsSync(path))
            return readFileSync(path, "utf8");
    }
    return undefined;
}
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/u;
// An ETag is echoed back in a request header: keep only a plain, short one.
const safeEtag = (value) => typeof value === "string" && value.length <= 256 && !CONTROL.test(value) ? value : undefined;
const time = (value) => {
    if (typeof value !== "string")
        return undefined;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
};
const message = (error) => error instanceof Error ? error.message : String(error);
export class ModelCatalogStore {
    options;
    cachePath;
    memo;
    inflight;
    constructor(options) {
        this.options = options;
        this.cachePath = modelCatalogCachePath(options.dataDir);
    }
    get now() {
        return (this.options.now ?? Date.now)();
    }
    log(text) {
        (this.options.log ?? ((line) => console.warn(line)))(`[model-catalog] ${text}`);
    }
    get fetchDisabled() {
        return Boolean(this.options.fetchDisabled) || (this.options.env ?? process.env)[CATALOG_DISABLE_ENV] === "1";
    }
    /** The newest usable catalog. Never throws; worst case an empty catalog. */
    get() {
        if (this.memo)
            return this.memo;
        const candidates = [this.ownCache(), this.openCodeCache(), this.snapshot()]
            .filter((candidate) => candidate !== undefined);
        // Stable sort: on equal times the listed order (cache, OpenCode, snapshot) wins.
        candidates.sort((a, b) => b.updatedAt - a.updatedAt);
        for (const candidate of candidates) {
            let drops = 0;
            const providers = trimModelsDevCatalog(candidate.providers(), { onDrop: () => { drops += 1; } });
            if (!Object.keys(providers).length) {
                this.log(`the ${candidate.origin} catalog held no usable providers; trying the next one`);
                continue;
            }
            if (drops)
                this.log(`left out ${drops} ${candidate.origin} catalog entries that were malformed or contained { or }`);
            this.memo = { origin: candidate.origin, updatedAt: new Date(candidate.updatedAt).toISOString(), providers };
            return this.memo;
        }
        this.memo = { origin: "empty", updatedAt: new Date(0).toISOString(), providers: trimModelsDevCatalog(undefined) };
        return this.memo;
    }
    /** Skipped while the cache is under 24 hours old, unless `force`. Concurrent calls share one request. Never throws. */
    refresh(options = {}) {
        if (this.fetchDisabled)
            return Promise.resolve("disabled");
        this.inflight ??= this.fetchAndStore(Boolean(options.force)).finally(() => {
            this.inflight = undefined;
        });
        return this.inflight;
    }
    readDocument() {
        if (!existsSync(this.cachePath))
            return undefined;
        try {
            if (statSync(this.cachePath).size > (this.options.maxBytes ?? CATALOG_MAX_BYTES))
                throw new Error("too large");
            const doc = JSON.parse(readFileSync(this.cachePath, "utf8"));
            const updatedAt = time(doc?.updatedAt);
            if (doc?.schema !== MODEL_CATALOG_SCHEMA || updatedAt === undefined || !doc.providers)
                throw new Error("unrecognised format");
            return { doc, updatedAt };
        }
        catch (error) {
            this.log(`removed an unreadable catalog cache (${message(error)})`);
            try {
                rmSync(this.cachePath, { force: true });
            }
            catch { }
            return undefined;
        }
    }
    ownCache() {
        const cached = this.readDocument();
        return cached && { origin: "cache", updatedAt: cached.updatedAt, providers: () => unpackCatalog(cached.doc.providers) };
    }
    openCodeCache() {
        const path = this.options.openCodeCachePath === undefined
            ? openCodeCatalogCachePath(this.options.env ?? process.env)
            : this.options.openCodeCachePath;
        if (!path)
            return undefined;
        try {
            const stat = statSync(path);
            if (!stat.isFile() || stat.size > (this.options.maxBytes ?? CATALOG_MAX_BYTES))
                return undefined;
            return { origin: "opencode", updatedAt: stat.mtimeMs, providers: () => {
                    try {
                        return JSON.parse(readFileSync(path, "utf8"));
                    }
                    catch {
                        return undefined;
                    }
                } };
        }
        catch {
            return undefined;
        }
    }
    snapshot() {
        try {
            const text = (this.options.readSnapshot ?? readBundledSnapshot)();
            if (text === undefined) {
                this.log("the bundled catalog snapshot is missing");
                return undefined;
            }
            const doc = JSON.parse(text);
            const updatedAt = time(doc?.updatedAt);
            if (doc?.schema !== MODEL_CATALOG_SCHEMA || updatedAt === undefined)
                throw new Error("unrecognised format");
            return { origin: "snapshot", updatedAt, providers: () => unpackCatalog(doc.providers) };
        }
        catch (error) {
            this.log(`could not read the bundled catalog snapshot (${message(error)})`);
            return undefined;
        }
    }
    async fetchAndStore(force) {
        const cached = this.readDocument();
        const age = cached ? this.now - cached.updatedAt : Infinity;
        if (!force && age >= 0 && age < CATALOG_MAX_AGE_MS)
            return "fresh";
        try {
            const etag = cached ? safeEtag(cached.doc.source?.etag) : undefined;
            const response = await this.download(etag);
            if (response.status === 304) {
                if (!cached)
                    throw new Error("models.dev answered 304 without a cached copy");
                this.write({ ...cached.doc, updatedAt: new Date(this.now).toISOString() });
                this.memo = undefined;
                return "not-modified";
            }
            let raw;
            try {
                raw = JSON.parse(response.text);
            }
            catch {
                throw new Error("models.dev returned invalid JSON");
            }
            let drops = 0;
            const providers = trimModelsDevCatalog(raw, { onDrop: () => { drops += 1; } });
            if (!Object.keys(providers).length)
                throw new Error("models.dev returned no usable providers");
            this.write({
                schema: MODEL_CATALOG_SCHEMA,
                updatedAt: new Date(this.now).toISOString(),
                source: { name: "models.dev", url: MODELS_DEV_URL, license: "MIT", ...(response.etag ? { etag: response.etag } : {}) },
                providers: packCatalog(providers),
            });
            this.memo = undefined;
            const stats = catalogStats(providers);
            this.log(`updated from models.dev: ${stats.providers} providers, ${stats.models} models` +
                (drops ? `; left out ${drops} entries that were malformed or contained { or }` : ""));
            return "updated";
        }
        catch (error) {
            this.log(`could not refresh from models.dev (${message(error)}); keeping the current catalog`);
            return "failed";
        }
    }
    write(doc) {
        mkdirSync(dirname(this.cachePath), { recursive: true });
        writeFileAtomic(this.cachePath, JSON.stringify(doc));
    }
    async download(etag) {
        const maxBytes = this.options.maxBytes ?? CATALOG_MAX_BYTES;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? CATALOG_FETCH_TIMEOUT_MS);
        try {
            const response = await (this.options.fetch ?? fetch)(MODELS_DEV_URL, {
                headers: { accept: "application/json", "user-agent": "OpenMausBot", ...(etag ? { "if-none-match": etag } : {}) },
                // The catalog comes from models.dev only.
                redirect: "error",
                signal: controller.signal,
            });
            if (response.status === 304 && etag) {
                void response.body?.cancel().catch(() => { });
                return { status: 304 };
            }
            if (response.status !== 200) {
                void response.body?.cancel().catch(() => { });
                throw new Error(`models.dev returned HTTP ${response.status}`);
            }
            const declared = Number(response.headers.get("content-length"));
            if (Number.isFinite(declared) && declared > maxBytes) {
                void response.body?.cancel().catch(() => { });
                throw new Error(`models.dev sent more than ${maxBytes} bytes`);
            }
            const text = await readCapped(response, maxBytes);
            return { status: 200, text, etag: safeEtag(response.headers.get("etag")) };
        }
        catch (error) {
            if (controller.signal.aborted)
                throw new Error("models.dev did not answer in time");
            throw error;
        }
        finally {
            clearTimeout(timer);
        }
    }
}
async function readCapped(response, maxBytes) {
    if (!response.body)
        return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => { });
            throw new Error(`models.dev sent more than ${maxBytes} bytes`);
        }
        text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
}
function presetNpm(preset, provider) {
    if (preset.npm)
        return preset.npm;
    if (!provider?.npm)
        return undefined;
    return provider.api === undefined || provider.api === preset.api ? provider.npm : OPENAI_COMPATIBLE_NPM;
}
export function catalogEntries(catalog, presets = PROVIDER_PRESETS) {
    const entries = [];
    const covered = new Set();
    for (const preset of presets) {
        const provider = preset.catalogId ? catalog.providers[preset.catalogId] : undefined;
        if (provider)
            covered.add(provider.id);
        const entry = {
            id: preset.id,
            label: preset.label,
            env: provider?.env ?? (preset.env ? [preset.env] : []),
            api: preset.api,
            modelCount: provider ? Object.keys(provider.models).length : 0,
            preset,
        };
        if (provider)
            entry.catalogId = provider.id;
        const npm = presetNpm(preset, provider);
        if (npm)
            entry.npm = npm;
        const doc = preset.doc ?? provider?.doc;
        if (doc)
            entry.doc = doc;
        if (preset.recommended !== undefined)
            entry.recommended = preset.recommended;
        entries.push(entry);
    }
    for (const provider of Object.values(catalog.providers)) {
        if (covered.has(provider.id) || presets.some((preset) => preset.id === provider.id))
            continue;
        const entry = { id: provider.id, catalogId: provider.id, label: provider.name, env: provider.env, modelCount: Object.keys(provider.models).length };
        if (provider.npm)
            entry.npm = provider.npm;
        if (provider.api)
            entry.api = provider.api;
        if (provider.doc)
            entry.doc = provider.doc;
        entries.push(entry);
    }
    return entries.sort((a, b) => (a.recommended ?? Infinity) - (b.recommended ?? Infinity) ||
        a.label.localeCompare(b.label, "en", { sensitivity: "base" }) ||
        a.id.localeCompare(b.id));
}
