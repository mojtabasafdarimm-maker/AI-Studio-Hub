import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { DATA_DIR } from "./config.js";
import { buildStamp } from "./environment.js";
import { afterFirstEngineRead } from "./first-engine-read.js";
const SAFE_INSTANCE_ID = /^[\w.-]+$/;
/** A list this server's build read this recently is used as it is at start; an older one, or one an earlier build read,
 * is read again in the background. A sleeping Cloud wakes many times an hour, and each read can start the engine's CLI. */
export const STARTUP_MODEL_CACHE_FRESH_MS = 6 * 60 * 60_000;
/** Engines opened since this server started: opening one again means its key or settings just changed. */
const openedThisRun = new Set();
export function startupModelCachePath(instanceId) {
    if (!SAFE_INSTANCE_ID.test(instanceId))
        return null;
    return join(DATA_DIR, "providers", "engine-models", `${instanceId}.json`);
}
export function laterStartup() {
    try {
        const parsed = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
        return Array.isArray(parsed) && parsed.length > 0;
    }
    catch {
        return false;
    }
}
function variantList(value) {
    if (!Array.isArray(value))
        return undefined;
    const variants = value.flatMap((entry) => {
        if (!entry || typeof entry !== "object")
            return [];
        const variant = entry;
        return typeof variant.id === "string" && typeof variant.label === "string"
            ? [{ id: variant.id, label: variant.label }]
            : [];
    });
    return variants.length ? variants : undefined;
}
function catalogFrom(value) {
    if (!value || typeof value !== "object")
        return null;
    const raw = value;
    if (typeof raw.default !== "string" || !Array.isArray(raw.options) || raw.options.length === 0)
        return null;
    const options = [];
    for (const entry of raw.options) {
        if (!entry || typeof entry !== "object")
            return null;
        const option = entry;
        if (typeof option.id !== "string" || typeof option.label !== "string")
            return null;
        const variants = variantList(option.variants);
        options.push({
            id: option.id,
            label: option.label,
            ...(option.custom === true ? { custom: true } : {}),
            ...(option.loaded === true ? { loaded: true } : {}),
            ...(typeof option.provider === "string" ? { provider: option.provider } : {}),
            ...(typeof option.contextWindow === "number" && Number.isFinite(option.contextWindow)
                ? { contextWindow: option.contextWindow }
                : {}),
            ...(variants ? { variants } : {}),
            ...(option.orgBlocked === true ? { orgBlocked: true } : {}),
            ...(typeof option.needsCliUpdate === "string" ? { needsCliUpdate: option.needsCliUpdate } : {}),
        });
    }
    return { default: raw.default, options };
}
const unconfirmed = new WeakSet();
/** The engine did not give this list (its CLI timed out, or answered nothing): it is saved, but read again at the next start. */
export function unconfirmedModelCatalog(catalog) {
    unconfirmed.add(catalog);
}
export function readStartupModelCacheEntry(instanceId) {
    const path = startupModelCachePath(instanceId);
    if (!path)
        return null;
    try {
        const raw = JSON.parse(readFileSync(path, "utf8"));
        const catalog = catalogFrom(raw);
        return catalog ? {
            catalog,
            checkedAt: typeof raw.checkedAt === "number" && Number.isFinite(raw.checkedAt) ? raw.checkedAt : null,
            build: typeof raw.build === "string" ? raw.build : null,
        } : null;
    }
    catch {
        return null;
    }
}
export function readStartupModelCache(instanceId) {
    return readStartupModelCacheEntry(instanceId)?.catalog ?? null;
}
export function writeStartupModelCache(instanceId, catalog, read = {}) {
    if (!catalog.options.length)
        return;
    const path = startupModelCachePath(instanceId);
    if (!path)
        return;
    const stored = catalogFrom(catalog);
    if (!stored)
        return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic(path, JSON.stringify({ ...stored, checkedAt: read.checkedAt ?? (unconfirmed.has(catalog) ? 0 : Date.now()), build: read.build ?? buildStamp() }), { durable: false });
}
export function openStartupModelCatalog(input) {
    const reopened = openedThisRun.has(input.instanceId);
    openedThisRun.add(input.instanceId);
    const entry = readStartupModelCacheEntry(input.instanceId);
    const cached = entry?.catalog ?? null;
    if (cached)
        input.use(cached);
    const persist = () => {
        try {
            writeStartupModelCache(input.instanceId, input.current());
        }
        catch {
        }
    };
    if (!laterStartup()) {
        return input.refresh().then(() => {
            persist();
            return null;
        });
    }
    const age = (input.now ?? Date.now()) - (entry?.checkedAt ?? -Infinity);
    if (cached && !reopened && entry?.build === buildStamp() && age >= 0 && age < STARTUP_MODEL_CACHE_FRESH_MS)
        return Promise.resolve(null);
    // A saved list stands in while the refresh waits; with none the engine would offer no model at all until it runs.
    const startAfter = cached ? afterFirstEngineRead() : Promise.resolve();
    return { pending: startAfter.then(() => input.refresh()).then(persist, () => undefined) };
}
