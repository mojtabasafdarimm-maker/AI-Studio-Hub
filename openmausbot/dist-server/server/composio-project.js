// A person's own Composio project, reached with their ak_ key. A Tool Router Session uses one of the project's own auth
// configs (a bring-your-own OAuth app such as Xero or Buffer, or an API-key toolkit) only when it names that config's id
// under `auth_configs`, keyed by toolkit, and only while the config is enabled for Tool Router. A config a person made
// themselves can have that off or unset, which Composio's own CLI reads as off; the API's PATCH sets it (v3.1, Oct 2026):
// https://docs.composio.dev/docs/configuring-sessions
// https://docs.composio.dev/kb/guide/mcp-tool-router-sessions
// https://docs.composio.dev/reference/api-reference/auth-configs/getAuthConfigs
// https://docs.composio.dev/reference/api-reference/auth-configs/patchAuthConfigsByNanoid
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AUTH_CONFIG_ID } from "../shared/connector-availability.js";
import { writeFileAtomic } from "./atomic.js";
import { DATA_DIR } from "./config.js";
export const DEFAULT_BACKEND_ORIGIN = "https://backend.composio.dev";
export function apiBase() {
    return (process.env.OMB_COMPOSIO_API ?? `${DEFAULT_BACKEND_ORIGIN}/api/v3.1`).replace(/\/$/, "");
}
export function projectHeaders(apiKey, json = false) {
    const headers = new Headers({ "x-api-key": apiKey });
    if (json)
        headers.set("content-type", "application/json");
    return headers;
}
export async function responseError(res, fallback) {
    const raw = await res.text().catch(() => "");
    try {
        const body = JSON.parse(raw);
        return String(body?.message ?? body?.error?.message ?? body?.error ?? fallback);
    }
    catch {
        return raw.trim().slice(0, 300) || fallback;
    }
}
export function inputError(message, status = 400) {
    return Object.assign(new Error(message), { status });
}
/** Composio's slug is `twitter`; saved cards and model calls may still say `x`. */
export function canonicalToolkitSlug(slug) {
    const normalized = slug.trim().toLowerCase();
    return normalized === "x" ? "twitter" : normalized;
}
const authConfigItemSchema = z.object({
    id: z.string().optional(),
    type: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    is_composio_managed: z.boolean().optional(),
    is_enabled_for_tool_router: z.boolean().nullable().optional(),
    created_at: z.string().nullable().optional(),
    last_updated_at: z.string().nullable().optional(),
    toolkit: z.object({ slug: z.string().optional() }).optional(),
});
const authConfigsPageSchema = z.object({
    items: z.array(authConfigItemSchema).optional(),
    next_cursor: z.string().nullable().optional(),
});
const MAX_AUTH_CONFIG_PAGES = 20;
const LISTING_TTL_MS = 60_000;
const LISTING_RETRY_MS = 15_000;
function usableConfig(item) {
    return item.is_composio_managed !== true && (!item.status || /^enabled$/i.test(item.status));
}
async function readListing(apiKey) {
    const byToolkit = new Map();
    let cursor;
    for (let page = 0; page < MAX_AUTH_CONFIG_PAGES; page++) {
        const params = new URLSearchParams({ is_composio_managed: "false", limit: "100" });
        if (cursor)
            params.set("cursor", cursor);
        const res = await fetch(`${apiBase()}/auth_configs?${params}`, {
            headers: projectHeaders(apiKey),
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok)
            throw new Error(await responseError(res, `HTTP ${res.status}`));
        const body = authConfigsPageSchema.parse(await res.json());
        for (const item of body.items ?? []) {
            const slug = item.toolkit?.slug ? canonicalToolkitSlug(item.toolkit.slug) : "";
            if (!slug || !item.id || !usableConfig(item))
                continue;
            byToolkit.set(slug, [...byToolkit.get(slug) ?? [], {
                    id: item.id,
                    type: item.type || "custom",
                    toolRouter: item.is_enabled_for_tool_router === true,
                    created: item.created_at || item.last_updated_at || "",
                }]);
        }
        const next = body.next_cursor ?? undefined;
        if (!next || next === cursor)
            break;
        cursor = next;
    }
    for (const configs of byToolkit.values()) {
        configs.sort((a, b) => b.created.localeCompare(a.created) || a.id.localeCompare(b.id));
    }
    return { byToolkit };
}
const listings = new Map();
const listingReads = new Map();
const loggedChoices = new Map();
/** Separates per-project state without keeping another plaintext copy of the key. */
function projectFingerprint(apiKey) {
    return createHash("sha256").update("composio-project\0").update(apiKey.trim()).digest("hex");
}
function refreshListing(apiKey, project) {
    const pending = listingReads.get(project);
    if (pending)
        return pending;
    const read = readListing(apiKey).then((listing) => ({ listing, expiresAt: Date.now() + LISTING_TTL_MS }), (error) => {
        const readError = error instanceof Error ? error.message : String(error);
        console.warn(`[composio] could not read the project's auth configs (${readError}); Sessions keep the last list`);
        return {
            listing: listings.get(project)?.listing ?? { byToolkit: new Map() },
            expiresAt: Date.now() + LISTING_RETRY_MS,
            readError,
        };
    }).then((entry) => {
        listings.set(project, entry);
        return entry;
    }).finally(() => listingReads.delete(project));
    listingReads.set(project, read);
    return read;
}
/** The project's auth configs per toolkit. Never throws: a failed read keeps the last list (or none). */
export async function projectAuthConfigs(apiKey, options = {}) {
    const project = projectFingerprint(apiKey);
    const cached = listings.get(project);
    const entry = !options.fresh && cached && Date.now() < cached.expiresAt ? cached : await refreshListing(apiKey, project);
    const picked = authConfigPicks(project);
    const choices = {};
    for (const slug of [...entry.listing.byToolkit.keys()].sort()) {
        const configs = entry.listing.byToolkit.get(slug);
        const named = configs.find((config) => config.id === picked[slug]);
        const chosen = named ?? configs[0];
        choices[slug] = { id: chosen.id, type: chosen.type, toolRouter: chosen.toolRouter, of: configs.length, named: Boolean(named) };
        const logKey = `${project}:${slug}`;
        if (configs.length > 1 && !named && loggedChoices.get(logKey) !== chosen.id) {
            loggedChoices.set(logKey, chosen.id);
            console.info(`[composio] ${configs.length} enabled auth configs for ${slug}; using the most recently created, ${chosen.id}`);
        }
    }
    return {
        choices,
        configs: Object.fromEntries(Object.entries(choices).flatMap(([slug, choice]) => choice.toolRouter ? [[slug, choice.id]] : [])),
        ...(entry.readError ? { readError: entry.readError } : {}),
    };
}
/** The next lookup reads Composio again, as when a call just failed for want of an auth config; a project's last list
 * stays the fallback. */
export function forgetProjectAuthConfigs(apiKey) {
    if (apiKey === undefined)
        listings.clear();
    const entry = apiKey === undefined ? undefined : listings.get(projectFingerprint(apiKey));
    if (entry)
        entry.expiresAt = 0;
}
/** Changes one flag on the person's own config, and only once a connection for its toolkit needs it. */
export async function turnOnToolRouter(apiKey, toolkit, choice) {
    const res = await fetch(`${apiBase()}/auth_configs/${encodeURIComponent(choice.id)}`, {
        method: "PATCH",
        headers: projectHeaders(apiKey, true),
        body: JSON.stringify({ type: choice.type, is_enabled_for_tool_router: true }),
        signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok)
        throw inputError(toolRouterOffReason(toolkit, choice.id, await responseError(res, `HTTP ${res.status}`)), 409);
    console.info(`[composio] turned on Tool Router for the ${toolkit} auth config ${choice.id}`);
    for (const config of listings.get(projectFingerprint(apiKey))?.listing.byToolkit.get(toolkit) ?? []) {
        if (config.id === choice.id)
            config.toolRouter = true;
    }
}
const picksFileSchema = z.object({
    version: z.literal(1),
    projects: z.record(z.string(), z.record(z.string(), z.string().regex(AUTH_CONFIG_ID))),
});
let picks;
const picksFile = () => join(DATA_DIR, "composio-auth-configs.json");
function authConfigPicks(project) {
    if (!picks) {
        try {
            picks = picksFileSchema.parse(JSON.parse(readFileSync(picksFile(), "utf8"))).projects;
        }
        catch {
            picks = {};
        }
    }
    return picks[project] ?? {};
}
export function noAuthConfigReason(toolkit) {
    return `${toolkit} has no Composio-managed sign-in. In your Composio project, create an auth config for "${toolkit}" `
        + "(Auth Configs → Create) with your own app credentials, then click Connect again.";
}
function toolRouterOffReason(toolkit, id, said) {
    return `OpenMausBot could not turn on Tool Router for your ${toolkit} auth config ${id}, which Composio needs before it `
        + `uses it. Check that your Composio project key may edit auth configs. Composio said: ${said}`;
}
export function refusedAuthConfigReason(toolkit, said) {
    return `Composio would not use your ${toolkit} auth config. Check it is enabled in your Composio project. Composio said: ${said}`;
}
/** A bot's explicit `auth_config_id`, checked against the project before any Session names it. */
async function checkAuthConfigPick(apiKey, toolkit, id) {
    const res = await fetch(`${apiBase()}/auth_configs/${encodeURIComponent(id)}`, {
        headers: projectHeaders(apiKey),
        signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 400 || res.status === 404) {
        throw inputError(`Composio has no auth config ${id} in the project OpenMausBot uses. Copy the id from Auth Configs in that Composio project.`);
    }
    if (!res.ok)
        throw new Error(await responseError(res, `Composio auth config: HTTP ${res.status}`));
    const item = authConfigItemSchema.parse(await res.json());
    const owner = item.toolkit?.slug ? canonicalToolkitSlug(item.toolkit.slug) : toolkit;
    if (owner !== toolkit)
        throw inputError(`Auth config ${id} is for ${owner}, not ${toolkit}.`);
    if (item.is_composio_managed === true) {
        throw inputError(`Auth config ${id} is Composio's own sign-in for ${toolkit}, which OpenMausBot already uses, so no auth_config_id is needed.`);
    }
    if (!usableConfig(item))
        throw inputError(`Auth config ${id} for ${toolkit} is disabled. Enable it in your Composio project, then connect again.`);
}
/** Checks a bot's pick and keeps it for this project's later Sessions; it wins over the newest config while it stays usable. */
export async function keepAuthConfigPick(apiKey, toolkit, id) {
    await checkAuthConfigPick(apiKey, toolkit, id);
    const project = projectFingerprint(apiKey);
    authConfigPicks(project);
    picks = { ...picks, [project]: { ...picks?.[project], [toolkit]: id } };
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    writeFileAtomic(picksFile(), `${JSON.stringify({ version: 1, projects: picks }, null, 2)}\n`, { mode: 0o600 });
    forgetProjectAuthConfigs(apiKey);
}
const connectedAccountResponseSchema = z.object({
    id: z.string().optional(),
    user_id: z.string().optional(),
    alias: z.string().nullable().optional(),
    status: z.string().optional(),
    updated_at: z.string().optional(),
    toolkit: z.object({ slug: z.string().optional() }).optional(),
});
const connectedAccountsPageSchema = z.object({
    items: z.array(connectedAccountResponseSchema),
    next_cursor: z.string().nullable().optional(),
});
export const MAX_CONNECTED_ACCOUNT_PAGES = 100;
/** The project's connected accounts, newest first: one Composio user's, or every user's when `userId` is null. `stop`
 * sees each page and ends the listing early by returning true. */
export async function listConnectedAccounts(apiKey, userId, slugs, stop) {
    const accounts = [];
    const seenCursors = new Set();
    let cursor;
    for (let page = 0; page < MAX_CONNECTED_ACCOUNT_PAGES; page += 1) {
        const params = new URLSearchParams({
            limit: "50",
            order_by: "updated_at",
            order_direction: "desc",
        });
        if (userId !== null)
            params.set("user_ids", userId);
        if (slugs.length)
            params.set("toolkit_slugs", slugs.join(","));
        if (cursor)
            params.set("cursor", cursor);
        const response = await fetch(`${apiBase()}/connected_accounts?${params}`, {
            headers: projectHeaders(apiKey),
            signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok)
            throw new Error(await responseError(response, `Composio accounts: HTTP ${response.status}`));
        const body = connectedAccountsPageSchema.parse(await response.json());
        accounts.push(...body.items);
        if (stop?.(body.items))
            return accounts;
        const next = body.next_cursor || undefined;
        if (!next)
            return accounts;
        if (seenCursors.has(next))
            throw new Error("Composio account inventory contains a pagination cursor cycle");
        seenCursors.add(next);
        cursor = next;
    }
    throw new Error("Composio account inventory exceeded the pagination safety limit");
}
export async function deleteConnectedAccount(apiKey, id) {
    const removed = await fetch(`${apiBase()}/connected_accounts/${encodeURIComponent(id)}?revoke_on_delete=true`, { method: "DELETE", headers: projectHeaders(apiKey), signal: AbortSignal.timeout(30_000) });
    if (!removed.ok)
        throw new Error(await responseError(removed, `Composio disconnect: HTTP ${removed.status}`));
}
/** Revokes and deletes every connected account of one Composio user in the project; how many went. */
export async function removeUserConnections(apiKey, userId) {
    const accounts = await listConnectedAccounts(apiKey, userId, []);
    // Security: only an account Composio names as this user's is deleted.
    if (accounts.some((account) => account.user_id !== userId))
        throw new Error("Composio listed a connected account without naming this user as its owner");
    let removed = 0;
    for (const { id } of accounts)
        if (id) {
            await deleteConnectedAccount(apiKey, id);
            removed += 1;
        }
    return removed;
}
