// The order of a Team Cloud's bots is each person's own (`bot-orders.json`): a User's reorder changes only their list.
// Whoever has never ordered theirs sees the team's order, the one an Owner or Admin sets (the fleet's own order).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { reorderStable } from "../../shared/bot-order.js";
import { writeFileAtomic } from "../atomic.js";
import { personKey } from "../person-key.js";
const BOT_ORDERS_FILE = "bot-orders.json";
const fileSchema = z.object({ version: z.literal(1), orders: z.record(z.string(), z.array(z.string())) });
export function createPersonBotOrder(dataDir) {
    const file = join(dataDir, BOT_ORDERS_FILE);
    let orders = {};
    try {
        const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
        if (parsed.success)
            orders = parsed.data.orders;
        else
            console.warn(`bot orders: ${file} is not a bot orders file; starting fresh`);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            console.warn(`bot orders: ${file} is unreadable; starting fresh`);
    }
    const save = () => {
        try {
            writeFileAtomic(file, `${JSON.stringify({ version: 1, orders })}\n`, { mode: 0o600 });
        }
        catch (error) {
            console.warn(`bot orders: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    /** The team's bots as this person orders them: the bots they ordered keep their order among the places those bots hold
     * in the team's; a bot made since keeps its place in the team's. */
    function ordered(person, bots) {
        const own = orders[person];
        return own ? reorderStable(bots, own) : [...bots];
    }
    /** A `bots.order` frame as this person's own list; null when it is theirs as it is. */
    function ownOrderFrame(person, payload) {
        if (payload.kind !== "bots.order" || !orders[person] || !Array.isArray(payload.botIds))
            return null;
        const botIds = payload.botIds.filter((id) => typeof id === "string");
        const own = ordered(person, botIds.map((id) => ({ id }))).map((bot) => bot.id);
        return own.every((id, index) => id === botIds[index]) ? null : { ...payload, botIds: own };
    }
    return {
        ordered,
        /** A stable partial reorder of this person's own list (shared/bot-order.ts); the whole list is kept as theirs. */
        reorder(person, bots, botIds) {
            const next = reorderStable(ordered(person, bots), botIds);
            orders[person] = next.map((bot) => bot.id);
            save();
            return next;
        },
        ownOrderFrame,
        /** Whose own order a request reads and writes: a User's; null for an Owner's or Admin's, whose order is the team's. */
        personOf: (auth) => (auth.kind === "session" && !auth.scopes.includes("admin") ? personKey(auth.session) : null),
        /** A `bots.order` frame as a User's stream should get it; null when it goes as it is (an admin's stream included). */
        streamFrame(client, payload) {
            return client.person && !client.admin ? ownOrderFrame(personKey(client.person), payload) : null;
        },
        forgetPerson(person) {
            if (!orders[person])
                return;
            delete orders[person];
            save();
        },
    };
}
