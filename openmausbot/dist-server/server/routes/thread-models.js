import { sameModelSelection } from "../../shared/thread-model.js";
import { PASS } from "./table.js";
const MAX_THREAD_IDS = 10_000;
export function createThreadModelRoutes(deps) {
    return async ({ req, res, path, method, auth, json, readBody }) => {
        const m = path.match(/^\/api\/bots\/([\w-]+)\/threads\/follow-model$/);
        if (!m || method !== "POST")
            return PASS;
        const bot = deps.bot(m[1]);
        if (!bot)
            return json(res, 404, { error: "no such bot" });
        if (!deps.mayChangeModel(auth))
            return json(res, 403, { error: "On this Cloud only its owner can change a bot's model." });
        const body = await readBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "threadIds")) {
            return json(res, 400, { error: "send {} or { threadIds }" });
        }
        const raw = body.threadIds;
        if (raw !== undefined && (!Array.isArray(raw) || raw.length > MAX_THREAD_IDS || raw.some((id) => typeof id !== "string"))) {
            return json(res, 400, { error: "threadIds must be a list of this bot's thread ids" });
        }
        const tasks = bot.tasks ?? [];
        const ids = new Set(tasks.map((task) => task.threadId));
        const foreign = raw?.find((id) => !ids.has(id));
        if (foreign !== undefined)
            return json(res, 400, { error: `"${foreign}" is not one of this bot's threads` });
        if (bot.approvalGrant)
            return json(res, 409, { error: "wait for the approval-level change to finish before changing models" });
        const listed = raw === undefined ? null : new Set(raw);
        const own = tasks.filter((task) => (!listed || listed.has(task.threadId)) &&
            task.modelSelection !== undefined && !sameModelSelection(task.modelSelection, bot.modelSelection));
        const busy = own.filter((task) => deps.busy(bot.id, task.threadId));
        const switched = deps.follow(bot.id, own.filter((task) => !busy.includes(task)).map((task) => task.threadId));
        return json(res, 200, { switched: switched.length, busy: busy.length, bot: deps.reply(bot.id) });
    };
}
