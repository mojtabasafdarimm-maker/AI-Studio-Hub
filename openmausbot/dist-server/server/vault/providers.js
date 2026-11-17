// A password manager linked to the Vault adds its items to the same list, by name and site only. A value is read from
// the manager at the moment a bot uses it, never kept or logged, and each item says which bots may use it.
import { loginMatchesHost, loginUsableBy } from "../../shared/logins.js";
import { vaultNameKey } from "../../shared/vault.js";
function logins(provider, bots) {
    return provider.items().flatMap(({ kind, ...item }) => (kind === "login" && loginUsableBy(item, bots) ? [item] : []));
}
export function linkedSites(provider, bots) {
    return logins(provider, bots).map((login) => ({ site: login.site, hosts: [...login.hosts], exactHost: login.exactHost, username: login.username }));
}
export function linkedCandidates(provider, pageHost, bots) {
    return logins(provider, bots).filter((login) => loginMatchesHost(login, pageHost)).map((login) => ({
        id: login.id, site: login.site, hosts: [...login.hosts], exactHost: login.exactHost, username: login.username, source: login.source,
        secrets: async () => {
            const { password, totp } = await provider.read(login.id);
            if (!password)
                throw new Error(`This login is no longer in ${provider.label}, or has no password there.`);
            return { password, totp: totp ?? null };
        },
    }));
}
export function linkedSecrets(provider, botId) {
    return provider.items().flatMap(({ kind, ...item }) => (kind === "secret" && (botId === undefined || loginUsableBy(item, botId)) ? [item] : []));
}
/** What a bot asks for a linked secret by: its name for the main value, "<name> <field>" for each other field. */
export function linkedSecretNames(secret) {
    return [{ name: secret.name }, ...secret.fields.map((field) => ({ name: `${secret.name} ${field}`, field }))];
}
export function findLinkedSecret(providers, name, botId) {
    const key = vaultNameKey(name);
    for (const provider of providers) {
        for (const secret of linkedSecrets(provider, botId)) {
            const found = linkedSecretNames(secret).find((one) => vaultNameKey(one.name) === key);
            if (found)
                return { provider, secret, ...(found.field ? { field: found.field } : {}) };
        }
    }
    return null;
}
export async function readLinkedSecret({ provider, secret, field }) {
    const { value } = await provider.read(secret.id, field);
    if (!value)
        throw new Error(`${secret.name} is no longer in ${provider.label}, or has no value there.`);
    provider.markUsed(secret.id);
    return value;
}
