// A Team Cloud's bot has no AI to answer with. A User can't connect one, so they read who can, and the team's owner hears
// about it in their inbox: at most once a day for each person. Someone who pressed Send before the owner ever opened the
// team is kept in no-ai-notices.json and passed on when the owner first does. The person's words never travel: their
// message stays in their own box.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { nameFromEmail } from "../../shared/bot-owner.js";
import { writeFileAtomic } from "../atomic.js";
import { personKey } from "../person-key.js";
import { serverLine } from "../server-lines.js";
import { teamAiOwner } from "./team-ai-owner.js";
export const NO_AI_NOTICES_FILE = "no-ai-notices.json";
const DAY_MS = 24 * 60 * 60_000;
const MAX_WAITING = 50;
const fileSchema = z.object({ version: z.literal(1), told: z.record(z.string(), z.number()), waiting: z.array(z.string().min(3).max(254)).max(MAX_WAITING) });
export function createNoAiNotice(deps) {
    const now = deps.now ?? Date.now;
    const file = join(deps.dataDir, NO_AI_NOTICES_FILE);
    const keyOf = (email) => personKey({ id: "", email });
    const nameOf = (email) => {
        const chosen = deps.personName(keyOf(email))?.trim();
        return chosen && chosen !== email ? chosen : nameFromEmail(email);
    };
    let told = {};
    let waiting = [];
    if (deps.team) {
        try {
            const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
            if (parsed.success)
                ({ told, waiting } = parsed.data);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                console.warn(`no-AI notices: ${file} is unreadable; starting fresh`);
        }
    }
    const save = () => {
        try {
            writeFileAtomic(file, `${JSON.stringify({ version: 1, told, waiting })}\n`, { mode: 0o600 });
        }
        catch (error) {
            console.warn(`no-AI notices: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    /** One inbox line to the owner saying who is waiting; false when the owner can't be reached here yet. */
    function tellOwner(asker) {
        const owner = teamAiOwner(deps.people(), deps.personName);
        if (!owner)
            return false;
        const ownerKey = keyOf(owner.email), language = deps.language(ownerKey), name = nameOf(asker);
        return Boolean(deps.inbox().deliver(ownerKey, {
            kind: "notice", from: { name, email: asker }, notify: "mention",
            title: serverLine(language, "server.noAi.ownerTitle", { team: deps.team.name }),
            text: serverLine(language, "server.noAi.ownerLine", { name, team: deps.team.name }),
        }));
    }
    /** Whoever pressed Send before the owner opened the team is passed on as soon as the owner can be told. */
    function flush() {
        if (!waiting.length)
            return;
        const still = waiting.filter((asker) => !tellOwner(asker));
        if (still.length === waiting.length)
            return;
        for (const asker of waiting)
            if (!still.includes(asker))
                told[keyOf(asker)] = now();
        waiting = still;
        save();
    }
    return {
        /** The refusal for a turn that has no AI on a team, in the words of the conversation's language; null off a team. */
        refusal(threadId, sender, instanceId) {
            if (!deps.team || instanceId)
                return null;
            const language = deps.threadLanguage(threadId);
            const refused = (line) => Object.assign(new Error(line), { status: 409, code: "no_ai" });
            const asker = sender?.id ? deps.people().find((person) => keyOf(person.email) === sender.id) : undefined;
            if (!asker)
                return refused(serverLine(language, "server.noAi.nobodyHere"));
            if (asker.role !== "member")
                return refused(serverLine(language, "server.noAi.admin"));
            const owner = teamAiOwner(deps.people(), deps.personName);
            const key = keyOf(asker.email), last = told[key], recently = last !== undefined && now() - last < DAY_MS;
            if (owner && (recently || tellOwner(asker.email))) {
                if (!recently) {
                    told[key] = now();
                    save();
                }
                return refused(serverLine(language, "server.noAi.member", { owner: owner.name }));
            }
            if (!waiting.includes(asker.email) && waiting.length < MAX_WAITING) {
                waiting = [...waiting, asker.email];
                save();
            }
            return refused(serverLine(language, "server.noAi.memberNoOwner"));
        },
        flush,
    };
}
