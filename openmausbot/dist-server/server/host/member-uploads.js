// Who uploaded a file to attachments/: the file's uploader alone may discard it before it is sent, and on a Team Cloud a
// member's uploads are kept in people/<person>/uploads.json, so the ones nothing uses go when they leave.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic.js";
import { personKey } from "../person-key.js";
const UPLOADS = "uploads.json";
const MAX_UPLOADS = 5_000;
const MAX_RECENT = 1_000;
const uploadsFile = (dataDir, person) => join(dataDir, "people", person, UPLOADS);
export function memberUploads(dataDir, person) {
    try {
        const names = JSON.parse(readFileSync(uploadsFile(dataDir, person), "utf8"));
        return Array.isArray(names) ? names.filter((name) => typeof name === "string") : [];
    }
    catch {
        return [];
    }
}
/** `member`: the uploader's person key when they are a Team Cloud member, so their uploads are remembered past a restart. */
export function createUploadOwners(dataDir) {
    const recent = new Map();
    return {
        note(uploader, name, member) {
            recent.delete(name);
            recent.set(name, uploader);
            if (recent.size > MAX_RECENT)
                recent.delete(recent.keys().next().value);
            if (!member)
                return;
            const names = memberUploads(dataDir, member).filter((known) => known !== name);
            mkdirSync(join(dataDir, "people", member), { recursive: true, mode: 0o700 });
            writeFileAtomic(uploadsFile(dataDir, member), JSON.stringify([...names, name].slice(-MAX_UPLOADS)), { mode: 0o600 });
        },
        owns(uploader, name, member) {
            return recent.get(name) === uploader || Boolean(member && memberUploads(dataDir, member).includes(name));
        },
    };
}
/** The thread routes' `uploads` (server/routes/threads.ts): a session's uploader is its person, a paired phone's is that
 * phone, anything else "local"; on a Team Cloud (`team`) a member's are remembered past a restart. */
export function uploadsFor(owners, team) {
    const uploaderOf = (auth) => auth.kind === "session" ? personKey(auth.session)
        : auth.companionDevice ? `companion:${auth.companionDevice}` : "local";
    const teamMemberOf = (auth) => team && auth.kind === "session" && auth.session.membershipAuthority === "team" ? personKey(auth.session) : undefined;
    return {
        note: (auth, name) => owners.note(uploaderOf(auth), name, teamMemberOf(auth)),
        owns: (auth, name) => owners.owns(uploaderOf(auth), name, teamMemberOf(auth)),
    };
}
