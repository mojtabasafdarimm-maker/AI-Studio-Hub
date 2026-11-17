import { readFileSync } from "node:fs";
// cgroup paths are POSIX paths on every platform this reads them, and in tests run on Windows.
import { posix } from "node:path";
import { boxMemory } from "./box-memory.js";
/** One open browser with one page in the server image (Chromium 156, agent-browser 0.37.0): 13 processes, about 160
 * threads (each counts against a pids limit) and about 350 MB. */
const BROWSER_THREADS = 160;
const BROWSER_BYTES = 400 * 1024 * 1024;
/** The part of the server's limits that browsers may fill; engines and their tools need the rest. */
const BROWSER_SHARE = 0.4;
const MOST_BROWSERS = 16;
const ROOM_WAIT_MS = 30_000;
const readText = (path) => { try {
    return readFileSync(path, "utf8");
}
catch {
    return null;
} };
/** The tightest `pids.max` from `at` up to the hierarchy's root under `root`. */
function tightest(read, root, from) {
    let limit = null;
    for (let at = from.trim();; at = posix.dirname(at)) {
        const value = Number(read(posix.join(root, at, "pids.max"))?.trim());
        if (Number.isInteger(value) && value > 0)
            limit = Math.min(limit ?? value, value);
        if (at === "/" || at === ".")
            return limit;
    }
}
/** The tightest task limit over this process's own cgroup and its parents (a container's --pids-limit, a systemd
 * TasksMax): cgroup v2 `pids.max` and v1's under the pids controller. A hybrid host lists both, and its limit is often
 * only in v1's, so both are read. Null with no limit, and off Linux. */
export function pidsLimit(read = readText) {
    const membership = read("/proc/self/cgroup");
    if (membership === null)
        return null;
    const v2 = /^0::(\/.*)$/m.exec(membership)?.[1];
    const v1 = /^\d+:(?:[^:]*,)?pids(?:,[^:]*)?:(\/.*)$/m.exec(membership)?.[1];
    const limits = [
        ...(v2 !== undefined ? [tightest(read, "/sys/fs/cgroup", v2), tightest(read, "/sys/fs/cgroup/unified", v2)] : []),
        ...(v1 !== undefined ? [tightest(read, "/sys/fs/cgroup/pids", v1)] : []),
    ].filter((limit) => limit !== null);
    return limits.length > 0 ? Math.min(...limits) : null;
}
/** How many agent-browser browsers run at once: `OMB_BROWSER_MAX_RUNNING` (a whole number of at least 1), else what fits
 * in the browsers' share of the task limit and of the memory this server may use. Any other value, 0 included, is not a
 * way to turn browsers off (a bot's own browser switch is): it is refused with a log line and the computed size is used. */
export function browserRoomSize(limits, warn = () => undefined) {
    const override = limits.override?.trim() ? Number(limits.override) : undefined;
    if (override !== undefined && Number.isInteger(override) && override > 0)
        return override;
    if (override !== undefined)
        warn(`OMB_BROWSER_MAX_RUNNING=${JSON.stringify(limits.override)} is not a whole number of at least 1, so it is ignored; set it to 1 or more, or unset it to size the browsers by this server's limits`);
    const byMemory = Math.floor((limits.memoryBytes * BROWSER_SHARE) / BROWSER_BYTES);
    const byTasks = limits.pids === null ? MOST_BROWSERS : Math.floor((limits.pids * BROWSER_SHARE) / BROWSER_THREADS);
    return Math.max(1, Math.min(MOST_BROWSERS, byMemory, byTasks));
}
let size;
export function defaultBrowserRoomSize(env = process.env) {
    size ??= browserRoomSize({ override: env.OMB_BROWSER_MAX_RUNNING, pids: pidsLimit(), memoryBytes: boxMemory().bytes }, (line) => console.warn(`browser: ${line}`));
    return size;
}
/** What the room may close for a bot waiting on a slot (how long the browser sat unused), or null. A browser no turn holds
 * may go. One a running turn holds goes only here, never in the regular idle sweep, and only once it sat unused for the
 * idle time and reopens with its sign-ins: open pages are lost either way, and a temporary browser would lose its
 * sign-ins too, so the turn keeps it. */
