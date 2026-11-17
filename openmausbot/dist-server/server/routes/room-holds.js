// POST /api/groups/<room>/holds {botId, held}: holding a member mid-turn ends that member's turn only.
import { z } from "zod";
import { PASS } from "./table.js";
const HOLDS = /^\/api\/groups\/([\w-]+)\/holds$/u;
const BODY = z.object({ botId: z.string().regex(/^[\w-]+$/), held: z.boolean() }).strict();
export function createRoomHoldRoutes(deps) {
    return async ({ req, res, path, method, auth, json, readBody }) => {
        const m = HOLDS.exec(path);
        if (!m || method !== "POST")
            return PASS;
        const parsed = BODY.safeParse(await readBody(req));
        if (!parsed.success)
            return json(res, 400, { error: 'body must be {"botId": "<room member id>", "held": true}' });
        const group = deps.group(m[1]);
        if (!group)
            return json(res, 404, { error: "no such room" });
        if (group.dm)
            return json(res, 400, { error: "members of a bot-to-bot channel cannot be held" });
        if (!group.memberIds.includes(parsed.data.botId))
            return json(res, 404, { error: "that bot is not a member of this room" });
        const updated = deps.setHold(m[1], parsed.data.botId, parsed.data.held);
        if (!updated)
            return json(res, 404, { error: "no such room" });
        return json(res, 200, { ok: true, group: deps.groupFor?.(auth, updated) ?? updated });
    };
}
