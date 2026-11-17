import { userError } from "./user-errors.js";
export const TEAM_ROLES = ["owner", "admin", "member"];
export function isTeamRole(value) {
    return typeof value === "string" && TEAM_ROLES.includes(value);
}
/** Owners and Admins get the admin scope; a Member only the client scope (what a hosted member has). */
export function teamRoleScopes(role) {
    return role === "member" ? ["client"] : ["admin", "client"];
}
/** Membership is live on the Admin only, and the Admin checks it at each pairing. So a team session ends within the hour
 * of its pairing however much it is used, and the app pairs again: a removed member's next pairing is refused by the Admin. */
export const TEAM_SESSION_MAX_MS = 60 * 60_000;
export function teamSessionExpiresAt(createdAt, proposed) {
    return Math.min(proposed, createdAt + TEAM_SESSION_MAX_MS);
}
/** The pairing body's `member` is one printable-ASCII address and one of the three roles; a `team` claim, when present,
 * must name this team. */
const MEMBER_EMAIL = /^[!-;=?A-~]{1,64}@[!-;=?A-~]{1,189}$/;
/** A member's address as a claim carries it (printable ASCII), lowercased; null for anything else. */
export function teamMemberEmail(value) {
    return typeof value === "string" && value.length <= 254 && MEMBER_EMAIL.test(value) ? value.trim().toLowerCase() : null;
}
export function parseMemberClaim(body, team) {
    const claimedTeam = body.team;
    if (claimedTeam !== undefined) {
        if (!claimedTeam || typeof claimedTeam !== "object" || Array.isArray(claimedTeam))
            return { ok: false, error: "team_mismatch" };
        if (claimedTeam.id !== team.id)
            return { ok: false, error: "team_mismatch" };
    }
    const member = body.member;
    if (member === undefined)
        return { ok: false, error: "member_required" };
    if (!member || typeof member !== "object" || Array.isArray(member))
        return { ok: false, error: "invalid_member" };
    const { email, role } = member;
    if (typeof email !== "string" || email.length > 254 || !MEMBER_EMAIL.test(email) || !isTeamRole(role))
        return { ok: false, error: "invalid_member" };
    return { ok: true, member: { email: email.trim().toLowerCase(), role } };
}
/** A member's own connection (a Composio share, an MCP sign-in, a mailbox) has no path into a team. */
export function personalConnectionRefusal(team, what = "it") {
    return `Personal connections never enter ${team.name}. Ask an admin to connect ${what} for ${team.name}.`;
}
/** A computer's one-time move goes to its owner's My Cloud only: nothing personal is carried into a team. */
export function personalMoveRefusal(team) {
    return userError("serverError.team.personalMove", { team: team.name });
}
/** On a team a login belongs to the whole team, so only an admin saves one. */
export function memberLoginRefusal(team) {
    return userError("serverError.team.memberLogin", { team: team.name });
}
