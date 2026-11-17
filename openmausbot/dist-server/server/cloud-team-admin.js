export const CLOUD_TEAM_ADMIN_PATH = "/api/cloud/team/admin";
export function teamAdminSummary(input) {
    const configured = (id) => Boolean(input.status[id]?.configured);
    const host = (url) => {
        try {
            return url ? new URL(url).host : null;
        }
        catch {
            return null;
        }
    };
    return {
        v: 1,
        apps: {
            available: input.apps !== null,
            services: Object.entries(input.apps ?? {}).filter(([, state]) => state.connected || state.pending || state.accounts.length > 0).map(([slug, state]) => ({
                slug, status: state.status, accounts: state.accounts.map((account) => ({ id: account.id, alias: account.alias?.trim() || null, status: account.status })),
            })),
        },
        mcp: input.mcp.map((server) => ({
            name: server.name,
            transport: server.url ? (server.type === "sse" ? "sse" : "http") : "stdio",
            host: host(server.url),
            enabled: server.enabled !== false,
            signedIn: server.auth === undefined ? null : server.auth === "signed-in",
            secrets: [...(server.headerKeys ?? []), ...(server.envKeys ?? [])],
        })),
        keys: [{ id: "treg", configured: configured("treg") }, { id: "voice", configured: input.voice.key, ...(input.voice.included ? { included: true } : {}) }],
        ai: {
            keys: ["anthropic", "openai", "openrouter"].map((id) => ({ id, configured: configured(id) })),
            engines: input.engines.filter((engine) => engine.snapshot?.state === "available").map((engine) => {
                const account = engine.snapshot?.authenticated ? engine.snapshot.account : undefined;
                return {
                    id: engine.instanceId, name: engine.name, authenticated: engine.snapshot?.authenticated === true,
                    account: account ? { email: account.email ?? null, organization: account.organization ?? null, method: account.method ?? null } : null,
                };
            }),
        },
    };
}
