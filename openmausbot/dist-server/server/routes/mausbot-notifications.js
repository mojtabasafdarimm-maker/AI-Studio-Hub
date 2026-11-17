import { listUnread, markRead } from "../mausbot-notifications.js";
import { markNotificationLogRead, recentNotificationLog } from "../message-db.js";
import { PASS } from "./table.js";
const LIST = "/api/internal/notifications";
const READ = "/api/internal/notifications/read";
export function createMausBotNotificationRoutes(deps) {
    const host = "recent" in deps ? deps : {
        bot: deps.bot,
        team: deps.team,
        recent: () => recentNotificationLog(),
        markRead: markNotificationLogRead,
        announceRead: (threadId, ids) => deps.broadcast({ kind: "notifications.read", threadId, ids }),
        now: Date.now,
    };
    return async (ctx) => {
        if (!((ctx.method === "GET" && ctx.path === LIST) || (ctx.method === "POST" && ctx.path === READ)))
            return PASS;
        let result;
        if (ctx.path === LIST)
            result = listUnread(host, ctx.botId);
        else {
            const body = await ctx.readBody();
            result = markRead(host, ctx.botId, body && typeof body === "object" ? body.ids : undefined);
        }
        if (result.ok)
            return void ctx.json(ctx.res, 200, { text: result.text });
        return void ctx.json(ctx.res, result.error.startsWith("Only MausBot") ? 403 : 400, { error: result.error });
    };
}
