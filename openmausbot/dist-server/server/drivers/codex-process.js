import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { splitCliString } from "../env-path.js";
/** Every Codex app-server starts its MCP servers with its thread; many starting at once on a small host
 * push those calls past their timeouts. Launches past this many wait until one has its turn running. */
export function codexLaunchLimit() {
    const configured = Number(process.env.OMB_CODEX_LAUNCH_SLOTS);
    // The CPUs this process may use (its container's or its affinity's), not every one the machine has.
    return Number.isInteger(configured) && configured > 0 ? configured : Math.max(2, availableParallelism());
}
let starting = 0;
const waiting = [];
/** A held slot, released once; null when every slot is taken. */
export function tryCodexLaunchSlot() {
    if (starting >= codexLaunchLimit())
        return null;
    starting++;
    let held = true;
    return () => {
        if (!held)
            return;
        held = false;
        starting--;
        while (waiting.length && !waiting.shift()())
            ;
    };
}
export function codexLaunchesStarting() {
    return starting;
}
/** Resolves null when `signal` aborts first. */
export function codexLaunchSlot(signal) {
    return new Promise((resolve) => {
        if (signal.aborted)
            return resolve(null);
        const take = () => {
            const slot = tryCodexLaunchSlot();
            if (!slot)
                return false;
            signal.removeEventListener("abort", abort);
            resolve(slot);
            return true;
        };
        const abort = () => {
            const index = waiting.indexOf(take);
            if (index >= 0)
                waiting.splice(index, 1);
            resolve(null);
        };
        if (take())
            return;
        waiting.push(take);
        signal.addEventListener("abort", abort, { once: true });
    });
}
/** The slot is released when the process exits or fails to start, if not before; not on `close`, which
 * waits for every descendant (its MCP servers, shells) to let go of the inherited pipes. */
export function spawnHoldingSlot(release, spawn) {
    try {
        const child = spawn();
        child.once("exit", release).once("error", release);
        return child;
    }
    catch (error) {
        release();
        throw error;
    }
}
const STARTUP_METHODS = new Set(["initialize", "config/read", "thread/start", "thread/resume", "thread/unarchive", "turn/start"]);
/** A loaded host can take minutes to start an app-server and its MCP servers; later calls answer quickly. */
export function codexRpcTimeoutMs(method) {
    return STARTUP_METHODS.has(method) ? 180_000 : 60_000;
}
/** How long a relaunch waits for a process whose stop could not be confirmed to exit by itself. */
export const RELAUNCH_EXIT_WAIT_MS = 30_000;
/** Retries a failed stop every few seconds while the turn still owns it, for about a minute; true once it stopped. */
export async function keepStopping(stop, owned) {
    const everyMs = Math.max(1, Number(process.env.FAKE_CODEX_STOP_RETRY_MS) || 5_000);
    for (let attempt = 0; attempt < 12 && owned(); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, everyMs).unref?.());
        if (owned() && await stop())
            return true;
    }
    return false;
}
/** A `-c key={ … }` override value: JSON string quoting is valid TOML basic-string quoting. */
export function tomlInlineTable(entries) {
    return `{ ${Object.entries(entries).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(", ")} }`;
}
/**
 * Codex drops root-level `-c` once the subcommand has its own (openai/codex#39012), and the driver
 * always passes its own after `app-server`. So `-c key=value` / `--config key=value` typed into the
 * CLI setting are pulled out here to go after the subcommand too. The rest stays as the launcher.
 */
export function codexCliOverrides(cli) {
    const unchanged = { cli, overrides: [] };
    const trimmed = cli.trim();
    if (trimmed.includes(" ") && existsSync(trimmed))
        return unchanged;
    const [head, ...rest] = splitCliString(trimmed);
    if (!head || rest.length === 0)
        return unchanged;
    const kept = [head];
    const overrides = [];
    for (let index = 0; index < rest.length; index++) {
        const token = rest[index];
        const next = rest[index + 1];
        if ((token === "-c" || token === "--config") && next?.includes("=")) {
            overrides.push("-c", next);
            index++;
        }
        else if (token.startsWith("--config=") && token.slice("--config=".length).includes("=")) {
            overrides.push("-c", token.slice("--config=".length));
        }
        else {
            kept.push(token);
        }
    }
    if (overrides.length === 0)
        return unchanged;
    // splitCliString has no escapes, so a word holding both quote kinds can't be written back.
    const quoted = kept.map((token) => !/[\s"']/.test(token) ? token : !token.includes('"') ? `"${token}"` : !token.includes("'") ? `'${token}'` : null);
    if (quoted.includes(null))
        return unchanged;
    return { cli: quoted.join(" "), overrides };
}
/** The launcher and argv for `app-server`: the user's overrides go first, so the driver's own
 * (guest confinement, tool surface) keep the last word. */
export function codexLaunch(cli, appServerArgs) {
    const launch = codexCliOverrides(cli);
    const [subcommand, ...driverArgs] = appServerArgs;
    return [launch.cli, [subcommand, ...launch.overrides, ...driverArgs]];
}
