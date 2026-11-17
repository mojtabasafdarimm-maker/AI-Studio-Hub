import { queuedChannelSends } from "../channel-queue.js";
import { jobView } from "../job-view.js";
import { hasQueuedSteeredMessages } from "../steer-queue.js";
import { PASS } from "./table.js";
/** Clients ask again with the version they got. */
export const JOB_WAIT_MAX_MS = 25_000;
const RECHECK_MS = 2_000;
const SETTLE_MS = 150;
export function createJobRoutes(deps) {
    const { store, coordinator } = deps;
    const now = deps.now ?? Date.now;
    const conversationOf = (threadId) => {
        const bot = store.botByThread(threadId);
        if (bot) {
            const task = store.taskByThread(bot.id, threadId);
            return {
                kind: "bot", busy: task?.busy === true || task?.activity === "working" || task?.activity === "parked.computer",
                ...(task?.activity ? { activity: task.activity } : {}), queued: hasQueuedSteeredMessages(bot.id, threadId) ? 1 : 0,
            };
        }
        const group = store.groupByThread(threadId);
        return group ? { kind: "room", busy: deps.groupThreadIsWorking(group.id, threadId), queued: queuedChannelSends(threadId) } : null;
    };
    const read = (threadId, scope, since, full, visible) => {
        const conversation = conversationOf(threadId);
        if (!conversation)
            return null;
        const owner = store.botByThread(threadId);
        const { scopes, rows } = coordinator.job(threadId, since, owner?.id);
        return jobView({
            threadId, scope, since, now: now(), scopes, rows, conversation, full,
            activityOf: (row) => row.assignee.destination.groupId
                ? store.bot(row.assignee.botId)?.activity
                : store.taskByThread(row.assignee.botId, row.assignee.destination.threadId)?.activity,
            nameOf: (botId) => store.bot(botId)?.name,
            titleOf: (row) => row.assignee.destination.groupId
                ? store.groupTaskByThread(row.assignee.destination.groupId, row.assignee.destination.threadId)?.title
                : store.taskByThread(row.assignee.botId, row.assignee.destination.threadId)?.title,
            visible: (thread) => visible.thread(thread),
        });
    };
    return async ({ res, url, path, method, auth, json }) => {
        const m = /^\/api\/threads\/([\w-]+)\/job$/.exec(path);
        if (!m || method !== "GET")
            return PASS;
        const threadId = m[1];
        const params = url.searchParams;
        const scope = params.get("scope") ?? "job";
        if (scope !== "job" && scope !== "turn")
            return json(res, 400, { error: "scope must be job or turn" });
        const number = (name, max) => {
            const raw = params.get(name);
            if (raw === null || raw === "")
                return 0;
            const value = Number(raw);
            return Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
        };
        const sinceParam = number("since", Number.MAX_SAFE_INTEGER);
        const wait = number("wait", JOB_WAIT_MAX_MS);
        if (sinceParam === null)
            return json(res, 400, { error: "since must be a server time in milliseconds" });
        if (wait === null)
            return json(res, 400, { error: `wait must be 0 to ${JOB_WAIT_MAX_MS} milliseconds` });
        // No `since`: the work open now. A waiter passes back the since it got, so its job does not move under it.
        const since = params.has("since") ? sinceParam : now();
        const full = params.get("full") === "1";
        const known = params.get("version") ?? "";
        const visible = deps.visibleTo(deps.viewerFor(auth));
        if (!visible.thread(threadId))
            return json(res, 404, { error: "no such conversation" });
        const view = read(threadId, scope, since, full, visible);
        if (!view)
            return json(res, 404, { error: "no such conversation" });
        if (!wait || view.version !== known)
            return json(res, 200, view);
        const held = await new Promise((answer) => {
            let settleTimer;
            let done = false;
            const finish = (next) => {
                if (done)
                    return;
                done = true;
                clearTimeout(settleTimer);
                clearTimeout(deadline);
                clearInterval(recheck);
                unsubscribe();
                res.off("close", abandoned);
                answer(next);
            };
            const look = (always) => {
                if (done)
                    return;
                let next;
                try {
                    next = read(threadId, scope, since, full, visible);
                }
                catch (error) {
                    return finish({ error });
                }
                if (always || !next || next.version !== known)
                    finish({ view: next });
            };
            const abandoned = () => finish({ view: null });
            const unsubscribe = store.onChange(() => {
                clearTimeout(settleTimer);
                settleTimer = setTimeout(() => look(false), SETTLE_MS);
            });
            const recheck = setInterval(() => look(false), deps.recheckMs ?? RECHECK_MS);
            const deadline = setTimeout(() => look(true), wait);
            res.on("close", abandoned);
        });
        if (res.writableEnded || res.destroyed)
            return;
        if ("error" in held)
            throw held.error;
        if (!held.view)
            return json(res, 404, { error: "no such conversation" });
        // The hold may have outlived a sign-out or an audience change: authorize again.
        if (auth.kind === "session" && !deps.sessions.isLive(auth.session.id)) {
            return json(res, 401, { error: "unauthorized: this session has expired or was revoked" });
        }
        const visibleNow = deps.visibleTo(deps.viewerFor(auth));
        const fresh = visibleNow.thread(threadId) ? read(threadId, scope, since, full, visibleNow) : null;
        if (!fresh)
            return json(res, 404, { error: "no such conversation" });
        return json(res, 200, fresh);
    };
}