export function spareForRoom(spare, turn) {
    if (spare === null)
        return null;
    if (!turn.holds)
        return spare.idleMs;
    return spare.savesSignIns && spare.idleMs >= turn.idleMs ? spare.idleMs : null;
}
/** Counts the browsers agent-browser runs for this server. A browser over the limit starts once the least recently used
 * spare one is closed; with none to close its call waits, then is told why it cannot start. */
export class BrowserRoom {
    #open = new Set();
    #options;
    constructor(options) { this.#options = options; }
    get open() { return this.#open.size; }
    /** Null once `session` may run a browser; otherwise the refusal for the bot. */
    async enter(session, deadline) {
        const until = Math.min(deadline, Date.now() + (this.#options.waitMs ?? ROOM_WAIT_MS));
        for (;;) {
            if (this.#open.has(session))
                return null;
            const others = [...this.#open];
            if (others.length < Math.max(1, this.#options.max())) {
                const refused = await this.#options.admit?.(session) ?? null;
                if (refused !== null) {
                    if (await this.#closeOneSpare(others))
                        continue;
                    return refused;
                }
                // Another session may have taken the last place while the server's room was asked.
                if (!this.#open.has(session) && this.#open.size >= Math.max(1, this.#options.max()))
                    continue;
                this.#open.add(session);
                return null;
            }
            if (await this.#closeOneSpare(others))
                continue;
            if (Date.now() >= until)
                return `${others.length === 1 ? "1 browser is" : `${others.length} browsers are`} already open on this computer, the most it runs at once. Wait for another bot to finish with its browser, then try again.`;
            await new Promise((resolve) => setTimeout(resolve, Math.min(this.#options.pollMs ?? 500, Math.max(1, until - Date.now()))));
        }
    }
    /** Spare browsers, least recently used first, until one closes; one that will not close leaves the next to try. */
    async #closeOneSpare(others) {
        const spare = others.flatMap((other) => { const idle = this.#options.spare(other); return idle === null ? [] : [{ other, idle }]; })
            .sort((a, b) => b.idle - a.idle);
        for (const { other } of spare) {
            // Asked again just before closing: an earlier close's wait may have let a call or a person in.
            if (!this.#open.has(other) || this.#options.spare(other) === null)
                continue;
            if (await this.#options.close(other).catch(() => false)) {
                this.#open.delete(other);
                return true;
            }
        }
        return false;
    }
    /** A browser that runs whether or not a call started it, such as one a person's view opened. */
    entered(session) { this.#open.add(session); }
    left(session) { this.#open.delete(session); }
}
const REFUSED = new WeakSet();
/** A call's answer when every browser allowed is open: it reached no browser. */
export function slotRefusal(text) {
    const refusal = { isError: true, content: [{ type: "text", text }] };
    REFUSED.add(refusal);
    return refusal;
}
/** A slot refusal opened nothing, so a note that this call reopened the browser waits for the call that does. */
export function refusedSlot(result) { return typeof result === "object" && result !== null && REFUSED.has(result); }
const listKey = (spec) => JSON.stringify([spec.command, ...spec.args]);
/** agent-browser's tool list follows from its binary and arguments, never from the session, so one answer serves every
 * session and listing tools starts no `agent-browser mcp` process of its own. */
export class SharedToolLists {
    #lists = new Map();
    #known = new Map();
    /** `check` runs first on every ask, as a session's own connection would check its launch settings. */
    get(spec, load, check) {
        try {
            check?.();
        }
        catch (error) {
            return Promise.reject(error);
        }
        const key = listKey(spec);
        let list = this.#lists.get(key);
        if (!list) {
            list = load().then((result) => {
                if (Array.isArray(result?.tools))
                    this.#known.set(key, result);
                else
                    this.#lists.delete(key);
                return result;
            }, (error) => { this.#lists.delete(key); throw error; });
            this.#lists.set(key, list);
        }
        return list;
    }
    /** The list already read for these launch settings, if any. */
    known(spec) { return this.#known.get(listKey(spec)); }
}
