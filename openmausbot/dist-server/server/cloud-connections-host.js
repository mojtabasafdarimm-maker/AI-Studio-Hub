// The one-time move of this computer's connections to the person's own Cloud, in one object: its routes
// (routes/cloud-connections.ts), the private port's answers to the desktop's main process (login-handoff.ts), and what
// a bot on My Cloud is told about connections that need the person there (cloud-connections-prompt.ts).
import { hostname } from "node:os";
import { join } from "node:path";
import { answerConnection, connectionFingerprints, launchersOnPath, listConnections, releaseConnection, signInDigest } from "./cloud-connections.js";
import { createConnectionPrompt } from "./cloud-connections-prompt.js";
import { createStayedNotices } from "./cloud-connections-stayed.js";
import { movedFrom } from "./cloud-send-arrived.js";
import * as composio from "./composio.js";
import { brokerAccess } from "./composio-broker-access.js";
import { adoptComposioShare, adoptOwnComposio, composioIdentity, composioShareCode } from "./composio-share.js";
import { isRemoteMcpServer, parseStoredMcpServer } from "./mcp-registry.js";
import { personalConnectionRefusal } from "./cloud-team.js";
import { createCloudConnectionRoutes } from "./routes/cloud-connections.js";
const managedService = () => { try {
    return brokerAccess() !== null;
}
catch {
    return false;
} };
export function createCloudConnectionsHost(deps) {
    const label = (process.env.OMB_ENVIRONMENT_LABEL?.trim() || hostname()).slice(0, 120).trim() || "the person's computer";
    const computer = { environmentId: deps.environmentId, label };
    let commands = null;
    const mcpAuth = (name, url) => deps.mcpOAuth.authState(name, url);
    const sources = () => ({ config: deps.config(), mcpSignIn: (name, url) => deps.mcpOAuth.signInRecord(name, url), email: () => deps.email?.accounts() ?? [], ...(deps.mcpKeys ? { mcpKeys: deps.mcpKeys } : {}) });
    const composioConnected = async (slugs) => Object.fromEntries(Object.entries(await composio.connectionStatus(deps.config(), slugs)).map(([slug, state]) => [slug, state.connected]));
    const programs = () => (commands ??= launchersOnPath());
    const prompt = deps.cloudHome ? createConnectionPrompt({ mcpServers: () => deps.config().mcpServers, mcpAuth, programs,
        composioConnected, movedFrom: () => (deps.dataDir ? movedFrom(deps.dataDir)?.computer ?? null : null) }, deps.cloudHome.publicOrigin) : null;
    const stayed = deps.cloudHome && deps.dataDir && deps.stayedNotices ? createStayedNotices({ ...deps.stayedNotices, origin: deps.cloudHome.publicOrigin, file: join(deps.dataDir, "connectors-stayed-told.json"), servers: () => deps.config().mcpServers, programs, mailConnected: () => (deps.email?.accounts().length ?? 0) > 0 }) : null;
    const connections = async () => {
        const cfg = deps.config();
        return listConnections({ config: cfg, mcpAuth, composio: await composioIdentity(cfg).catch(() => null), email: () => deps.email?.accounts() ?? [] });
    };
    return {
        connections,
        fingerprints: (nonce) => connectionFingerprints(nonce, sources()),
        routes: createCloudConnectionRoutes({
            cloudHome: deps.cloudHome !== null,
            ...(deps.ownHome ? { ownHome: deps.ownHome } : {}),
            ...(deps.cloudHome?.team ? { personalRefusal: (what) => personalConnectionRefusal(deps.cloudHome.team, what) } : {}),
            async list() {
                return { computer, connections: await connections(), engines: await deps.engines().catch(() => []), commands: programs(), ...(deps.cloudHome?.team ? {} : { vaultKeys: true }),
                    ...(deps.cloudHome === null && !managedService() ? { managedApps: false } : {}) };
            },
            adoptShare: adoptComposioShare,
            adoptOwn: (apiKey, userId) => adoptOwnComposio(deps.config(), apiKey, userId),
            composioConnected,
            adoptSignIn(name, record, replaces) {
                const raw = deps.config().mcpServers?.[name];
                const parsed = raw === undefined ? null : parseStoredMcpServer(name, raw);
                if (!parsed?.ok || !isRemoteMcpServer(parsed.server))
                    return { ok: false, status: 404, error: "This MCP server is not here yet." };
                if (parsed.server.url !== record.url)
                    return { ok: false, status: 409, error: "This MCP server has another address here." };
                return { ok: true, outcome: deps.mcpOAuth.adopt(name, parsed.server.url, record, replaces ? (current) => signInDigest(current.tokens) === replaces : undefined) };
            },
            ...(deps.email ? { adoptEmail: deps.email.adopt } : {}),
            holdKeys: (engines) => deps.heldKeys?.hold(engines) ?? false,
        }),
        /** The private port's ask: one connection's secrets, a code for the person's Cloud to act as this computer's
         * connected-apps account, or letting go of a sign-in that moved. */
        async handoff(what) {
            if (what.kind === "composio-share") {
                try {
                    return { ok: true, share: { code: await composioShareCode(what.for) } };
                }
                catch (error) {
                    return { ok: false, error: error instanceof Error && error.message ? error.message.slice(0, 300) : "Connected apps could not be shared." };
                }
            }
            if (what.kind === "connection-fingerprints")
                return { ok: true, secrets: connectionFingerprints(what.nonce, sources()) };
            if (what.kind === "connection-release") {
                return releaseConnection(what.id, what.digest, { ...sources(), forgetSignIn: (name) => deps.mcpOAuth.forget(name) });
            }
            return answerConnection(what.id, sources());
        },
        prompt: (bot, lent) => prompt?.(bot, lent) ?? "",
        /** What stayed on the person's computer: said when the move ends, and in the first conversation with each bot. */
        moved: (language) => stayed?.moved(language),
        personTurn: (bot, threadId) => stayed?.personTurn(bot, threadId),
    };
}
