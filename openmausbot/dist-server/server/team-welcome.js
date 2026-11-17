// A person's first screen on a Team Cloud, kept for that person alone (people/<person>/welcome.json): who invited them (the
// Admin's signed claim, `member.invitedBy`), when they saw the welcome, and which of the welcome's steps they finished. Each
// is that person's own, so one admin finishing the welcome ends it for nobody else. A member who leaves takes it with them
// (people/<person>/ goes whole), and no backup carries it.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.js";
import { teamMemberEmail } from "./cloud-team.js";
const PERSON = /^p_[\w-]{22}$/;
/** A welcome step's id, as the app's onboarding hints are written. */
export const WELCOME_HINT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_HINTS = 64;
const record = z.object({
    version: z.literal(1),
    invitedBy: z.string().max(254).optional(),
    welcomedAt: z.number().int().positive().optional(),
    hints: z.array(z.string().regex(WELCOME_HINT)).max(MAX_HINTS).optional(),
});
export function createTeamWelcomeStore(dataDir) {
    const file = (person) => {
        if (!PERSON.test(person))
            throw new Error("not a person key");
        return join(dataDir, "people", person, "welcome.json");
    };
    const load = (person) => {
        try {
            const path = file(person);
            return existsSync(path) ? record.parse(JSON.parse(readFileSync(path, "utf8"))) : { version: 1 };
        }
        catch {
            return { version: 1 };
        }
    };
    const write = (person, next) => {
        mkdirSync(join(dataDir, "people", person), { recursive: true, mode: 0o700 });
        writeFileAtomic(file(person), `${JSON.stringify(next)}\n`, { mode: 0o600 });
    };
    const view = (kept) => ({ invitedBy: kept.invitedBy ?? null, welcomedAt: kept.welcomedAt ?? null, hints: kept.hints ?? [] });
    return {
        read: (person) => view(load(person)),
        invited(person, by) {
            const address = teamMemberEmail(by), kept = load(person);
            if (!address || kept.invitedBy)
                return;
            write(person, { ...kept, invitedBy: address });
        },
        save(person, change, now = Date.now()) {
            const kept = load(person);
            const hints = [...new Set([...(kept.hints ?? []), ...(change.hints ?? []).filter((hint) => WELCOME_HINT.test(hint))])].slice(0, MAX_HINTS);
            const next = { ...kept, ...(change.welcomed && !kept.welcomedAt ? { welcomedAt: now } : {}), ...(hints.length ? { hints } : {}) };
            if (JSON.stringify(next) !== JSON.stringify(kept))
                write(person, next);
            return view(next);
        },
    };
}
