// Which config.json MCP servers each bot's turns start: every bot's and the bot's own, minus any that does not start.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic.js";
import { launcherOf } from "../cloud-connections.js";
import { customMcpServers } from "../config.js";
import { addBotMcpServer, claimBotMcpServers, keepForBot, withoutBotMcpServers } from "../mcp-bot-servers.js";
import { MCP_RESTART_ENV } from "../mcp-app-catalog.js";
import { grantMover, grantServersMark, storedGrantSpec } from "../mcp-grant-spec.js";
import { createMcpHealth, nameList, toolLabel } from "../mcp-health.js";
import { probeMcpServer } from "../mcp-probe.js";
import { isRemoteMcpServer, parseStoredMcpServer } from "../mcp-registry.js";
import { canUseMcpServer } from "../../shared/tool-scope.js";
const CLAIMED_FILE = (dataDir) => join(dataDir, "mcp-bot-servers.json");
/** A package runner fetches its program the first time it starts, and later starts are quick: its check waits for that. */
const PACKAGE_RUNNERS = new Set(["uvx", "npx", "bunx", "pipx", "pnpm", "uv"]);
const PACKAGE_START_MS = 120_000;
export const startCheckTimeout = (command) => (PACKAGE_RUNNERS.has(launcherOf(command)) ? PACKAGE_START_MS : undefined);
/** What the person hears once when servers in one bot's folder became that bot's own. */
export function claimedNotice(botName, names) {
    const tools = names.toSorted().map(toolLabel);
    return tools.length === 1
        ? `The ${tools[0]} tool only works for ${botName}, so it's off for your other bots.`
        : `The ${nameList(tools)} tools only work for ${botName}, so they're off for your other bots.`;
}
/** The enabled command servers this computer starts, by name, with the bot each is for. */
export function enabledCommandServers(cfg) {
    const out = {};
    for (const [name, raw] of Object.entries(cfg.mcpServers ?? {})) {
        const parsed = parseStoredMcpServer(name, raw);
        if (!parsed.ok || isRemoteMcpServer(parsed.server) || !parsed.server.enabled || parsed.server.runsOn)
            continue;
        const { command, args, env, bot } = parsed.server;
        out[name] = { command, args, env, ...(bot ? { bot } : {}) };
    }
    return out;
}
/** Whether this listed server's key is gone from the Vault: said beside it, so the person knows to give it a new one. */
function keyRemoved(keys, cfg, name) {
    const parsed = parseStoredMcpServer(name, cfg.mcpServers?.[name]);
    if (!parsed.ok)
        return false;
    const resolved = keys.resolve(name, parsed.server);
    return !resolved.ok && resolved.reason === "removed";
}
/** An engine keeps a command server's process across turns and starts a new one only when its spec changes (Claude Code,
 * for its warm session), so a restart has to show in the spec. Counted since this server started: its processes go with it. */
