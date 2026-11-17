// A Team Cloud's browsers follow the audience rule (server/audience.ts): a member's private conversations with a bot use
// that member's own browser, a group chat's turns the group chat's, and the team's conversations the bot's own. Each is a
// separate browser with its own profile, saved sign-ins and live view, so a page one member signed in to never opens in
// another member's turn. Off a team every audience is the team's, and a browser keeps the name it always had.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { audienceMember, audienceRoom } from "../audience.js";
const SUFFIX = /^--(?:room|member)-[0-9a-f]{16}$/;
/** What an audience adds to the name of a bot's browser, or of a shared profile: nothing for the team's, else a fixed
 * 23 or 25 characters. agent-browser 0.37 keeps each session's socket at ~/.agent-browser/<session>.sock and refuses a
 * path over 103 bytes, which a bot's id plus a group chat's whole id would pass on a Cloud home. */
export function audienceBrowserSuffix(audience) {
    if (audience === "team")
        return "";
    const room = audienceRoom(audience);
    const id = room ?? audienceMember(audience);
    return `--${room !== null ? "room" : "member"}-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
}
/** The audience suffixes this server has given a browser, kept on disk so a deleted bot's or profile's browsers are erased
 * for every audience, after a restart too. */
export class AudienceBrowsers {
    #file;
    #suffixes = null;
    constructor(file) {
        this.#file = file;
    }
    #load() {
        if (this.#suffixes)
            return this.#suffixes;
        let saved = null;
        try {
            saved = JSON.parse(readFileSync(this.#file, "utf8"));
        }
        catch { }
        const list = saved && typeof saved === "object" && Array.isArray(saved.suffixes) ? saved.suffixes : [];
        this.#suffixes = new Set(list.filter((entry) => typeof entry === "string" && SUFFIX.test(entry)));
        return this.#suffixes;
    }
    /** Remembers a suffix the first time a browser is named with it. */
    note(suffix) {
        if (!suffix)
            return;
        if (!SUFFIX.test(suffix))
            throw new Error("Not an audience browser suffix.");
        const suffixes = this.#load();
        if (suffixes.has(suffix))
            return;
        suffixes.add(suffix);
        mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
        const temporary = `${this.#file}.${process.pid}.tmp`;
        writeFileSync(temporary, `${JSON.stringify({ suffixes: [...suffixes] })}\n`, { mode: 0o600 });
        renameSync(temporary, this.#file);
    }
    /** The team's (none) and every audience's suffix seen so far. */
    variants() {
        return ["", ...this.#load()];
    }
}
