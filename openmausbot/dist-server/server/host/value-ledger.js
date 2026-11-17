// What the Chief did for the person, counted when it happens: emails it sorted, replies it drafted, meetings it prepared.
// Counts and times only, in value.json, so the recap, the morning brief's first line and the Admin's health report say
// only what really happened.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.js";
const DAY = 24 * 60 * 60_000;
const KEEP_MS = 14 * DAY;
const MAX_EVENTS = 2_000;
export const VALUE_FILE = "value.json";
export const VALUE_KINDS = ["sorted", "drafted", "prepped"];
/** The minutes each piece of work would have taken the person, kept low on purpose: reading and sorting one email,
 * writing one reply, preparing for one meeting, doing one routine's job by hand. */
export const MINUTES_EACH = { sorted: 1, drafted: 5, prepped: 10, routines: 3 };
const count = z.number().int().nonnegative().max(1_000_000_000);
const fileSchema = z.object({
    version: z.literal(1),
    totals: z.object({ sorted: count, drafted: count, prepped: count }),
    events: z.array(z.object({ at: z.number().finite().nonnegative(), kind: z.enum(VALUE_KINDS), n: count })).max(MAX_EVENTS),
});
const none = () => ({ sorted: 0, drafted: 0, prepped: 0 });
export function valueReport(tally) {
    return { ...tally, minutes: minutesSaved(tally) };
}
export function minutesSaved(tally) {
    return Object.keys(MINUTES_EACH).reduce((sum, kind) => sum + tally[kind] * MINUTES_EACH[kind], 0);
}
export const anyValue = (tally) => VALUE_KINDS.some((kind) => tally[kind] > 0) || (tally.routines ?? 0) > 0;
export function createValueLedger(deps) {
    const now = deps.now ?? Date.now;
    const file = join(deps.dataDir, VALUE_FILE);
    let state = { version: 1, totals: none(), events: [] };
    try {
        const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
        if (parsed.success)
            state = parsed.data;
        else
            console.warn(`value: ${file} is not a value file; starting fresh`);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            console.warn(`value: ${file} is unreadable; starting fresh`);
    }
    const save = () => {
        try {
            writeFileAtomic(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
        }
        catch (error) {
            console.warn(`value: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    return {
        add(kind, n = 1) {
            if (!Number.isSafeInteger(n) || n <= 0)
                return;
            const at = now();
            state.totals[kind] += n;
            state.events = [...state.events.filter((event) => at - event.at <= KEEP_MS), { at, kind, n }].slice(-MAX_EVENTS);
            save();
        },
        totals: () => ({ ...state.totals }),
        /** What was done from `at` on, within the last two weeks. */
        since(at) {
            const counts = none();
            for (const event of state.events)
                if (event.at >= at)
                    counts[event.kind] += event.n;
            return counts;
        },
    };
}