function withRestarts(servers, restarts) {
    return Object.fromEntries(Object.entries(servers).map(([name, server]) => {
        const count = restarts.get(name);
        return [name, count && "command" in server ? { ...server, env: { ...server.env, [MCP_RESTART_ENV]: String(count) } } : server];
    }));
}
export function createMcpServersHost(deps) {
    const configured = (bot) => deps.policy(customMcpServers(deps.cfg(), bot.mcpServers, bot.id));
    /** The bot's servers with their Vault keys read, and those whose key it can't have now, with why. */
    const keyed = (bot) => {
        const servers = {}, off = [];
        for (const [name, server] of Object.entries(configured(bot))) {
            const resolved = deps.keys ? deps.keys.resolve(name, server, bot.id) : { ok: true, server };
            if (resolved.ok)
                servers[name] = resolved.server;
            else
                off.push({ name, error: resolved.why, key: true });
        }
        return { servers, off };
    };
    /** None on an AI that starts no servers, and only those its tool selection reaches. */
    const started = (bot) => (deps.startsServers(bot.id) ? Object.keys(configured(bot)).filter((name) => canUseMcpServer(bot.toolScope, name)) : []);
    const asBot = (botId) => {
        const own = join(deps.dataDir, "workspaces", botId);
        return { id: botId, cwd: existsSync(own) ? own : deps.dataDir };
    };
    const start = deps.start ?? (async (name, server, botId) => {
        await deps.keys?.warm(name, server);
        const keyedStart = deps.keys ? deps.keys.resolve(name, server) : { ok: true, server };
        if (!keyedStart.ok)
            return { ok: false, error: keyedStart.why };
        const result = await probeMcpServer({ ...keyedStart.server, enabled: true }, startCheckTimeout(server.command), undefined, { asBot: asBot(botId) });
        return result.ok ? { ok: true } : { ok: false, error: result.error };
    });
    const checks = createMcpHealth({
        file: join(deps.dataDir, "mcp-health.json"),
        // A server whose Vault key is off is not started: it is off for that reason, not because it failed.
        servers: () => Object.fromEntries(Object.entries(enabledCommandServers(deps.cfg())).filter(([name, server]) => !deps.keys || deps.keys.resolve(name, server).ok)),
        users: (name) => deps.bots().filter((bot) => started(bot).includes(name)),
        start,
        tell: deps.tell,
    });
    const restarts = new Map();
    const health = { ...checks, changed(name) { restarts.set(name, (restarts.get(name) ?? 0) + 1); checks.changed(name); } };
    const mounted = (bot) => withRestarts(health.usable(bot.id, keyed(bot).servers), restarts);
    /** `servers` as a saved "Always allow" names them (mcp-grant-spec.ts): no Vault key's value and no restart count. */
    const grantSpecs = (servers) => {
        const stored = deps.cfg().mcpServers ?? {};
        return Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, storedGrantSpec(name, stored[name]) ?? server]));
    };
    /** Grants an earlier version tied to a key's value or a restart count move to the server as it is named now: once for
     * a bot's servers as they are, so a turn whose servers have not changed since does none of this. A failed save changes
     * nothing: the next turn tries again, and until then those tools ask as they did. */
    const movedFor = new Map();
    const moveGrants = (bot) => {
        if (!deps.moveGrants)
            return;
        const started = mounted(bot), names = grantSpecs(started);
        const servers = Object.fromEntries(Object.keys(started).map((name) => [name, { names: names[name], started: started[name] }]));
        const mark = grantServersMark(servers);
        if (movedFor.get(bot.id) === mark)
            return;
        try {
            deps.moveGrants(bot, grantMover(servers));
            movedFor.set(bot.id, mark);
        }
        catch {
            console.error("[mcp] Could not move this bot's saved tool permissions to their new form.");
        }
    };
    return {
        health,
        /** How Test starts a command server: as the turns of its bot, or of any bot. */
        probeAs: (server) => (server.bot ? asBot(server.bot) : {}),
        mounted,
        grantSpecs,
        /** The servers set for this bot, started or not: who a change to one reaches. */
        given: (bot) => Object.keys(configured(bot)),
        /** Before a turn: any Vault key its servers read from a linked password manager, and the first start checks. */
        prepare: async (bot) => {
            if (deps.keys) {
                for (const [name, raw] of Object.entries(deps.cfg().mcpServers ?? {})) {
                    const parsed = bot.mcpServers && !bot.mcpServers.includes(name) ? null : parseStoredMcpServer(name, raw);
                    if (parsed?.ok && parsed.server.enabled)
                        await deps.keys.warm(name, parsed.server);
                }
            }
            await health.prepare(bot.id, started(bot));
            moveGrants(bot);
        },
        off: (bot) => [...health.off(bot.id, started(bot)), ...keyed(bot).off.filter(({ name }) => canUseMcpServer(bot.toolScope, name))],
        listing: (server) => {
            const offFor = health.offFor(server.name);
            const keyGone = deps.keys ? keyRemoved(deps.keys, deps.cfg(), server.name) : false;
            return { ...server, ...(offFor.length ? { offFor } : {}), ...(keyGone ? { keyOff: true } : {}) };
        },
        /** A Vault item changed or went: every server it was given to is checked again. */
        keyChanged(item) {
            for (const name of deps.keys?.usedBy(item) ?? [])
                health.changed(name);
        },
        botAdd: (current, body, botId) => addBotMcpServer(current, body, botId, deps.dataDir, deps.boxed()),
        botKeep: (server, botId) => keepForBot(server, botId, deps.dataDir, deps.boxed()),
        botDeleted(botId) {
            const before = deps.cfg().mcpServers;
            const next = withoutBotMcpServers(before, botId);
            if (!next)
                return;
            deps.persist(next);
            for (const name of Object.keys(before ?? {})) {
                if (Object.hasOwn(next, name))
                    continue;
                try {
                    deps.keys?.forgetServer(name);
                }
                finally {
                    deps.forgetSignIn?.(name);
                }
            }
        },
        /** At start: the first time bots run boxed here, servers in one existing bot's folders become its own (said once);
         * then every server is checked. A server added after that stays as it was added. */
        boot() {
            if (deps.boxed() && !existsSync(CLAIMED_FILE(deps.dataDir))) {
                const bots = deps.bots();
                const claimed = claimBotMcpServers(deps.cfg().mcpServers, deps.dataDir, (botId) => bots.some((bot) => bot.id === botId));
                if (claimed)
                    deps.persist(claimed.next);
                writeFileAtomic(CLAIMED_FILE(deps.dataDir), JSON.stringify({ claimedAt: Date.now() }), { mode: 0o600 });
                for (const [botId, names] of Object.entries(claimed?.claimed ?? {})) {
                    const bot = bots.find((candidate) => candidate.id === botId);
                    if (bot && bots.length > 1)
                        deps.tell(claimedNotice(bot.name, names), bot);
                }
            }
            health.checkAll();
        },
    };
}
