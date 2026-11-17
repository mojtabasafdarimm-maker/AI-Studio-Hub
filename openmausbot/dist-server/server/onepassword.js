import { loginSite, normalizeLoginHost } from "../shared/logins.js";
import { parseTotpKey } from "./totp.js";
function loginFieldsOf(fields) {
    const byId = (id) => fields.find((field) => field.id === id && field.value);
    const username = byId("username")
        ?? fields.find((field) => (field.fieldType === "Text" || field.fieldType === "Email") && /user|e-?mail|login/iu.test(field.title) && field.value);
    const password = byId("password") ?? fields.find((field) => field.fieldType === "Concealed" && /pass/iu.test(field.title) && field.value);
    const totp = fields.find((field) => field.fieldType === "Totp" && field.value);
    return { username, password, totp };
}
export function loginFields(fields) {
    const { username, password, totp } = loginFieldsOf(fields);
    return { username: username?.value ?? "", password: password?.value ?? "", totp: totp?.value ?? null };
}
/** The 1Password categories (SDK ItemCategory) whose items are secrets rather than logins. */
const SECRET_CATEGORIES = new Set(["ApiCredentials", "Password", "SecureNote"]);
const MAIN_FIELD = { ApiCredentials: "credential", Password: "password" };
const FIELDS_MAX = 20;
/** A secret item's values by field title, with "" for its main one: an API Credential's credential, a Password's
 * password, a Secure Note's text, or else its first concealed field, or else its first field. */
export function secretFields(category, content) {
    const values = new Map();
    const usable = content.fields.filter((field) => field.value && (field.fieldType === "Concealed" || field.fieldType === "Text"));
    const note = category === "SecureNote" ? content.notes : undefined;
    const main = note ? undefined
        : usable.find((field) => field.id === MAIN_FIELD[category]) ?? usable.find((field) => field.fieldType === "Concealed") ?? usable[0];
    const mainValue = note || main?.value;
    if (mainValue)
        values.set("", mainValue);
    for (const field of usable) {
        const title = field.title.trim();
        if (field !== main && title && !values.has(title) && values.size <= FIELDS_MAX)
            values.set(title, field.value);
    }
    return values;
}
/** A Login item's own extra fields, such as a client ID and secret, by title, never its username, password or one-time
 * code; "" is the first concealed one, or else the first, so the item's name alone reads it too. */
