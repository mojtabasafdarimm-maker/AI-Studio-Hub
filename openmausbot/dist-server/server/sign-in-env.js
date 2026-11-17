// Who may sign in with an emailed code can come from the environment (OMB_SIGNIN_EMAILS for admins,
// OMB_SIGNIN_MEMBER_EMAILS for members) instead of Settings. A list the environment names wins while the server runs.
// A variable that is set but names nobody leaves Settings in charge: Compose files pass `${OMB_SIGNIN_EMAILS:-}`, which
// is an empty string, not an absent variable, whenever .env does not set it.
export const SIGN_IN_ENV = { admins: "OMB_SIGNIN_EMAILS", members: "OMB_SIGNIN_MEMBER_EMAILS" };
export function splitEmails(value) {
    return value.split(/[,\s]+/).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}
/** The lists the environment decides: only those whose variable names at least one address. */
export function signInFromEnv(env = process.env) {
    const lists = {};
    for (const list of ["admins", "members"]) {
        const named = splitEmails(env[SIGN_IN_ENV[list]] ?? "");
        if (named.length)
            lists[list] = named;
    }
    return lists;
}
/** Why a Settings change to the sign-in lists cannot take effect, or null. A list sent as the environment has it is
 * no change (Settings sends both lists whenever it changes one). */
export function signInEnvRefusal(asked, env = process.env) {
    if (!asked)
        return null;
    const pinned = signInFromEnv(env);
    const same = (a, b) => [...new Set(a)].sort().join(",") === [...new Set(b)].sort().join(",");
    for (const list of ["admins", "members"]) {
        const wanted = asked[list];
        const fixed = pinned[list];
        if (wanted === undefined || fixed === undefined || same(splitEmails(wanted.join(",")), fixed))
            continue;
        const name = SIGN_IN_ENV[list];
        return `${name} is set where this server starts (its .env), and it decides who may sign in ${list === "admins" ? "as an admin" : "as a member"}, so this change would not take effect. Change ${name} there, or remove it to manage this list here.`;
    }
    return null;
}
