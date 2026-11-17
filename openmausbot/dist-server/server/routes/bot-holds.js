import { z } from "zod";
import { PASS } from "./table.js";
const body = z.union([
    z.object({ kind: z.enum(["bot", "department"]), id: z.string().trim().min(1).max(200), paused: z.boolean() }).strict(),
    z.object({ kind: z.literal("all"), paused: z.boolean() }).strict(),
]);
/** What the admin activity log names an all-bots pause by. */
const ALL = { id: "all", name: "Every bot" };
export function createBotHoldRoutes(deps) {
    return async ({ req, res, path, method, auth, json, readBody }) => {
        if (path !== "/api/paused")
            return PASS;
        if (method === "GET")
            return void json(res, 200, { ...deps.holds.state(), heldBots: deps.holds.heldBots() });
        if (method !== "POST")
            return PASS;
        const parsed = body.safeParse(await readBody(req, 4_096).catch(() => null));
        if (!parsed.success)
            return void json(res, 400, { error: "Send kind (bot or department) with id, or kind all, and paused (true or false)." });
        const { kind, paused } = parsed.data;
        const id = parsed.data.kind === "all" ? ALL.id : parsed.data.id;
        const name = parsed.data.kind === "all" ? ALL.name : deps.named(parsed.data.kind, id);
        if (name === null)
            return void json(res, 404, { error: kind === "bot" ? "No such bot." : "No such department." });
        const { state, newlyHeld } = deps.holds.set(kind, id, paused);
        const stopped = paused && newlyHeld.length ? await deps.stop(newlyHeld) : 0;
        deps.audit({ kind, id, name, paused }, auth, req);
        json(res, 200, { ...state, heldBots: deps.holds.heldBots(), stopped });
    };
}
