export const ACCOUNT_ALIAS_REQUIRED = "Add an account alias so the existing connection is not replaced";
const USABLE = /^(active|initiated|initializing|pending)$/i;
const mayBeActive = (account) => !account.id || !account.status || /^active$/i.test(account.status);
/** How the next sign-in link for one toolkit is made. A label is required only beside a working account; an account
 *  that never finished or stopped working gives its label up, and is removed (`replace`) before the link is made. */
export function planAccountLink(toolkit, accounts, alias, maxAccounts, retryAlias) {
    const sameAlias = alias ? accounts.filter((account) => account.alias?.trim().toLowerCase() === alias.toLowerCase()) : [];
    if (sameAlias.some(mayBeActive))
        return { ok: false, status: 409, error: `Account alias "${alias}" is already in use for ${toolkit}` };
    const replace = sameAlias.flatMap((account) => account.id ? [account.id] : []);
    const usable = accounts.filter((account) => !sameAlias.includes(account) && USABLE.test(account.status ?? ""));
    if (usable.length >= maxAccounts) {
        return { ok: false, status: 409, error: `${toolkit} already has the maximum of ${maxAccounts} accounts` };
    }
    if (alias || !accounts.length)
        return { ok: true, alias, replace };
    if (accounts.some(mayBeActive))
        return { ok: false, status: 400, error: ACCOUNT_ALIAS_REQUIRED };
    return { ok: true, alias: retryAlias(), replace };
}
