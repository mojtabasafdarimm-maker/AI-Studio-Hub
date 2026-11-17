// Whether each command MCP server starts, started the way a bot's AI would start it. One that does not start is left
// out of turns (an engine that mounts it anyway fails it on every session, and Claude Code then repeats the failure
// under every tool search), the person hears about it once, and it is tried again on its own. A bot's own server is
// checked for that bot; any other server starts the same for every bot on this computer, so one check stands for all.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { writeFileAtomic } from "./atomic.js";
/** A server that did not start is tried again after this long; one that started is trusted this long. */
export const RECHECK_FAILED_MS = 30 * 60_000;
export const RECHECK_STARTED_MS = 6 * 60 * 60_000;
const CHECKS_AT_ONCE = 2;
/** The check of a server that is no bot's own. */
const EVERY_BOT = "*";
/** The server's identity for its checks: what runs, and the files its command line names, so a fix shows. */
export function startKey(server) {
    const files = [server.command, ...server.args].filter((value) => isAbsolute(value)).map((path) => {
        try {
            const stat = statSync(path);
            return [path, stat.size, stat.mtimeMs];
        }
        catch {
            return [path, null];
        }
    });
    return createHash("sha256").update(JSON.stringify([server.command, server.args, Object.entries(server.env).sort(), files])).digest("hex").slice(0, 32);
}
/** A server's name as a tool's name in a sentence: "blender" is "Blender". */
export const toolLabel = (name) => name.charAt(0).toUpperCase() + name.slice(1);
export const nameList = (names) => names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
/** The one plain line about a server that does not start. */
export function offNotice(name, owner) {
    return `${owner ? `${owner.name}'s ${toolLabel(name)} tool` : `The ${toolLabel(name)} tool`} doesn't start, so it's off for now. It comes back on its own once it starts.`;
}
export function createMcpHealth(deps) {
    const now = deps.now ?? Date.now;
    let state = {};
    try {
        state = JSON.parse(readFileSync(deps.file, "utf8"));
    }
    catch { }
    const save = () => { try {
        writeFileAtomic(deps.file, JSON.stringify(state), { mode: 0o600 });
    }
    catch (error) {
        console.warn("[mcp] could not save server checks:", error);
    } };
    const running = new Map();
    const generations = new Map();
    const waiting = [];
    let active = 0;
    const slot = async (work) => {
        if (active >= CHECKS_AT_ONCE)
            await new Promise((resolve) => waiting.push(resolve));
        active += 1;
        try {
            return await work();
        }
        finally {
            active -= 1;
            waiting.shift()?.();
        }
    };
    const standsFor = (server, botId) => (server.bot ? botId : EVERY_BOT);
    const checkOf = (name, server, botId) => {
        const health = state[name];
        return health && health.key === startKey(server) ? health.checks?.[standsFor(server, botId)] : undefined;
    };
    const due = (check) => !check || now() - check.at >= (check.ok ? RECHECK_STARTED_MS : RECHECK_FAILED_MS);
    const record = (name, server, botId, key, generation, result) => {
        const current = deps.servers()[name];
        if (!current || (generations.get(name) ?? 0) !== generation || current.bot !== server.bot || startKey(current) !== key)
            return;
        const health = state[name]?.key === key && state[name].checks ? state[name] : (state[name] = { key, checks: {} });
        health.checks[standsFor(server, botId)] = result.ok ? { ok: true, at: now() } : { ok: false, at: now(), error: result.error };
        const tell = !result.ok && health.told !== key;
        if (tell)
            health.told = key;
        save();
        if (!tell)
            return;
        const about = deps.users(name).find((bot) => bot.id === botId) ?? deps.users(name)[0];
        if (about)
            deps.tell(offNotice(name, server.bot ? about : null), about);
    };
    const check = (name, server, botId) => {
        const key = startKey(server);
        const generation = generations.get(name) ?? 0;
        const id = `${name}\u0000${standsFor(server, botId)}\u0000${key}\u0000${generation}`;
        const pending = running.get(id);
        if (pending)
            return pending;
        const work = slot(() => deps.start(name, server, botId))
            .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
            .then((result) => record(name, server, botId, key, generation, result))
            .finally(() => running.delete(id));
        running.set(id, work);
        return work;
    };
    const checkUsers = (name, force) => {
        const server = deps.servers()[name];
        if (!server)
            return;
        for (const bot of deps.users(name)) {
            if (force || due(checkOf(name, server, bot.id)))
                void check(name, server, bot.id);
            if (!server.bot)
                return;
        }
    };
    return {
        /** Before a turn: waits for the first check of each of the bot's command servers, and starts any check due again in
         * the background, so a turn waits for a server at most once. */
        async prepare(botId, names) {
            const servers = deps.servers(), first = [];
            for (const name of names) {
                const server = servers[name];
                if (!server)
                    continue;
                const last = checkOf(name, server, botId);
                if (!last)
                    first.push(check(name, server, botId));
                else if (due(last))
                    void check(name, server, botId);
            }
            await Promise.all(first);
        },
        /** `mounted` without the command servers that did not start. */
        usable(botId, mounted) {
            const servers = deps.servers();
            return Object.fromEntries(Object.entries(mounted).filter(([name]) => !servers[name] || checkOf(name, servers[name], botId)?.ok !== false));
        },
        /** Which of `names` are left out of this bot's turns, with why. */
        off(botId, names) {
            const servers = deps.servers();
            return names.flatMap((name) => {
                const last = servers[name] ? checkOf(name, servers[name], botId) : undefined;
                return last && !last.ok ? [{ name, error: last.error ?? "It did not start." }] : [];
            });
        },
        /** Who a server is off for, by bot id. */
        offFor(name) {
            const server = deps.servers()[name];
            return server ? deps.users(name).filter((bot) => checkOf(name, server, bot.id)?.ok === false).map((bot) => bot.id) : [];
        },
        /** The bot's AI reported these did not connect: each is checked again now. */
        engineFailed(botId, names) {
            const servers = deps.servers();
            for (const name of names)
                if (servers[name])
                    void check(name, servers[name], botId);
        },
        /** A server was added, changed or turned on: checked again now. */
        changed(name) {
            generations.set(name, (generations.get(name) ?? 0) + 1);
            delete state[name];
            save();
            checkUsers(name, true);
        },
        /** In the background, every enabled command server not checked yet. */
        checkAll() {
            for (const name of Object.keys(deps.servers()))
                checkUsers(name, false);
        },
        /** Settles once every check started so far has. */
        async settled() {
            while (running.size)
                await Promise.all(running.values());
        },
    };
}
