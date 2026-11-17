// The engine homes of a Team Cloud at run time. A turn's spawns run inside its conversation (`within`, set around each
// adapter's sendTurn and keep-warm ping), and procs.ts asks `forSpawn` for the home of that conversation's audience. Off a
// Team Cloud nothing is started and every spawn keeps the server's HOME.
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { audienceHome, audienceHomeKey, audienceHomes, homedSpawn } from "./layout.js";
import { migrateEngineHomes } from "./migrate.js";
import { syncSignIns } from "./sign-ins.js";
export class EngineHomes {
    #setup = null;
    #migration = null;
    #thread = new AsyncLocalStorage();
    start(setup) {
        this.#setup = { ...setup, serverHome: setup.serverHome ?? homedir() };
        this.#migration = null;
    }
    stop() {
        this.#setup = null;
    }
    active() {
        return this.#setup !== null;
    }
    /** Runs `start` with what it spawns counted as this conversation's. */
    within(threadId, start) {
        return this.#setup ? this.#thread.run(threadId, start) : start();
    }
    /** The audience key of the conversation the caller runs in, so engines never share a process across audiences. */
    scope() {
        const threadId = this.#setup ? this.#thread.getStore() : undefined;
        return threadId === undefined ? null : audienceHomeKey(this.#setup.audienceOf(threadId));
    }
    /** The first spawn after a start moves what the engines kept in the server's HOME (migrate.ts). */
    migrate() {
        const setup = this.#setup;
        if (!setup)
            return null;
        if (this.#migration)
            return this.#migration;
        try {
            this.#migration = migrateEngineHomes({ dataDir: setup.dataDir, serverHome: setup.serverHome, env: setup.env ?? process.env, threads: setup.threads, audienceOf: setup.audienceOf });
            if (this.#migration.ran || this.#migration.swept) {
                (setup.log ?? console.log)(`engine homes: moved ${this.#migration.moved} session files to their conversations, held ${this.#migration.held}, deleted ${this.#migration.swept} held folders past their time`);
            }
        }
        catch (error) {
            this.#migration = { ran: false, moved: 0, held: 0, swept: 0 };
            (setup.log ?? console.warn)(`engine homes: the move from the server's home failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return this.#migration;
    }
    /** The environment as an engine sees it from each place it can run: the server's HOME, and on a Team Cloud every
     * audience's home too. */
    everyHome(env) {
        const setup = this.#setup;
        if (!setup)
            return [env];
        return [env, ...audienceHomes(setup.dataDir).map((home) => homedSpawn(env, { dataDir: setup.dataDir, serverHome: setup.serverHome, home }).env)];
    }
    /** On a Team Cloud, inside a conversation: the spawn with HOME and the engines' folders in its audience's home, the
     * home made, and the team's sign-ins in it. Null otherwise. */
    forSpawn(env) {
        const setup = this.#setup;
        const threadId = setup ? this.#thread.getStore() : undefined;
        if (!setup || threadId === undefined)
            return null;
        this.migrate();
        const home = audienceHome(setup.dataDir, setup.audienceOf(threadId));
        mkdirSync(home, { recursive: true, mode: 0o700 });
        const homed = homedSpawn(env, { dataDir: setup.dataDir, serverHome: setup.serverHome, home });
        for (const folder of homed.folders)
            mkdirSync(folder, { recursive: true, mode: 0o700 });
        const others = audienceHomes(setup.dataDir).filter((dir) => dir !== home);
        syncSignIns(homed.shared, (target) => others.map((dir) => join(dir, relative(home, target))));
        return homed;
    }
}
export const engineHomes = new EngineHomes();
/** On a Team Cloud, every turn, keep-warm ping and warm summary of this instance runs inside its conversation. */
export function withEngineHomes(instance, homes = engineHomes) {
    if (!homes.active())
        return instance;
    const adapter = instance.adapter;
    const warm = adapter.cacheKeepWarm;
    instance.adapter = {
        ...adapter,
        sendTurn: (input) => homes.within(input.threadId, () => adapter.sendTurn(input)),
        ...(warm ? { cacheKeepWarm: {
                ...warm,
                ping: (threadId, options) => homes.within(threadId, () => warm.ping(threadId, options)),
                // A summary forks the conversation's session, which lives in its audience's home, and starts the bot's servers there.
                ...(warm.compact ? { compact: (threadId, options) => homes.within(threadId, () => warm.compact(threadId, options)) } : {}),
            } } : {}),
    };
    return instance;
}
