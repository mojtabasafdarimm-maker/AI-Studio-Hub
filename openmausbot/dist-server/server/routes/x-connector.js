import { readIncludedXUsage } from "../x-research.js";
import { PASS } from "./table.js";
export const X_STATUS_PATH = "/api/x/status";
const USAGE_FRESH_MS = 30_000;
export function createXConnectorRoutes(deps) {
    const readUsage = deps.usage ?? ((credential) => readIncludedXUsage(credential));
    const now = deps.now ?? Date.now;
    let cached = null;
    const usageFor = async (credential, refresh) => {
        if (!refresh && cached?.token === credential.token && now() - cached.at < USAGE_FRESH_MS)
            return cached.usage;
        const usage = await readUsage(credential);
        cached = { token: credential.token, at: now(), usage };
        return usage;
    };
    return async (ctx) => {
        if (ctx.path !== X_STATUS_PATH)
            return PASS;
        if (ctx.method !== "GET")
            return void ctx.json(ctx.res, 405, { error: "Use GET." });
        const using = deps.credential(), included = deps.included();
        const usage = included ? await usageFor(included, ctx.url.searchParams.get("refresh") === "1") : null;
        const status = {
            using: using ? (using.included ? "included" : "own") : null,
            ownKey: using?.included === false,
            included: included !== null,
            ...(!included && deps.unavailable() ? { unavailable: true } : {}),
            ...(usage ? { usage } : {}),
        };
        ctx.res.setHeader("cache-control", "no-store");
        ctx.json(ctx.res, 200, status);
    };
}
