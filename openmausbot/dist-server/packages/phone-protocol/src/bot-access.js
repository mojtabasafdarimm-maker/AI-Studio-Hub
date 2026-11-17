export const BOT_ACCESS_LEVELS = ["none", "view", "chat", "edit"];
export const GRANTED_LEVELS = ["view", "chat", "edit"];
export const levelRank = (level) => BOT_ACCESS_LEVELS.indexOf(level ?? "none");
export const atLeast = (level, wanted) => levelRank(level) >= levelRank(wanted);
export const higherLevel = (a, b) => (atLeast(a, b) ? a : b);
export const isAccessLevel = (value) => BOT_ACCESS_LEVELS.includes(value);
/** A bot nobody set sharing for: what its older visibility setting meant. Everyone could chat with an everyone bot, the
 * listed people with a listed one, and only admins (who edit every bot) with an admins-only one. */
export function accessFromVisibility(visibility) {
    if (visibility === undefined || visibility === "everyone")
        return { everyone: "chat", people: {} };
    if (visibility === "admins")
        return { everyone: "none", people: {} };
    return { everyone: "none", people: Object.fromEntries(visibility.people.map((entry) => [entry.trim().toLowerCase(), "chat"])) };
}
/** Who sees the bot at all: everyone when every member may at least view it, else its owner and the people added, else
 * admins only. */
export function visibilityFromAccess(access, owner) {
    if (access.everyone !== "none")
        return "everyone";
    const people = [...new Set([...(owner ? [owner] : []), ...Object.keys(access.people)])];
    return people.length ? { people } : "admins";
}
export function entryMatches(entry, email) {
    return entry.startsWith("@") ? email.endsWith(entry) && email.length > entry.length : entry === email;
}
/** What this address may do by the bot's sharing alone, before admins and the owner. */
export function sharedLevel(access, email) {
    const address = email.trim().toLowerCase();
    let level = access.everyone;
    if (!address)
        return level;
    for (const [entry, granted] of Object.entries(access.people))
        if (entryMatches(entry, address))
            level = higherLevel(level, granted);
    return level;
}
export function sameAccess(a, b) {
    const left = Object.entries(a.people), right = b.people;
    return a.everyone === b.everyone && left.length === Object.keys(right).length && left.every(([entry, level]) => right[entry] === level);
}
export const ACCESS_REQUEST_OPTIONS = ["Allow", "Not now"];
