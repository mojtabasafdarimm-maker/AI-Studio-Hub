import { phonePairingLink } from "../../shared/pairing-link.js";
import { teamRoleScopes } from "../cloud-team.js";
import { formatPairingCode } from "../sessions.js";
import { userError } from "../user-errors.js";
import { PASS } from "./table.js";
export const TEAM_PHONE_PAIRING_PATH = "/api/team/phone-pairing";
export const TEAM_PHONES_PATH = "/api/team/phones";
const PHONE_LABEL = "Phone";
const ONE_PHONE = /^\/api\/team\/phones\/([\w-]{1,128})$/;
/** The member a team session was opened for, and when the Admin last vouched for them; null for any other session. */
export function sessionMember(session) {
    if (session.membershipAuthority !== "team" || !session.email || !session.teamRole)
        return null;
    return { member: { email: session.email, role: session.teamRole }, checkedAt: session.memberCheckedAt ?? session.createdAt };
}
/** The phones `viewer` may see and remove: an owner's or admin's, everyone's; a member's, their own. */
export function visiblePhones(phones, viewer, scopes) {
    const everyone = viewer.role !== "member" && scopes.includes("admin");
    return phones
        .filter((phone) => phone.email !== undefined && (everyone || phone.email === viewer.email))
        .map(({ id, label, email, createdAt, lastSeenAt, expiresAt }) => ({ id, label, email, createdAt, lastSeenAt, expiresAt }))
        .sort((a, b) => a.email.localeCompare(b.email) || a.createdAt - b.createdAt);
}
export function createTeamPhoneRoutes(deps) {
    return async (ctx) => {
        const one = ctx.method === "DELETE" ? ONE_PHONE.exec(ctx.path) : null;
        if (one || (ctx.method === "GET" && ctx.path === TEAM_PHONES_PATH))
            return phones(deps, ctx, one?.[1] ?? null);
        return pairing(deps, ctx);
    };
}
async function phones(deps, { res, auth, json }, removing) {
    const team = deps.team;
    if (!team)
        return PASS;
    const viewer = auth.kind === "session" ? sessionMember(auth.session) : null;
    if (!viewer || auth.kind !== "session")
        return json(res, 403, userError("serverError.team.signInFirst", { team: team.name }));
    const listed = visiblePhones(deps.sessions.memberPhones(), viewer.member, auth.scopes);
    if (removing === null)
        return json(res, 200, { phones: listed, current: auth.session.id });
    if (!listed.some((phone) => phone.id === removing) || !deps.sessions.revoke(removing))
        return json(res, 404, userError("serverError.team.noSuchPhone"));
    return json(res, 200, { ok: true });
}
async function pairing(deps, { req, res, path, method, auth, json }) {
    if (method !== "POST" || (path !== TEAM_PHONE_PAIRING_PATH && path !== "/api/auth/pairing"))
        return PASS;
    const team = deps.team;
    if (!team)
        return PASS;
    const owner = auth.kind === "session" ? sessionMember(auth.session) : null;
    if (!owner || auth.kind !== "session") {
        return path === TEAM_PHONE_PAIRING_PATH ? json(res, 403, userError("serverError.team.signInFirst", { team: team.name })) : PASS;
    }
    if (!deps.sessions.isLive(auth.session.id))
        return json(res, 401, userError("serverError.team.sessionEnded"));
    const scopes = teamRoleScopes(owner.member.role).filter((scope) => auth.scopes.includes(scope));
    if (!scopes.length)
        return json(res, 403, userError("serverError.team.signInFirst", { team: team.name }));
    const opened = deps.sessions.openPairing({ scopes, label: PHONE_LABEL, member: owner.member, memberCheckedAt: owner.checkedAt });
    const base = deps.publicBase(req, auth);
    const code = formatPairingCode(opened.code);
    return json(res, 200, {
        id: opened.id,
        code,
        credential: opened.credential,
        expiresAt: opened.expiresAt,
        url: base ? `${base}/pair#code=${code}` : null,
        inviteUrl: base ? phonePairingLink({ address: base, token: opened.credential, name: team.name }) : null,
        serverName: team.name,
        team: { id: team.id, name: team.name, role: owner.member.role },
        hint: base ? null : "this server has no public address to put in a link: set OMB_PUBLIC_URL, or open /pair on the address you use and type the code",
    });
}
