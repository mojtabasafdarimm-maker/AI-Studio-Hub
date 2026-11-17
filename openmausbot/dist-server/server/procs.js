// Windows differences for agent CLIs: CreateProcess cannot exec .cmd/.bat shims or shebang scripts (env-path
// resolves them without a shell), there is no process-group kill (taskkill /T), GUI-spawned consoles flash without
// windowsHide, and the command line is capped at 32,767 characters (prompts go on stdin or in files).
import { spawn, execFile, } from "node:child_process";
import { closeSync, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { botBox } from "./bot-box/box.js";
import { homeProgramsDistrusted, serverMayRunFrom, serverPath } from "./bot-box/program-trust.js";
import { engineMemory } from "./engine-memory.js";
import { ENGINE_TAG_ENV, engineRunTag, engineStopped, recordEngine } from "./engine-records.js";
import { engineHomes } from "./engine-homes/engine-homes.js";
import { resolveCliSpawn } from "./env-path.js";
import { spawnBotWork } from "./oom-score.js";
import { noticeFailure } from "./chat-notices.js";
import { processBudget } from "./process-room.js";
import { shortageCode } from "./process-shortage.js";
export function resolveCli(cli, args = [], env) {
    return resolveCliSpawn(cli, args, env);
}
/** Headroom below CreateProcess' 32,767 UTF-16 code-unit limit for libuv's quoting and executable expansion. */
export const WINDOWS_SAFE_COMMAND_LINE_CHARS = 30_000;
export function estimatedWindowsCommandLineChars(resolved) {
    return [resolved.command, ...resolved.args].reduce((total, value) => total + JSON.stringify(value).length + 1, 0);
}
export function assertSafeCliArgv(resolved, platform = process.platform) {
    if (platform !== "win32")
        return;
    if (estimatedWindowsCommandLineChars(resolved) <= WINDOWS_SAFE_COMMAND_LINE_CHARS)
        return;
    const error = new Error("agent CLI launch arguments exceed Windows' safe command-line limit; pass large prompts through stdin or a file");
    error.code = "ENAMETOOLONG";
    throw error;
}
// Only spawnCli makes a private POSIX group; a plain child may share ours, so never signal its group.
const cliGroups = new WeakSet();
const stopping = new WeakMap();
const linuxTrees = new WeakMap();
function linuxProcess(pid, file = `/proc/${pid}/stat`) {
    let stat;
    try {
        stat = readFileSync(file, "utf8");
    }
    catch (error) {
        if (["ENOENT", "ESRCH"].includes(error.code ?? ""))
            return null;
        throw error;
    }
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const start = fields[19];
    const state = fields[0];
    const parent = Number(fields[1]);
    if (!start || !state || !Number.isInteger(parent))
        throw new Error("Unreadable Linux process identity");
    return { pid, parent, start, state };
}
/** /proc/<pid>/task/<tid>/children needs CONFIG_PROC_CHILDREN (CONFIG_CHECKPOINT_RESTORE before Linux 4.2); a kernel built without it, or gVisor, has no such file. */
function linuxChildrenFiles() {
    return existsSync(`/proc/self/task/${process.pid}/children`);
}
/** Every thread's children, or null when the list may miss one: Linux hides /proc/<pid>/task once the main thread has
 * exited while others run, and a thread that exits hands its children to a sibling thread, after which its own
 * children file reads empty. */
function linuxChildren(pid) {
    let tasks;
    try {
        tasks = readdirSync(`/proc/${pid}/task`);
    }
    catch {
        return null;
    }
    if (tasks.length === 0)
        return null;
    const children = [];
    for (const task of tasks) {
        let listed;
        try {
            listed = readFileSync(`/proc/${pid}/task/${task}/children`, "utf8");
        }
        catch {
            return null;
        }
        let thread;
        try {
            thread = linuxProcess(pid, `/proc/${pid}/task/${task}/stat`);
        }
        catch {
            return null;
        }
        if (!thread || thread.state === "Z" || thread.state === "X")
            return null;
        for (const entry of listed.split(" "))
            if (/^\d+$/.test(entry))
                children.push(Number(entry));
    }
    return children;
}
function isLinuxProcess(pid, start) {
    try {
        return linuxProcess(pid)?.start === start;
    }
    catch {
        return false;
    }
}
/** Linux sandbox helpers can leave the CLI's process group and reparent during a protocol interrupt. */
export function captureCliTree(child) {
    if (process.platform !== "linux" || !cliGroups.has(child) || !child.pid)
        return;
    let tree = linuxTrees.get(child);
    if (!tree) {
        tree = new Map();
        linuxTrees.set(child, tree);
    }
    if (!linuxChildrenFiles() || !addLinuxDescendants(tree))
        addLinuxDescendantsFromEveryProcess(tree);
}
/** False when the walk may have missed a descendant; those it confirmed stay in the tree. A children file can skip a
 * live child while a sibling listed before it is reaped (docs.kernel.org/filesystems/proc.html,
 * "/proc/<pid>/task/<tid>/children"), and that sibling is then gone or reparented when its stat is read. */
function addLinuxDescendants(tree) {
    const queue = [...tree].filter(([pid, start]) => isLinuxProcess(pid, start));
    for (let next = 0; next < queue.length; next += 1) {
        const [parent, parentStart] = queue[next];
        const children = linuxChildren(parent);
        if (!children || !isLinuxProcess(parent, parentStart))
            return false;
        for (const pid of children) {
            if (pid === process.pid)
                continue;
            let current;
            try {
                current = linuxProcess(pid);
            }
            catch {
                return false;
            }
            if (!current || current.parent !== parent)
                return false;
            if (tree.get(pid) === current.start)
                continue;
            tree.set(pid, current.start);
            queue.push([pid, current.start]);
        }
    }
    return true;
}
function addLinuxDescendantsFromEveryProcess(tree) {
    const snapshot = new Map();
    let entries;
    try {
        entries = readdirSync("/proc");
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (!/^\d+$/.test(entry))
            continue;
        const pid = Number(entry);
        try {
            const current = linuxProcess(pid);
            if (current)
                snapshot.set(pid, current);
        }
        catch { }
    }
    const parents = new Set([...tree].filter(([pid, start]) => snapshot.get(pid)?.start === start).map(([pid]) => pid));
    let discovered;
    do {
        discovered = false;
        for (const current of snapshot.values()) {
            if (current.pid === process.pid || !parents.has(current.parent) || tree.get(current.pid) === current.start)
                continue;
            tree.set(current.pid, current.start);
            parents.add(current.pid);
            discovered = true;
        }
    } while (discovered);
}
function linuxDescendantsStopped(child) {
    for (const [pid, start] of linuxTrees.get(child) ?? []) {
        if (pid === child.pid)
            continue;
        try {
            const current = linuxProcess(pid);
            if (current?.start === start && current.state !== "Z" && current.state !== "X")
                return false;
        }
        catch {
            return false;
        }
    }
    return true;
}
/** Whether every process still in this group has exited and only waits to be collected. Where nothing collects orphans
 * (Node as a container's process 1) such members stay for good, and kill(-pgid, 0) goes on succeeding for them. False
 * when a member runs, when none is found, or when /proc can't say. */
export function linuxGroupOnlyExited(group, list = () => readdirSync("/proc"), stat = (pid) => readFileSync(`/proc/${pid}/stat`, "utf8")) {
    let entries;
    try {
        entries = list();
    }
    catch {
        return false;
    }
    let members = 0;
    for (const entry of entries) {
        if (!/^\d+$/.test(entry))
            continue;
        let fields;
        try {
            const text = stat(Number(entry));
            fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
        }
        catch {
            continue;
        }
        if (Number(fields[2]) !== group)
            continue;
        if (fields[0] !== "Z" && fields[0] !== "X")
            return false;
        members += 1;
    }
    return members > 0;
}
function linuxRootIdentityMatches(child) {
    const start = child.pid && linuxTrees.get(child)?.get(child.pid);
    if (!child.pid || process.platform !== "linux" || !cliGroups.has(child))
        return true;
    if (!start)
        return undefined;
    try {
        const current = linuxProcess(child.pid);
        return !current || current.start === start;
    }
    catch {
        return undefined;
    }
}
function signalLinuxDescendants(child, value) {
    for (const [pid, start] of [...(linuxTrees.get(child) ?? [])].reverse()) {
        if (pid === child.pid || pid <= 1 || pid === process.pid)
            continue;
        try {
            const current = linuxProcess(pid);
            if (current?.start === start && current.state !== "Z" && current.state !== "X")
                process.kill(pid, value);
        }
        catch { }
    }
}
const MAX_ENDED_SESSIONS = 4_096;
const engineSessions = { live: new Set(), ended: new Set() };
/** POSIX session ids of the engines that run bots' turns (each leads its own session). A server opened by any
 * process in one counts as the bot's, even after the shell that started it exits. */
export function botEngineSessions() {
    return engineSessions;
}
function rememberEngineSession(child) {
    const pid = child.pid;
    if (!pid)
        return;
    engineSessions.live.add(pid);
    child.once("exit", () => {
        engineSessions.live.delete(pid);
        engineSessions.ended.add(pid);
        if (engineSessions.ended.size > MAX_ENDED_SESSIONS)
            engineSessions.ended.delete(engineSessions.ended.values().next().value);
    });
}
const liveSpawns = new Set();
/** The command line of every process spawnCli started that has not exited yet. */
export function liveCliCommands() {
    return liveSpawns;
}
function rememberLiveSpawn(child, line) {
    if (!child.pid)
        return;
    liveSpawns.add(line);
    child.once("exit", () => liveSpawns.delete(line));
}
/** The box for this spawn, or null when it runs as is. A spawn in an engine home has that home in place of HOME. */
export function boxedSpawn(resolved, opts, owner, homed = null) {
    if (opts.box === false || (owner !== "bot" && !opts.box))
        return null;
    const request = typeof opts.box === "object" ? opts.box : {};
    const home = homed ? { home: homed.home, shared: homed.shared } : {};
    return botBox.wrap({ command: resolved.command, args: resolved.args, cwd: typeof opts.cwd === "string" ? opts.cwd : undefined, env: opts.env ?? process.env, ...request, ...home });
}
/** What a process several conversations share must be boxed with to serve `cwd` (null with the box off): all of the bot's
 * conversation folders for a conversation folder (task-workspaces/<bot>/<thread>, BoxRequest.botThreads), else `cwd`. */
export function sharedBoxScope(cwd) {
    if (!botBox.enabled())
        return null;
    const parent = dirname(resolve(cwd));
    return basename(dirname(parent)) === "task-workspaces" ? parent : resolve(cwd);
}
/** Security (bot-box/program-trust.ts): a spawn outside the box neither starts a program from a folder a boxed bot can
 * write nor looks one up there. */
export function outsideBoxOptions(command, opts) {
    if (!homeProgramsDistrusted())
        return opts;
    if (/[/\\]/.test(command)) {
        const path = resolve(typeof opts.cwd === "string" ? opts.cwd : process.cwd(), command);
        let real = path;
        try {
            real = realpathSync(path);
        }
        catch { }
        if (!serverMayRunFrom(path) || !serverMayRunFrom(real)) {
            throw Object.assign(new Error(`${command} is in a folder the bots can write, so the server does not run it outside the bot box.`), { code: "EACCES" });
        }
    }
    const env = opts.env ?? process.env;
    return { ...opts, env: { ...env, PATH: serverPath(env.PATH) } };
}
export function spawnCli(cli, args, opts, owner = "openmausbot") {
    const resolved = resolveCli(cli, args);
    assertSafeCliArgv(resolved);
    const homed = owner === "bot" || opts.engineHome ? engineHomes.forSpawn(opts.env ?? process.env) : null;
    const env = homed?.env ?? opts.env;
    const options = resolved.env
        ? { ...opts, env: { ...(env ?? process.env), ...resolved.env } }
        : homed ? { ...opts, env } : opts;
    const boxed = boxedSpawn(resolved, options, owner, homed);
    const { box: _box, engineHome: _engineHome, botWork, ...spawnOpts } = boxed ? options : outsideBoxOptions(resolved.command, options);
    // The box's extra descriptors (its seccomp filter) follow stdio; only a plain three-entry stdio can take them.
    const stdio = boxed?.extraFds.length && Array.isArray(spawnOpts.stdio) && spawnOpts.stdio.length === 3 ? [...spawnOpts.stdio, ...boxed.extraFds] : spawnOpts.stdio;
    // A server that restarts in place stops what an earlier one left by this tag (engine-records.ts).
    const tag = process.platform === "win32" ? null : engineRunTag();
    const start = () => spawn(boxed?.command ?? resolved.command, boxed?.args ?? resolved.args, {
        ...spawnOpts,
        ...(boxed ? { env: boxed.env, stdio } : {}),
        ...(tag ? { env: { ...(boxed?.env ?? spawnOpts.env ?? process.env), [ENGINE_TAG_ENV]: tag } } : {}),
        // POSIX: own group so kill(-pid) reaps child MCP servers; Windows: taskkill /T does it.
        ...(process.platform === "win32" ? { windowsHide: true } : { detached: true }),
    });
    let child;
    const refused = (code) => { processBudget.spawnFailed(code); engineMemory.spawnRefused(code, owner === "bot"); };
    try {
        child = owner === "bot" || botWork ? spawnBotWork(start) : start();
    }
    catch (error) {
        // Node throws some refusals (ENOMEM) at once rather than reporting them on the child.
        if (shortageCode(error))
            refused(error.code);
        throw error;
    }
    finally {
        for (const fd of boxed?.extraFds ?? [])
            try {
                closeSync(fd);
            }
            catch { }
    }
    rememberLiveSpawn(child, [resolved.command, ...resolved.args]);
    // Node reports most refused spawns (EAGAIN, EMFILE, ENOENT) on the child, a tick later, with no pid.
    child.once("error", (error) => { if (!child.pid)
        refused(error.code); });
    // The broker token minted for this process dies with it.
    if (boxed?.token)
        child.once("exit", boxed.release);
    if (process.platform !== "win32")
        cliGroups.add(child);
    if (process.platform === "linux" && child.pid) {
        const tree = new Map();
        try {
            const root = linuxProcess(child.pid);
            if (root)
                tree.set(root.pid, root.start);
        }
        catch { }
        linuxTrees.set(child, tree);
    }
    if (process.platform !== "win32")
        recordEngine(child, child.pid ? linuxTrees.get(child)?.get(child.pid) ?? null : null);
    if (process.platform !== "win32" && owner === "bot") {
        rememberEngineSession(child);
        engineMemory.track(child);
    }
    // On Windows a stdin write between taskkill and pipe close errors asynchronously; unlistened, that crashes the harness.
    child.stdin?.on("error", () => { });
    return child;
}
/** execCli's answer for a spawn that runs in the bot box where it is on (`box`), as a bot's own would: an engine's
 * status or catalog read that loads the engine's settings, extensions or MCP servers from a HOME a bot can write. */
export function execCliBoxed(cli, args, opts, cb) {
    const limit = opts.maxBuffer ?? 1024 * 1024;
    let child;
    try {
        child = spawnCli(cli, args, { env: opts.env, cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], box: opts.box });
    }
    catch (error) {
        queueMicrotask(() => cb(error instanceof Error ? error : new Error(String(error)), "", ""));
        return;
    }
    child.stdin.end();
    let stdout = "", stderr = "", done = false, timedOut = false;
    const finish = (err) => {
        if (done)
            return;
        done = true;
        clearTimeout(timer);
        cb(err, stdout, stderr);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { if (stdout.length < limit)
        stdout += chunk.slice(0, limit - stdout.length); });
    child.stderr.on("data", (chunk) => { if (stderr.length < limit)
        stderr += chunk.slice(0, limit - stderr.length); });
    const timer = setTimeout(() => {
        timedOut = true;
        void killCliTree(child, 0);
    }, opts.timeout);
    timer.unref?.();
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
        if (timedOut)
            finish(cutOffError(cli, opts.timeout));
        else
            finish(code === 0 ? null : Object.assign(new Error(`${cli} exited with code ${code}`), { code }));
    });
}
const EXEC_KILL_GRACE_MS = 2_000;
export function execCli(cli, args, opts, cb) {
    const resolved = resolveCli(cli, args);
    try {
        assertSafeCliArgv(resolved);
        opts = outsideBoxOptions(resolved.command, opts);
    }
    catch (error) {
        queueMicrotask(() => cb(error instanceof Error ? error : new Error(String(error)), "", ""));
        return;
    }
    let escalate;
    let deadline;
    let timedOut = false;
    const env = resolved.env ? { ...(opts.env ?? process.env), ...resolved.env } : opts.env;
    const child = execFile(resolved.command, resolved.args, { ...opts, env, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
        clearTimeout(escalate);
        clearTimeout(deadline);
        cb(err ?? (timedOut ? cutOffError(cli, opts.timeout) : null), stdout, stderr);
    });
    // Node (24) calls back only once the child exits, and a CLI wrapper that traps SIGTERM outlives the timeout's signal.
    // Only the child is stopped: execFile starts no process group, so a grandchild that ignores SIGTERM can outlive it.
    // When its timeout fires after the child exited but before Node saw the exit, Node (24) drops the output and still
    // reports success; this timer is queued just after Node's, so it marks that run as timed out.
    if (opts.timeout) {
        escalate = setTimeout(() => void killCliTree(child, 0), opts.timeout + EXEC_KILL_GRACE_MS);
        escalate.unref?.();
        deadline = setTimeout(() => {
            timedOut = true;
        }, opts.timeout);
        deadline.unref?.();
    }
}
function cutOffError(cli, timeout) {
    return Object.assign(new Error(`${cli} timed out after ${timeout} ms`), { killed: true, code: null, signal: null });
}
export const CLI_VERSION_TIMEOUT_MS = 30_000;
export function cliVersionReader(cli) {
    let last = null;
    return (err, stdout) => {
        const version = err ? "" : stdout.trim();
        if (version)
            return { version: (last = version) };
        const failure = err;
        const timedOut = failure?.killed === true && typeof failure.code !== "string";
        if (failure?.code === "ENOENT") {
            last = null;
            return { reason: `\`${cli}\` CLI not found` };
        }
        if (failure?.code === "EACCES" || failure?.code === "EPERM") {
            last = null;
            return { reason: `\`${cli}\` could not run --version. Check its file permissions.` };
        }
        if (last && (timedOut || !err || typeof failure?.code === "number"))
            return { version: last };
        return { reason: timedOut
                ? `\`${cli}\` took longer than ${CLI_VERSION_TIMEOUT_MS / 1000} seconds to answer --version. The machine may be busy; check again.`
                : !err ? `\`${cli}\` returned no version. Check again.` : `\`${cli}\` could not report its version. Check that it starts in a terminal, then check again.` };
    };
}
export function describeSpawnFailure(err, cli, cwd) {
    const shortage = shortageCode(err);
    if (shortage)
        return { ...noticeFailure("chat.notice.outOfProcesses", { code: shortage }), setup: false };
    if (err.code === "ENOENT") {
        if (cwd && !existsSync(cwd))
            return { message: `This chat's working folder no longer exists: ${cwd}. Choose another folder in the bot's settings, or create it again.`, setup: false };
        return { message: `\`${cli}\` isn't installed, or isn't on this app's PATH`, setup: true };
    }
    if (err.code === "EACCES" || err.code === "EPERM")
        return { message: `\`${cli}\` isn't executable — check its file permissions`, setup: true };
    if (err.code === "ENAMETOOLONG")
        return {
            message: `\`${cli}\` received too much launch data for Windows; update this provider or pass its prompt through stdin/a file`,
            setup: false,
        };
    return { message: `spawn failed: ${err.message}`, setup: false };
}
/** timeoutMs is the TERM grace; SIGKILL gets one more second. Linux also stops captured detached descendants. */
export function killCliTree(child, timeoutMs = 5_000) {
    const existing = stopping.get(child);
    if (existing)
        return existing;
    const pid = child.pid;
    if (!pid)
        return Promise.resolve(true);
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid)
        return Promise.resolve(false);
    captureCliTree(child);
    const run = stopCliTree(child, pid, Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 5_000);
    stopping.set(child, run);
    // Remember success, so a delayed caller cannot signal a reused PID/group.
    void run.then((stopped) => { if (!stopped)
        stopping.delete(child);
    else
        engineStopped(child); });
    return run;
}
async function stopCliTree(child, pid, timeoutMs) {
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    if (process.platform !== "win32") {
        const group = cliGroups.has(child);
        const settled = () => {
            if (!exited() || !linuxDescendantsStopped(child))
                return false;
            if (!group || linuxRootIdentityMatches(child) === false)
                return true;
            if (linuxRootIdentityMatches(child) === undefined)
                return false;
            try {
                process.kill(-pid, 0);
                return process.platform === "linux" && linuxGroupOnlyExited(pid);
            }
            catch (error) {
                // EPERM and other failures do not prove that the group is gone.
                return error.code === "ESRCH";
            }
        };
        const signal = (value) => {
            captureCliTree(child);
            signalLinuxDescendants(child, value);
            try {
                if (group && (!exited() || linuxRootIdentityMatches(child) === true))
                    process.kill(-pid, value);
                else if (!group && !exited())
                    child.kill(value);
            }
            catch {
                if (!exited()) {
                    try {
                        child.kill(value);
                    }
                    catch { }
                }
            }
        };
        const wait = async (ms) => {
            const deadline = Date.now() + ms;
            while (!settled()) {
                const remaining = deadline - Date.now();
                if (remaining <= 0) {
                    // Timers run before libuv's poll phase reads SIGCHLD: a blocked loop reaches the deadline with the exit unread.
                    await new Promise((resolve) => setImmediate(resolve));
                    return settled();
                }
                await exitOrDelay(child, Math.min(25, remaining));
            }
            return true;
        };
        if (settled())
            return true;
        if (exited())
            processBudget.noteLateReaped();
        signal("SIGTERM");
        if (await wait(timeoutMs))
            return true;
        processBudget.noteForceKilled();
        signal("SIGKILL");
        return wait(1_000);
    }
    if (exited())
        return true;
    return new Promise((resolve) => {
        let timer;
        let finished = false;
        const done = (stopped) => {
            if (finished)
                return;
            finished = true;
            clearTimeout(timer);
            child.off("close", closed);
            child.off("exit", closed);
            resolve(stopped);
        };
        const closed = () => done(true);
        child.once("close", closed);
        timer = setTimeout(() => done(false), timeoutMs);
        timer.unref?.();
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (err) => {
            if (finished)
                return;
            if (!err) {
                // taskkill can finish before Node sees the exit, and callers may rename the executable at once: wait for both, not for inherited pipes.
                if (exited())
                    done(true);
                else
                    child.once("exit", closed);
                return;
            }
            try {
                child.kill();
            }
            catch {
            }
            // taskkill /T also fails when one process in the tree could not be stopped; that one may still hold the pipes the CLI
            // inherited, so "close" never comes. The CLI itself exiting is what counts.
            if (exited())
                done(true);
            else
                child.once("exit", closed);
        });
    });
}
function exitOrDelay(child, ms) {
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            child.off("exit", done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        child.once("exit", done);
    });
}
/** True once the process itself has exited, within `ms`; members it left in its group are not counted. */
export async function waitForExit(child, ms) {
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const deadline = Date.now() + ms;
    while (!exited() && Date.now() < deadline)
        await exitOrDelay(child, Math.min(250, deadline - Date.now()));
    if (!exited())
        await new Promise((resolve) => setImmediate(resolve));
    return exited();
}
/** Unix socket on POSIX, named pipe on Windows (Node cannot listen on a filesystem socket path there: EACCES). */
export function brokerSocketPath(dataDir, tag) {
    return process.platform === "win32"
        // Named pipes share a global namespace that DATA_DIR cannot isolate.
        ? `\\\\.\\pipe\\openmausbot-perm-${process.pid}-${tag}`
        : join(dataDir, `perm-${tag}.sock`);
}
