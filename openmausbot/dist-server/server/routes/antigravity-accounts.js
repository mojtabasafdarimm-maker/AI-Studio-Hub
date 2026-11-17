// POST /api/instances/antigravity-accounts, body { displayName, sourceInstanceId }.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createClaudeAccountSchema } from "../claude-accounts.js";
import { PASS } from "./table.js";
const addAccount = createClaudeAccountSchema.pick({ displayName: true }).extend({ sourceInstanceId: z.string().min(1).max(200) });
export function createAntigravityAccountRoutes(deps) {
    return async ({ req, res, path, method, json, readBody }) => {
        if (method !== "POST" || path !== "/api/instances/antigravity-accounts")
            return PASS;
        if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json"))
            return json(res, 415, { error: "content-type must be application/json" });
        const parsed = addAccount.safeParse(await readBody(req, 8192));
        if (!parsed.success)
            return json(res, 400, { error: "Enter an account name (up to 80 characters) and select an Antigravity provider." });
        const answered = deps.exclusive(async () => {
            const instances = deps.instances();
            const source = instances[parsed.data.sourceInstanceId];
            if (source?.driver !== "antigravityAgent")
                return json(res, 400, { error: "Select a personal Antigravity provider." });
            const instanceId = `antigravity-${randomUUID()}`;
            const cli = source.config?.cli;
            // Only share the runtime. Each instance gets its own Google profile.
            instances[instanceId] = { driver: "antigravityAgent", displayName: parsed.data.displayName,
                config: typeof cli === "string" && cli ? { cli } : {} };
            await deps.persist(instanceId, instances);
            return json(res, 201, { instanceId, instances: await deps.describe() });
        });
        if (!answered)
            return json(res, 409, { error: "provider settings are already being updated" });
        return answered;
    };
}
