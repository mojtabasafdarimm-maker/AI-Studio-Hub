// An MCP server's key kept in the Vault: config.json holds `vault:<id>` in its env, headers or OAuth client secret, and
// the value is read only when the server is started, tested or called, so there is one copy, one place to change it, and
// no plain text in config.json.
// Security: a pointer is read only for a server it was given to, so a `vault:` string planted in config.json or typed
// by a bot reads nothing; and only for a bot the item lets use it.
import { loginUsableBy } from "../../shared/logins.js";
const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|linked-[0-9a-f]{32}";
const POINTER = new RegExp(`(?<![\\w-])vault:(${ID})`, "gu");
const ITEM_ID = new RegExp(`^(?:${ID})$`, "u");
const LINKED_ID = /^linked-/u;
const LINKED_FRESH_MS = 5 * 60_000;
const LINKED_KEPT_MS = 15 * 60_000;
const MARK_USED_MS = 10 * 60_000;
export const vaultPointer = (item) => `vault:${item}`;
export const isVaultItemId = (value) => typeof value === "string" && ITEM_ID.test(value);
/** Text anywhere in `value` holding a `vault:<id>`: only a secretRef redeemed by OpenMausBot may put one in a server. */
export function holdsVaultPointer(value) {
    if (typeof value === "string")
        return value.search(POINTER) !== -1;
    if (Array.isArray(value))
        return value.some(holdsVaultPointer);
    if (value && typeof value === "object")
        return Object.values(value).some(holdsVaultPointer);
    return false;
}
const REMOVED = { ok: false, reason: "removed", why: "its key is no longer in the Vault." };
const KEPT = { ok: false, reason: "kept", why: "its key in the Vault is kept to other bots. The person can let you use it in Settings → Vault." };
const UNREAD = { ok: false, reason: "unread", why: "its key could not be read from the linked password manager." };
export function createMcpKeys(deps) {
    const now = deps.now ?? Date.now;
    const linked = new Map();
    const lastMarked = new Map();
    function valueOf(server, item, botId) {
        if (!deps.store.mcpServerKeys(server).includes(item))
            return REMOVED;
        if (LINKED_ID.test(item)) {
            const found = deps.linked.byId(item);
            if (!found)
                return REMOVED;
            if (botId !== undefined && !loginUsableBy(found, botId))
                return KEPT;
            const kept = linked.get(item);
            return kept && now() - kept.at < LINKED_KEPT_MS ? kept.value : UNREAD;
        }
        const secret = deps.store.secret(item);
        // Security: an MCP server serves the whole team, so a member's own secret is never its key.
        if (!secret || secret.person)
            return REMOVED;
        if (botId !== undefined && !loginUsableBy(secret, botId))
            return KEPT;
        if (botId !== undefined && now() - (lastMarked.get(item) ?? 0) >= MARK_USED_MS) {
            lastMarked.set(item, now());
            deps.store.markUsed(item);
        }
        return secret.value;
    }
    /** `text` with every pointer swapped for its value, or why the key is off. Plain text, and text naming no pointer, comes back as it is. */
    function swapped(server, text, botId, oneLine = false) {
        let off = null;
        const out = text.replace(POINTER, (whole, item) => {
            const value = valueOf(server, item, botId);
            if (typeof value !== "string") {
                off ??= value;
                return whole;
            }
            if (oneLine && /[\r\n]/u.test(value)) {
                off ??= REMOVED;
                return whole;
            }
            return value;
        });
        return off ?? out;
    }
    function swappedAll(server, entries, botId, oneLine = false) {
        const values = {};
        for (const [key, text] of Object.entries(entries)) {
            const value = swapped(server, text, botId, oneLine);
            if (typeof value !== "string")
                return value;
            values[key] = value;
        }
        return { ok: true, values };
    }
    /** The server as it is to be started or called (`botId` absent: for the person, Test or a start check). */
    function resolve(name, server, botId) {
        if (!holdsVaultPointer("url" in server ? [server.headers, server.oauth?.clientSecret] : server.env))
            return { ok: true, server };
        if ("url" in server) {
            const headers = swappedAll(name, server.headers, botId, true);
            if (!headers.ok)
                return headers;
            const client = server.oauth?.clientSecret ? swapped(name, server.oauth.clientSecret, botId, true) : undefined;
            if (typeof client === "object")
                return client;
            return { ok: true, server: { ...server, headers: headers.values, ...(server.oauth ? { oauth: { ...server.oauth, ...(client === undefined ? {} : { clientSecret: client }) } } : {}) } };
        }
        const env = swappedAll(name, server.env, botId);
        if (!env.ok)
            return env;
        return { ok: true, server: { ...server, env: env.values } };
    }
    /** An OAuth app as a sign-in uses it: its client secret read now, or left out while its key is off. */
    function oauthClient(name, oauth) {
        if (!oauth.clientSecret || !holdsVaultPointer(oauth.clientSecret))
            return oauth;
        const secret = swapped(name, oauth.clientSecret, undefined, true);
        const { clientSecret: _pointer, ...rest } = oauth;
        return typeof secret === "string" ? { ...rest, clientSecret: secret } : rest;
    }
    /** Reads a linked manager's values `server` points at, so `resolve` finds them: a turn, a Test or a start check asks
     * this first. Never logged; held only in this process, and masked as every linked value is. */
    async function warm(name, server) {
        const raw = "url" in server ? [...Object.values(server.headers), server.oauth?.clientSecret ?? ""] : Object.values(server.env);
        const items = [...new Set(raw.flatMap((text) => [...text.matchAll(POINTER)].map((match) => match[1])))].filter((item) => LINKED_ID.test(item) && deps.store.mcpServerKeys(name).includes(item));
        if (!items.length || items.every((item) => now() - (linked.get(item)?.at ?? -Infinity) < LINKED_FRESH_MS))
            return;
        await deps.linked.fresh().catch(() => { });
        for (const item of items) {
            if (now() - (linked.get(item)?.at ?? -Infinity) < LINKED_FRESH_MS)
                continue;
            try {
                const found = deps.linked.byId(item);
                if (found)
                    linked.set(item, { value: await found.read(), at: now() });
                else
                    linked.delete(item);
            }
            catch {
                linked.delete(item);
            }
        }
    }
    return {
        resolve,
        oauthClient,
        warm,
        forgetServer: (name) => deps.store.forgetMcpServer(name),
        /** The MCP servers that lose their key if this item goes. */
        usedBy: (item) => deps.store.serversUsingKey(item),
        /** Given to `name` by a move, or by a bot's secretRef. */
        grant: (name, items) => deps.store.grantMcpKeys(name, items.filter(isVaultItemId)),
        given: (name) => deps.store.mcpServerKeys(name),
    };
}
