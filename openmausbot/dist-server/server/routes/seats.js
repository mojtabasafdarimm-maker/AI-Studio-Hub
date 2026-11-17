import { PASS } from "./table.js";
/**
 * People, not devices: each address on the sign-in list, and each address that holds a session (someone let in by an
 * `@domain` entry counts once they have signed in). Devices paired by code carry no address: they count as one person,
 * the server's owner, unless the owner is known by an address already (an admin on the list, or an admin session
 * with an address). The owner paired by code with a member on the list is two people, not one. API tokens are not people.
 */
export function seatCount(list, sessions) {
    const people = new Set();
    for (const entry of [...list.admins, ...list.members])
        if (!entry.startsWith("@"))
            people.add(entry.trim().toLowerCase());
    let paired = false;
    let ownerKnown = list.admins.some((entry) => !entry.startsWith("@"));
    for (const session of sessions) {
        if (session.token)
            continue;
        if (session.email) {
            people.add(session.email.trim().toLowerCase());
            if (session.scopes?.includes("admin"))
                ownerKnown = true;
        }
        else
            paired = true;
    }
    return people.size + (paired && !ownerKnown ? 1 : 0);
}
export function createSeatsRoutes(deps) {
    return async ({ res, path, method, json }) => {
        if (path !== "/api/seats" || method !== "GET")
            return PASS;
        return json(res, 200, { seats: seatCount(deps.signInList(), deps.sessions()) });
    };
}
