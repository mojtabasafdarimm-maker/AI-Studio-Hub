import { PASS } from "./table.js";
/** The fleet's order is one list every client shows (the desktop sidebar, a phone's roster); on a Team Cloud it is the
 * team's, and a User's own list is theirs. A reorder names only the bots it moves (shared/bot-order.ts); the rest keep
 * their places. */
export function createBotOrderRoutes(deps) {
    const { store, visibleFor } = deps;
    return async ({ req, res, path, method, auth, json, readBody }) => {
        if (path !== "/api/bots/order" || method !== "PUT")
            return PASS;
        const body = await readBody(req);
        const botIds = body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every((key) => key === "botIds")
            ? body.botIds : undefined;
        if (!Array.isArray(botIds) || !botIds.length || botIds.some((id) => typeof id !== "string" || !id) || new Set(botIds).size !== botIds.length) {
            return json(res, 400, { error: "botIds must be a non-empty array of distinct bot ids" });
        }
        // A restricted viewer gets the same answer for a hidden bot as for a missing one, so the id list cannot probe the fleet.
        const visible = visibleFor(auth);
        for (const id of botIds) {
            if (!store.bot(id) || !visible.bot(id))
                return json(res, 400, { error: `unknown bot: ${id}` });
        }
        const person = deps.own?.person(auth) ?? null;
        const bots = person ? deps.own.order.reorder(person, store.bots, botIds) : store.reorderBots(botIds);
        if (!bots)
            return json(res, 400, { error: "botIds must be a non-empty array of distinct bot ids" });
        const shown = bots.filter((bot) => visible.bot(bot.id)).map((bot) => bot.id);
        if (person)
            deps.own.told(person, shown);
        return json(res, 200, { botIds: shown });
    };
}
