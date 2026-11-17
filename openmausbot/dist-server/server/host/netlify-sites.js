import { lstat, readdir, readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
export const SITE_FILE = ".netlify-site.json";
export const NETLIFY_TOKEN_LABEL = "Netlify personal access token";
const NETLIFY_API = "https://api.netlify.com/api/v1";
const NETLIFY_ADMIN_HOST = "app.netlify.com";
export const SCAN_LIMITS = { depth: 4, folders: 400, sites: 50, recordBytes: 16_384 };
const SKIPPED_FOLDERS = new Set(["node_modules"]);
const DELETE_TIMEOUT_MS = 20_000;
const text = (max) => z.string().max(max).optional().catch(undefined);
const recordSchema = z.object({
    siteId: z.string().regex(/^[\w-]{1,80}$/),
    url: z.string().max(2_000),
    name: text(200), adminUrl: text(2_000), title: text(200), createdAt: text(40), publishedAt: text(40), access: text(20), hosting: text(20),
});
/** Must match skills/publish-to-netlify/deploy.mjs `apiBase`: only a loopback stand-in may replace Netlify's address,
 * so a token can never be pointed at another host. */
export function netlifyApiBase(env) {
    const override = env.OMB_NETLIFY_API_URL;
    return override && /^http:\/\/127\.0\.0\.1:\d{1,5}(\/[\w/.-]*)?$/.test(override) ? override.replace(/\/$/, "") : NETLIFY_API;
}
/** The loopback stand-in's origin while one replaces Netlify (tests and fixtures), else null. */
function standInOrigin(env) {
    const base = netlifyApiBase(env);
    return base === NETLIFY_API ? null : new URL(base).origin;
}
function webAddress(value, standIn, host) {
    if (!value)
        return null;
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return null;
    }
    if (url.username || url.password)
        return null;
    if (standIn && url.origin === standIn)
        return url.href;
    return url.protocol === "https:" && (!host || url.hostname === host) ? url.href : null;
}
const oneLine = (value) => value?.replace(/[\p{Cc}\s]+/gu, " ").trim() ?? "";
const time = (value) => { const at = value ? Date.parse(value) : NaN; return Number.isFinite(at) ? at : null; };
export function parseSiteRecord(raw, file, modifiedAt, env) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return null;
    }
    const parsed = recordSchema.safeParse(value);
    if (!parsed.success)
        return null;
    const record = parsed.data, standIn = standInOrigin(env), included = record.hosting === "included";
    const url = webAddress(record.url, standIn) ?? (included ? "" : null);
    if (url === null)
        return null;
    const manageUrl = included ? null : webAddress(record.adminUrl, standIn, NETLIFY_ADMIN_HOST);
    return {
        siteId: record.siteId, file, url, ...(manageUrl ? { manageUrl } : {}), ...(included ? { hosting: "included" } : {}),
        title: oneLine(record.title) || oneLine(record.name) || (url ? new URL(url).host : ""),
        publishedAt: time(record.publishedAt) ?? time(record.createdAt) ?? modifiedAt,
        access: record.access === "public" ? "public" : record.access === "private" ? "netlify-team" : "unknown",
    };
}
export const within = (folder, root) => folder === root || folder.startsWith(root + sep);
/** The site records under these folders: at most `SCAN_LIMITS` deep and wide, no hidden folders, nothing through a
 * link. A folder that holds the person's whole home (or more) is not searched: listing it would read far outside
 * anything a bot was given. */
export async function findNetlifySites(roots, options) {
    const home = resolve(options.home);
    const sites = [], seen = new Set();
    let folders = 0;
    const queue = [...new Set(roots.map((root) => resolve(root)))].filter((root) => !within(home, root)).map((folder) => ({ folder, depth: 0 }));
    for (let next = queue.shift(); next && folders < SCAN_LIMITS.folders && sites.length < SCAN_LIMITS.sites; next = queue.shift()) {
        if (seen.has(next.folder))
            continue;
        seen.add(next.folder);
        folders += 1;
        let entries;
        try {
            entries = await readdir(next.folder, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.name === SITE_FILE && entry.isFile()) {
                const site = await readSite(join(next.folder, entry.name), options.env);
                if (site && (site.hosting || !sites.some((other) => !other.hosting && other.siteId === site.siteId)))
                    sites.push(site);
            }
            else if (entry.isDirectory() && next.depth < SCAN_LIMITS.depth && !entry.name.startsWith(".") && !SKIPPED_FOLDERS.has(entry.name)) {
                queue.push({ folder: join(next.folder, entry.name), depth: next.depth + 1 });
            }
        }
    }
    return sites.slice(0, SCAN_LIMITS.sites);
}
export async function readSite(file, env) {
    try {
        const info = await lstat(file);
        if (!info.isFile() || info.size > SCAN_LIMITS.recordBytes)
            return null;
        return parseSiteRecord(await readFile(file, "utf8"), file, info.mtimeMs, env);
    }
    catch {
        return null;
    }
}
/** Security: the saved Netlify token a person's Delete may use for this bot: what a turn in the app's conversation
 * could use (`conversation`), with a member's own secret only when the person deleting is that member. One person's
 * token never acts on another person's click; the team's shared one is the team's to use. */
export function savedNetlifyToken(vault, botId, conversation, person) {
    if (!conversation)
        return null;
    const reader = conversation.person && conversation.person !== person ? { person: null, team: conversation.team } : conversation;
    return vault.usableSecret(NETLIFY_TOKEN_LABEL, botId, "file", reader)?.value ?? null;
}
/** DELETE /sites/<id> on Netlify with the person's token. A site Netlify no longer has counts as deleted. The token goes
 * only to Netlify (or its loopback stand-in) and never into the answer. */
export async function deleteNetlifySite(siteId, token, options) {
    let status = 0;
    try {
        const response = await (options.fetch ?? fetch)(`${netlifyApiBase(options.env)}/sites/${encodeURIComponent(siteId)}`, {
            method: "DELETE", headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
        });
        status = response.status;
        await response.body?.cancel().catch(() => { });
    }
    catch {
        return { ok: false, reason: "failed", status: 0 };
    }
    if ((status >= 200 && status < 300) || status === 404)
        return { ok: true };
    return { ok: false, reason: status === 401 || status === 403 ? "token_refused" : "failed", status };
}
/** Removes a deleted site's record, when it still names that site, so the next publish from the project makes a new one. */
export async function forgetSiteRecord(site, roots, env) {
    const folder = dirname(resolve(site.file));
    if (!roots.some((root) => within(folder, resolve(root))))
        return false;
    const current = await readSite(site.file, env);
    if (current?.siteId !== site.siteId)
        return false;
    try {
        await unlink(site.file);
        return true;
    }
    catch {
        return false;
    }
}
