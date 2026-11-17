// What a Team Cloud tells one signed-in person about joining it (openmaus-cloud docs/team-cloud.md "Getting an invited
// person in"): their own welcome record inside the onboarding record, and their team page on MausBot Cloud, where they open
// the team in a browser again. Told to a signed-in session only, never before sign-in.
import { personalHints } from "../../shared/cloud-hints.js";
import { personKey } from "../person-key.js";
/** The onboarding record this person reads on a team: the welcome's own hints are theirs (shared/cloud-hints.ts). */
export function teamOnboarding(onboarding, session, welcome) {
    return { ...onboarding, hintsSeen: personalHints(onboarding.hintsSeen, session ? welcome.read(personKey(session)).hints : [], session?.teamRole === "owner") };
}
/** `/api/auth/session`'s `teamSignIn` for a team session: the person's team page on MausBot Cloud. An address, nothing that
 * signs anyone in; the app keeps it so a page whose session ended can offer the way back. */
export function teamSignInFor(cloudHome, session) {
    return cloudHome?.team && session.membershipAuthority === "team" ? { teamSignIn: `${cloudHome.adminOrigin}/cloud/team/${encodeURIComponent(cloudHome.team.id)}` } : {};
}
