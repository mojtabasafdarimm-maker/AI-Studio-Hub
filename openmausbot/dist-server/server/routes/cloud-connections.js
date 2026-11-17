// The routes a one-time move to the person's own Cloud uses for connections. GET /api/cloud-connections, on either
// side, names this server's connections (never a secret) with the engines it runs and the programs it has. On a Cloud
// home: POST /api/cloud-connections/connected-apps makes this Cloud act as the computer's connected-apps account (a
// one-time code from OpenMausBot's service, or the person's own Composio project); PUT
// /api/cloud-connections/mcp/<name>/sign-in takes a sign-in that moved; PUT
// /api/cloud-connections/held-keys keeps a trial's moved keys unused while its Claude credit lasts; PUT
// /api/cloud-connections/email takes the person's mailboxes. Admin scope
// (request-auth's default): only the owner's app reaches them.
import { z } from "zod";
import { parseMcpOAuthRecord } from "../mcp-oauth-store.js";
import { PASS } from "./table.js";
const SLUG = /^[a-z0-9_][a-z0-9_-]{0,80}$/u;
const SIGN_IN = /^\/api\/cloud-connections\/mcp\/([a-z][a-z0-9_-]{0,31})\/sign-in$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const connectSchema = z.union([
    z.object({ share: z.string().regex(/^[0-9a-f]{64}$/u), apps: z.array(z.string().regex(SLUG)).max(500).optional() }).strict(),
    z.object({ apiKey: z.string().trim().min(1).max(500), userId: z.string().min(1).max(200), apps: z.array(z.string().regex(SLUG)).max(500).optional() }).strict(),
]);
export function createCloudConnectionRoutes(deps) {
    return async ({ req, res, url, path, method, auth, json, readBody }) => {
        if (path !== "/api/cloud-connections" && !path.startsWith("/api/cloud-connections/"))
            return PASS;
        res.setHeader("cache-control", "no-store");
        if (path === "/api/cloud-connections") {
            if (method !== "GET")
                return json(res, 405, { error: "method not allowed" });
            return json(res, 200, await deps.list());
        }
        if (!deps.cloudHome && deps.ownHome?.(auth) !== true)
            return json(res, 404, { error: "not found" });
        if (path === "/api/cloud-connections/held-keys") {
            if (method !== "PUT")
                return json(res, 405, { error: "method not allowed" });
            const asked = z.object({ for: z.array(z.string().regex(/^[\w.:-]{1,128}$/u)).max(20) }).safeParse(await readBody(req, 4096));
            if (!asked.success)
                return json(res, 400, { error: "send { for }: the engines a key runs" });
            return json(res, 200, { held: deps.holdKeys?.(asked.data.for) ?? false });
        }
        const signIn = SIGN_IN.exec(path);
        if (path !== "/api/cloud-connections/connected-apps" && path !== "/api/cloud-connections/email" && !signIn)
            return json(res, 404, { error: "not found" });
        if (method !== (path === "/api/cloud-connections/connected-apps" ? "POST" : "PUT"))
            return json(res, 405, { error: "method not allowed" });
        if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json"))
            return json(res, 415, { error: "content-type must be application/json" });
        const refused = deps.personalRefusal?.(signIn ? signIn[1] : path === "/api/cloud-connections/email" ? "Email" : "these apps");
        if (refused) {
            req.resume();
            return json(res, 403, { error: refused });
        }
        const body = await readBody(req, 64 * 1024);
        const replaces = url.searchParams.get("replaces");
        if (replaces !== null && !DIGEST.test(replaces))
            return json(res, 400, { error: "replaces is a sign-in's digest" });
        if (signIn) {
            const record = parseMcpOAuthRecord(body);
            if (!record)
                return json(res, 400, { error: "send the sign-in as this computer keeps it" });
            const adopted = deps.adoptSignIn(signIn[1], record, replaces);
            return adopted.ok ? json(res, 200, { [adopted.outcome]: true }) : json(res, adopted.status, { error: adopted.error });
        }
        if (path === "/api/cloud-connections/email") {
            const accounts = body?.accounts;
            if (!Array.isArray(accounts) || !deps.adoptEmail)
                return json(res, 400, { error: "send { accounts } as this computer keeps them" });
            return json(res, 200, deps.adoptEmail(accounts));
        }
        const parsed = connectSchema.safeParse(body);
        if (!parsed.success)
            return json(res, 400, { error: "send {share, apps} or {apiKey, userId, apps}" });
        const asked = parsed.data;
        let outcome;
        try {
            outcome = "share" in asked ? await deps.adoptShare(asked.share) : await deps.adoptOwn(asked.apiKey, asked.userId);
        }
        catch (error) {
            return json(res, 502, { error: error instanceof Error && error.message ? error.message.slice(0, 300) : "Connected apps could not be shared." });
        }
        if ("shared" in outcome)
            return json(res, 200, { shared: true });
        const wanted = [...new Set(asked.apps ?? [])];
        const connected = wanted.length ? await deps.composioConnected(wanted).catch(() => ({})) : {};
        return json(res, 200, { kept: true, missing: wanted.filter((slug) => connected[slug] !== true) });
    };
}
