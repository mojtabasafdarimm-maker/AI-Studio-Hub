import { requiredScope } from "./request-auth.js";
const ACCOUNT_ADD_ENGINES = new Map([["/api/instances/claude-accounts", "claude"], ["/api/instances/chatgpt-accounts", "chatgpt"],
    ["/api/instances/antigravity-accounts", "antigravity"]]);
export function adminAuditPlan(method, path, sharedComputers) {
    if (method === "GET" || method === "HEAD" || method === "OPTIONS")
        return null;
    if (path.startsWith("/api/internal/") || path.startsWith("/api/testing/"))
        return null;
    const plan = {
        config: requiredScope(method, path, { sharedComputers }) === "admin",
        createsBots: method === "POST" && (path === "/api/bots" || path === "/api/teams/import" || path === "/api/org-library/add"),
        createsWebhook: method === "POST" && path === "/api/webhooks",
        pairing: method === "POST" && path === "/api/auth/pairing",
    };
    let m = /^\/api\/bots\/([\w-]+)(?:\/(always-allow|model|profile))?$/.exec(path);
    if (m && method === (m[2] === "always-allow" ? "POST" : "PATCH"))
        plan.botId = m[1];
    if (m && !m[2] && method === "DELETE")
        plan.deletesBot = m[1];
    m = /^\/api\/webhooks\/([\w-]+)(\/rotate)?$/.exec(path);
    if (m && ((m[2] && method === "POST") || (!m[2] && (method === "PATCH" || method === "DELETE"))))
        plan.webhookId = m[1];
    m = /^\/api\/auth\/sessions\/([\w-]+)$/.exec(path);
    if (m && method === "DELETE")
        plan.sessionId = m[1];
    m = /^\/api\/groups\/([\w-]+)$/.exec(path);
    if (m && method === "PATCH")
        plan.roomId = m[1];
    m = /^\/api\/instances\/([\w.-]+)\/(install|auth\/complete|auth\/sign-out|claude-update|leftover-files\/remove)$/.exec(path);
    if (m && method === "POST")
        plan.engineAction = { id: m[1], action: m[2].replace("/", "-") };
    const accountAdd = method === "POST" ? ACCOUNT_ADD_ENGINES.get(path) : undefined;
    if (accountAdd)
        plan.engineAction = { id: accountAdd, action: "account-add" };
    return plan.config || plan.botId || plan.createsBots || plan.deletesBot || plan.createsWebhook || plan.webhookId || plan.sessionId || plan.pairing || plan.engineAction || plan.roomId ? plan : null;
}
