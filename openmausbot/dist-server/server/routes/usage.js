import { redactSecretsInText } from "../../shared/redact.js";
import { flushUsageLedger, parseUsageRange, readUsage, summarizeUsage, usageCsv, USAGE_GROUPINGS, USAGE_SPLITS, } from "../usage-ledger.js";
import { DETAIL_MAX, ERROR_MAX } from "../usage-trace/detail.js";
import { createTraceService, PAGE_MAX } from "../usage-trace/service.js";
import { PASS } from "./table.js";
const TRACE = /^\/api\/usage\/traces\/([^/]{1,600})$/;
const whole = (raw, fallback, max) => {
    if (raw === null)
        return fallback;
    return /^\d{1,7}$/.test(raw) && Number(raw) <= max ? Number(raw) : null;
};
/** The period's dollars booked on engines signed in with a subscription now, and the turns they came from. A row keeps
 * no record of how its engine was signed in when it ran, so this reads the sign-in as it is today. */
export function notBilledShare(rows, onPlan) {
    const plan = new Map();
    let usd = 0, turns = 0;
    for (const row of rows) {
        if (typeof row.costUsd !== "number" || !(row.costUsd > 0))
            continue;
        if (!plan.has(row.instanceId))
            plan.set(row.instanceId, onPlan(row.instanceId));
        if (!plan.get(row.instanceId))
            continue;
        usd += row.costUsd;
        turns += 1;
    }
    return { usd, turns };
}
/** The usage endpoints: trace browsing plus the grouped token and cost summary with its CSV export. */
export function createUsageRoutes(deps) {
    const traces = createTraceService({ dataDir: deps.dataDir, recorder: deps.recorder, messages: deps.messages, liveBot: deps.liveBot });
    return async ({ res, url, path, method, auth, json }) => {
        if (method === "GET" && path === "/api/usage/traces") {
            const range = parseUsageRange(url.searchParams.get("from"), url.searchParams.get("to"));
            if (!range)
                return json(res, 400, { error: "from and to must be YYYY-MM-DD, from no later than to, at most a year apart" });
            const offset = whole(url.searchParams.get("offset"), 0, 10_000_000);
            const limit = whole(url.searchParams.get("limit"), 50, PAGE_MAX);
            if (offset === null || !limit)
                return json(res, 400, { error: `offset must be a whole number and limit 1 to ${PAGE_MAX}` });
            await flushUsageLedger(deps.dataDir);
            res.setHeader("cache-control", "no-store");
            return json(res, 200, await traces.list(range, { offset, limit }, deps.canSee(auth)));
        }
        const trace = method === "GET" ? TRACE.exec(path) : null;
        if (trace) {
            let id;
            try {
                id = decodeURIComponent(trace[1]);
            }
            catch {
                return json(res, 400, { error: "not a trace id" });
            }
            const around = url.searchParams.get("at");
            if (around !== null && !/^\d{10,14}$/.test(around))
                return json(res, 400, { error: "at must be a time in milliseconds" });
            await flushUsageLedger(deps.dataDir);
            const found = await traces.detail(id, around === null ? null : Number(around), deps.canSee(auth));
            res.setHeader("cache-control", "no-store");
            return found ? json(res, 200, found) : json(res, 404, { error: "no such trace" });
        }
        if (!(method === "GET" && (path === "/api/usage" || path === "/api/usage.csv")))
            return PASS;
        const range = parseUsageRange(url.searchParams.get("from"), url.searchParams.get("to"));
        if (!range)
            return json(res, 400, { error: "from and to must be YYYY-MM-DD, from no later than to, at most a year apart" });
        await flushUsageLedger(deps.dataDir);
        const rows = readUsage(deps.dataDir, range).map(deps.rowFor(auth));
        const prices = deps.prices();
        if (path === "/api/usage.csv") {
            const stamp = (date) => date.toISOString().slice(0, 10);
            res.writeHead(200, {
                "content-type": "text/csv; charset=utf-8",
                "content-disposition": `attachment; filename="usage-${stamp(range.from)}-${stamp(range.to)}.csv"`,
                "cache-control": "no-store",
            });
            res.end(usageCsv(rows, prices));
            return;
        }
        const requested = url.searchParams.get("groupBy") ?? "bot";
        if (!USAGE_GROUPINGS.includes(requested)) {
            return json(res, 400, { error: `groupBy must be one of ${USAGE_GROUPINGS.join(", ")}` });
        }
        const groupBy = requested;
        const requestedSplit = url.searchParams.get("splitBy");
        if (requestedSplit !== null && !USAGE_SPLITS.includes(requestedSplit)) {
            return json(res, 400, { error: `splitBy must be one of ${USAGE_SPLITS.join(", ")}` });
        }
        const splitBy = requestedSplit === null || requestedSplit === groupBy ? null : requestedSplit;
        res.setHeader("cache-control", "no-store");
        return json(res, 200, {
            from: range.from.toISOString(),
            to: range.to.toISOString(),
            groupBy,
            splitBy,
            ...summarizeUsage(rows, groupBy, prices, splitBy),
            budget: deps.budget(),
            caps: deps.caps(auth),
            notBilled: notBilledShare(rows, deps.onPlan),
            billing: prices ? { currency: deps.currency() } : null,
        });
    };
}
const MAX_TOOL_NAME = 128;
const MAX_TOOL_MS = 24 * 60 * 60_000;
const MAX_SKEW_MS = 24 * 60 * 60_000;
/** A receipt from the agents tools for one call this turn's capability made: OMB's own timing of the tools it serves. */
export function createToolTimingRoute(recorder, threadId) {
    return async ({ req, res, path, method, json, readBody }) => {
        if (!(method === "POST" && path === "/api/internal/tool-timing"))
            return PASS;
        let body;
        try {
            body = await readBody(req, 8_192);
        }
        catch {
            return json(res, 400, { error: "expected a small JSON body" });
        }
        const value = (body && typeof body === "object" ? body : {});
        const { name, startedAt, endedAt, ok } = value;
        const near = (time) => typeof time === "number" && Number.isFinite(time) && Math.abs(time - Date.now()) <= MAX_SKEW_MS;
        if (typeof name !== "string" || !name || name.length > MAX_TOOL_NAME || typeof ok !== "boolean" ||
            !near(startedAt) || !near(endedAt) || !(endedAt >= startedAt) || endedAt - startedAt > MAX_TOOL_MS) {
            return json(res, 400, { error: "name, startedAt, endedAt and ok are required" });
        }
        const text = (field, max) => typeof field === "string" && field.trim() ? redactSecretsInText(field.slice(0, max)) : undefined;
        const receipt = { name, startedAt, endedAt, ok };
        const detail = text(value.detail, DETAIL_MAX);
        const error = text(value.error, ERROR_MAX);
        if (detail)
            receipt.detail = detail;
        if (error)
            receipt.error = error;
        recorder.receipt(threadId, receipt);
        return json(res, 200, { ok: true });
    };
}