export function loginExtraFields(content) {
    const { username, password } = loginFieldsOf(content.fields);
    const extra = content.fields.filter((field) => field !== username && field !== password
        && field.value && field.title.trim() && (field.fieldType === "Concealed" || field.fieldType === "Text"));
    const values = new Map();
    const main = extra.find((field) => field.fieldType === "Concealed") ?? extra[0];
    if (main)
        values.set("", main.value);
    for (const field of extra)
        if (!values.has(field.title.trim()) && values.size <= FIELDS_MAX)
            values.set(field.title.trim(), field.value);
    return values;
}
/** What a bot may read from an item as a secret: a Login's extra fields, or a secret item's fields. */
function secretValues(category, content) {
    return category === "Login" ? loginExtraFields(content) : secretFields(category, content);
}
/** The SDK did not load: a fault in this installation, never in the person's token, which was not even checked. */
export class OnePasswordUnavailableError extends Error {
    constructor() {
        super("1Password could not start on this server, so your token was not checked: this installation is missing its 1Password part. Update OpenMausBot, then connect again.");
        this.name = "OnePasswordUnavailableError";
    }
}
/** Why the SDK did not load goes to the server log for whoever reads it; the person gets the plain words. */
export function onePasswordUnavailable(error, log = (line) => console.warn(line)) {
    log(`1Password: the SDK did not load: ${(error instanceof Error ? error.message : String(error)).split("\n", 1)[0]}`);
    return new OnePasswordUnavailableError();
}
export async function sdkOnePasswordClient(sdk, token, version) {
    const client = await sdk.createClient({ auth: token, integrationName: "OpenMausBot", integrationVersion: version });
    return {
        vaults: async () => (await client.vaults.list()).map((vault) => ({ id: vault.id, title: vault.title })),
        items: async (vaultId) => (await client.items.list(vaultId))
            .map((item) => ({ id: item.id, title: item.title, category: item.category, urls: (item.websites ?? []).map((site) => site.url) })),
        contents: async (vaultId, itemIds) => {
            const found = new Map();
            if (!itemIds.length)
                return found;
            const { individualResponses } = await client.items.getAll(vaultId, itemIds);
            for (const { content } of individualResponses)
                if (content)
                    found.set(content.id, { fields: content.fields, ...(content.notes ? { notes: content.notes } : {}) });
            // An error answer names no item, so every item the batch did not return may be the one 1Password could not read.
            if (individualResponses.some(({ error }) => error?.type === "internal"))
                for (const id of itemIds)
                    if (!found.has(id))
                        found.set(id, null);
            return found;
        },
    };
}
const isLogin = (item) => item.category === "Login" && item.urls.length > 0;
const ID_PREFIX = "1password:";
const MAX_ITEMS = 500;
const FIELDS_BATCH = 50;
const STALE_MS = 10 * 60_000;
/** How an item's own bots are stored: `<vault id>:<item id>`. */
export function onePasswordItemKey(vaultId, itemId) {
    return `${vaultId}:${itemId}`;
}
export function isOnePasswordLoginId(id) {
    return id.startsWith(ID_PREFIX);
}
function bySite(hosts) {
    const sites = new Map();
    for (const host of hosts) {
        const site = loginSite(host);
        sites.set(site, [...(sites.get(site) ?? []), host]);
    }
    return sites;
}
export const ONE_PASSWORD_MALFORMED = "That is not a whole 1Password service account token. Copy all of it (it starts with ops_ and is very long), or make a new one in 1Password under Developer → Service accounts.";
export const ONE_PASSWORD_REFUSED = "1Password did not accept the token: it may have been revoked, expired, or lost access to its vault. Make a new service account token in 1Password and paste it here.";
/** Words for the person, never the token. A fault of this installation is never blamed on the token. */
export function onePasswordProblem(error) {
    if (error instanceof OnePasswordUnavailableError)
        return error.message;
    const name = error instanceof Error ? error.name : "";
    const text = error instanceof Error ? error.message : String(error);
    if (name === "RateLimitExceededError" || /rate limit/iu.test(text))
        return "1Password is limiting requests right now. Try again in a few minutes.";
    if (/invalid format|deserializ/iu.test(text))
        return ONE_PASSWORD_MALFORMED;
    if (name === "AuthExpiredError" || /invalid|unauthori[sz]ed|authenticat|service account token|forbidden|\b40[13]\b/iu.test(text))
        return ONE_PASSWORD_REFUSED;
    if (/fetch|network|ENOTFOUND|ECONN|timed? ?out|dns/iu.test(text))
        return "Could not reach 1Password. Check the internet connection and try again.";
    return "1Password could not be read. Try again, or connect it again with a new token.";
}
export class OnePasswordLogins {
    id = "1password";
    label = "1Password";
    token;
    connect;
    grants;
    itemGrants;
    now;
    client = null;
    entries = [];
    secrets = [];
    /** `<vault id>:<item id>` of items 1Password failed to read at the last load. */
    unreadable = new Set();
    vaults = [];
    itemCount = 0;
    refreshedAt = null;
    error;
    refreshing = null;
    lastUsed = new Map();
    constructor(options) {
        this.token = options.token;
        this.connect = options.connect;
        this.grants = options.grants ?? (() => ({}));
        this.itemGrants = options.itemGrants ?? (() => ({}));
        this.now = options.now ?? Date.now;
    }
    botsFor(vaultId) {
        return this.grants()[vaultId] ?? "all";
    }
    /** An item's own bots when it has them, else its vault's. */
    itemAccess(entry) {
        const item = onePasswordItemKey(entry.vaultId, entry.itemId);
        const own = this.itemGrants()[item];
        return { bots: own ?? this.botsFor(entry.vaultId), onePassword: { item, ownBots: own !== undefined } };
    }
    /** Whether the token reads this item (`<vault id>:<item id>`) as a login or a secret, looking again in 1Password before
     * saying no; null when 1Password could not be read just now, so an item not loaded yet is never taken for one that is gone. */
    async readsItem(item) {
        const loaded = () => this.refreshedAt !== null && !this.error;
        const reads = () => [...this.entries, ...this.secrets].some((entry) => onePasswordItemKey(entry.vaultId, entry.itemId) === item);
        if (!this.token())
            return false;
        const before = this.refreshedAt;
        await this.fresh();
        if (loaded() && reads())
            return true;
        // One more look, unless the stale check just took it.
        if (this.refreshedAt === before)
            await this.refresh();
        if (!this.token())
            return false;
        return loaded() && !this.unreadable.has(item) ? reads() : null;
    }
    connected() {
        const vaults = this.vaults.map((vault) => ({ ...vault, bots: this.botsFor(vault.id) }));
        return { connected: true, vaults, items: this.itemCount, ...(this.error ? { error: this.error } : {}) };
    }
    status() {
        return this.token() ? this.connected() : { connected: false };
    }
    hasVault(id) {
        return Boolean(this.token()) && this.vaults.some((vault) => vault.id === id);
    }
    async clientFor(token) {
        if (this.client?.token === token)
            return this.client.client;
        const client = await this.connect(token);
        this.client = { token, client };
        return client;
    }
    refresh(token) {
        if (!token && this.refreshing)
            return this.refreshing;
        const run = this.load(token).finally(() => { if (this.refreshing === run)
            this.refreshing = null; });
        if (!token)
            this.refreshing = run;
        return run;
    }
    async load(candidate) {
        const token = candidate ?? this.token();
        if (!token) {
            this.clear();
            return this.status();
        }
        try {
            const client = await this.clientFor(token);
            const vaults = await client.vaults();
            const entries = [];
            const secrets = [];
            const unreadable = new Set();
            const counted = [];
            for (const vault of vaults) {
                let items = 0;
                const listed = await client.items(vault.id);
                // Website logins and secret items come first, so Logins without a website never push one out of MAX_ITEMS.
                const wanted = [...listed.filter((item) => isLogin(item) || SECRET_CATEGORIES.has(item.category)),
                    ...listed.filter((item) => item.category === "Login" && !isLogin(item))].slice(0, MAX_ITEMS);
                for (let start = 0; start < wanted.length; start += FIELDS_BATCH) {
                    const batch = wanted.slice(start, start + FIELDS_BATCH);
                    // Every value in this answer is dropped here and read again when a bot uses it.
                    const contents = await client.contents(vault.id, batch.map((item) => item.id));
                    for (const item of batch) {
                        const content = contents.get(item.id);
                        if (content === null)
                            unreadable.add(onePasswordItemKey(vault.id, item.id));
                        if (!content)
                            continue;
                        const fields = secretValues(item.category, content);
                        if (fields.has(""))
                            secrets.push({ id: `${ID_PREFIX}${vault.id}:${item.id}`, vaultId: vault.id, itemId: item.id, category: item.category, name: item.title.trim() || item.category,
                                fields: [...fields.keys()].filter(Boolean) });
                        if (!isLogin(item))
                            continue;
                        const found = loginFields(content.fields);
                        if (!found.password)
                            continue;
                        items++;
                        for (const [site, hosts] of bySite(new Set(item.urls.flatMap((url) => normalizeLoginHost(url) ?? [])))) {
                            entries.push({ id: `${ID_PREFIX}${vault.id}:${item.id}:${site}`, vaultId: vault.id, itemId: item.id, site, hosts, exactHost: false,
                                username: found.username, hasTotp: Boolean(found.totp && parseTotpKey(found.totp)) });
                        }
                    }
                }
                counted.push({ id: vault.id, title: vault.title, items });
            }
            this.entries = entries.sort((a, b) => a.site.localeCompare(b.site) || a.username.localeCompare(b.username));
            this.secrets = secrets.sort((a, b) => a.name.localeCompare(b.name));
            this.unreadable = unreadable;
            this.vaults = counted.sort((a, b) => a.title.localeCompare(b.title));
            this.itemCount = counted.reduce((sum, vault) => sum + vault.items, 0);
            this.refreshedAt = this.now();
            this.error = undefined;
            return this.connected();
        }
        catch (error) {
            this.client = null;
            if (candidate)
                throw new Error(onePasswordProblem(error));
            this.error = onePasswordProblem(error);
            return this.status();
        }
    }
    clear() {
        this.client = null;
        this.entries = [];
        this.secrets = [];
        this.unreadable.clear();
        this.vaults = [];
        this.itemCount = 0;
        this.refreshedAt = null;
        this.error = undefined;
        this.lastUsed.clear();
    }
    async fresh() {
        if (!this.token())
            return;
        if (this.refreshedAt === null || this.now() - this.refreshedAt > STALE_MS)
            await this.refresh();
    }
    lastUsedOf(itemId) {
        const at = this.lastUsed.get(itemId);
        return at === undefined ? {} : { lastUsedAt: at };
    }
    items() {
        if (!this.token())
            return [];
        return [
            ...this.entries.map((entry) => ({
                kind: "login", id: entry.id, site: entry.site, hosts: [...entry.hosts], exactHost: false, username: entry.username, hasTotp: entry.hasTotp,
                source: "1password", ...this.itemAccess(entry), createdAt: 0, ...this.lastUsedOf(entry.itemId),
            })),
            ...this.secrets.map((entry) => ({
                kind: "secret", id: entry.id, name: entry.name, fields: [...entry.fields], source: "linked", provider: this.id, ...this.itemAccess(entry),
                readOnly: true, ...this.lastUsedOf(entry.itemId),
            })),
        ];
    }
    list() {
        return this.items().flatMap(({ kind, ...item }) => (kind === "login" ? [item] : []));
    }
    async contentOf(vaultId, itemId) {
        const token = this.token();
        if (!token)
            return undefined;
        try {
            const client = await this.clientFor(token);
            return (await client.contents(vaultId, [itemId])).get(itemId) ?? undefined;
        }
        catch (error) {
            this.client = null;
            throw new Error(onePasswordProblem(error));
        }
    }
    async read(itemId, field) {
        const login = this.entries.find((entry) => entry.id === itemId);
        if (login) {
            const content = await this.contentOf(login.vaultId, login.itemId);
            if (!content)
                return {};
            const found = loginFields(content.fields);
            return { password: found.password, totp: found.totp ? parseTotpKey(found.totp) : null };
        }
        const secret = this.secrets.find((entry) => entry.id === itemId);
        const content = secret && await this.contentOf(secret.vaultId, secret.itemId);
        if (!secret || !content)
            return {};
        const value = secretValues(secret.category, content).get(field ?? "");
        return value ? { value } : {};
    }
    markUsed(id) {
        const entry = this.entries.find((candidate) => candidate.id === id) ?? this.secrets.find((candidate) => candidate.id === id);
        if (entry)
            this.lastUsed.set(entry.itemId, this.now());
    }
}
