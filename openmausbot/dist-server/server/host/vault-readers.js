// Whose saved secrets a turn and a Settings session reach. On a Team Cloud a secret a member typed into a card in their
// own private chat is theirs alone: no other member's chat, shared chat, group chat or routine reaches it, and no admin
// sees it. Off a Team Cloud every secret is the install's, as it always was.
import { audienceMember } from "../audience.js";
import { TEAM_READER } from "../vault-store.js";
export function createVaultReaders(deps) {
    return {
        /** A turn in this conversation: the team's secrets, and the person's own whose private chat it is. */
        turn(threadId) {
            return deps.team ? { person: audienceMember(deps.audienceOf(threadId)), team: true } : TEAM_READER;
        },
        /** Settings → Vault: an admin sees the team's (and on a team their own), anyone else only their own. */
        viewer(auth) {
            return { person: deps.team && auth.kind === "session" ? deps.personOf(auth) : null, team: auth.scopes.includes("admin") };
        },
    };
}
