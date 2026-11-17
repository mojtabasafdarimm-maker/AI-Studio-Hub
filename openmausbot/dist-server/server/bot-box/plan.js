// The bot box's plan: what one boxed process sees, as a list of mounts and the bubblewrap argv that makes it.
//
// What the box sees:
//   - the image's code read-only: /usr (with /bin, /lib, /lib64 and /sbin as the links a merged-/usr Debian has), /etc,
//     /opt (the bots' browser) and the server's own code folder, so the engine CLIs and the proxies they start run;
//   - its HOME read-write (the engine's own login and settings live there), with the server's data folder replaced by an
//     empty private folder, so messages.db, config.json, logins, other bots' folders and the server's sockets are not there;
//     on a Team Cloud that HOME is the audience's engine home instead (server/engine-homes), with only the team's engine
//     sign-ins bound into it, so no other audience's transcripts are there;
//   - put back inside that empty folder: this turn's working folder, the bot's own folder (workspaces/<bot>) and what the
//     caller names (the turn's permission socket, a read-only file the command line points at); and, read-only, the
//     bot's own SOUL.md (bots/<bot>/SOUL.md, which it may read but never write) and the engines OpenMausBot installed
//     there, whole, since npm's bin links point into the prefix by relative paths;
//   - a private /proc (its own PID namespace: other turns' processes do not exist for it), /dev, /tmp and /run;
//   - of /sys, only the machine's CPU list, read-only;
//   - a network namespace with loopback only. Two loopback ports inside are bridged to unix sockets bound in from outside:
//     the egress gate (every connection to the internet goes through it) and the harness gate (only /api/internal/
//     routes of this server). Nothing else on the server's loopback is reachable. A box that waits for a sign-in callback
//     also dials out to one more socket, through which the server reaches the box's own loopback, never the other way.
import { statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
export const BOX_MUTATIONS = ["bind-data", "bind-otherws", "share-pid", "share-net", "env-all", "tmp-shared", "no-seccomp", "engines-rw"];
export const IN_BOX_SOCKET_DIR = "/run/omb";
export const RELAY_SOCKET_NAME = "relay";
export const BOX_HOSTNAME = "omb-box";
const ID = /^[A-Za-z0-9_-]{1,128}$/;
/** `child` is `parent` or below it. */
export function under(child, parent) {
    const rel = relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
/** The bot and conversation of a task workspace (`<data>/task-workspaces/<bot>/<thread>`), or null. */
export function taskWorkspaceIds(cwd, dataDir) {
    const rel = relative(join(dataDir, "task-workspaces"), cwd).split(sep);
    if (rel.length < 2 || !ID.test(rel[0]) || !ID.test(rel[1]) || rel[0] === "..")
        return null;
    return { botId: rel[0], threadId: rel[1] };
}
/** The server-owned folder holding a conversation's uploads for its boxes (server/box-attachments.ts), bound read-only. */
export function boxUploadsDir(dataDir, botId, threadId) {
    return join(dataDir, "box-uploads", botId, threadId);
}
/** Absolute paths on the command line (`/x/y` or `--flag=/x/y`), which the engine must be able to read. */
export function argvPaths(args) {
    const paths = [];
    for (const arg of args) {
        const optionValue = arg.startsWith("--") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
        const value = optionValue.startsWith("@") ? optionValue.slice(1) : optionValue;
        if (isAbsolute(value) && value.length > 1 && !paths.includes(value))
            paths.push(resolve(value));
    }
    return paths;
}
/** Environment values that name folders the engine writes: its own config and caches. */
export const PATH_ENV_NAMES = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "GROK_HOME", "OPENCODE_HOME", "HERMES_HOME", "GEMINI_HOME", "TMPDIR"];
/** The only part of /sys the box has: how many CPUs the machine has. Programs built with TCMalloc (Google's Antigravity
 * runtime) read `possible` at start and stop themselves (SIGABRT, exit 134) when it is missing. */
export const CPU_LIST_FILES = ["/sys/devices/system/cpu/possible", "/sys/devices/system/cpu/online"];
/** Folders the box always has its own copy of, so no setting may put the host's back. */
const PRIVATE_INSIDE = ["/tmp", "/var/tmp", "/run", "/dev", "/proc"];
function assertReadOnlySource(source) {
    try {
        const stat = statSync(source);
        if (stat.isFile() && stat.nlink > 1) {
            throw new Error(`The bot box refuses a multiply-linked read-only file: ${source}; grant a separate single-link copy instead.`);
        }
    }
    catch (error) {
        if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code ?? ""))
            throw error;
    }
}
export function planBox(setup, request) {
    const mutate = setup.mutate ?? new Set();
    const dataDir = resolve(setup.dataDir), home = resolve(setup.home);
    const net = mutate.has("share-net") ? "shared" : request.net ?? "isolated";
    const mounts = [
        { kind: "ro", source: "/usr", target: "/usr" },
        { kind: "symlink", link: "/bin", target: "usr/bin" },
        { kind: "symlink", link: "/lib", target: "usr/lib" },
        { kind: "symlink", link: "/lib64", target: "usr/lib64" },
        { kind: "symlink", link: "/sbin", target: "usr/sbin" },
        { kind: "ro", source: "/etc", target: "/etc" },
        { kind: "ro", source: "/opt", target: "/opt", optional: true },
        { kind: "ro", source: "/var/lib", target: "/var/lib", optional: true },
        ...CPU_LIST_FILES.map((file) => ({ kind: "ro", source: file, target: file, optional: true })),
    ];
    for (const root of setup.codeRoots) {
        const code = resolve(root);
        if (["/usr", "/etc", "/opt", "/var/lib"].some((base) => under(code, base)))
            continue;
        mounts.push({ kind: "ro", source: code, target: code });
    }
    mounts.push({ kind: "proc", target: "/proc" }, { kind: "dev", target: "/dev" });
    if (mutate.has("tmp-shared"))
        mounts.push({ kind: "bind", source: "/tmp", target: "/tmp" });
    else
        mounts.push({ kind: "tmpfs", target: "/tmp" });
    mounts.push({ kind: "tmpfs", target: "/var/tmp" }, { kind: "tmpfs", target: "/run" });
    const writable = [];
    const rw = (path) => {
        mounts.push({ kind: "bind", source: path, target: path });
        if (!writable.includes(path))
            writable.push(path);
    };
    // HOME first; the data folder is replaced by an empty one right after, so the lines below put back only what is named.
    // An engine home lives in the data folder, so it goes back after that.
    const ownHome = request.home ? resolve(request.home) : null;
    if (!ownHome)
        rw(home);
    const dataInsideHome = under(dataDir, home);
    if (!mutate.has("bind-data")) {
        if (dataInsideHome)
            mounts.push({ kind: "tmpfs", target: dataDir });
    }
    else {
        rw(dataDir);
    }
    if (ownHome)
        rw(ownHome);
    const dataHidden = !mutate.has("bind-data");
    /** A path is already readable and writable through an earlier line (and not hidden by the data folder's tmpfs). */
    const covered = (path) => (ownHome !== null && under(path, ownHome)) || (writable.some((root) => under(path, root)) && !(dataHidden && under(path, dataDir)));
    const cwd = request.cwd ? resolve(request.cwd) : null;
    const ids = cwd ? taskWorkspaceIds(cwd, dataDir) : null;
    const botId = request.botId ?? ids?.botId ?? null;
    const threads = request.botThreads && ids ? ids.botId : null;
    if (threads)
        rw(join(dataDir, "task-workspaces", threads));
    if (cwd && !covered(cwd))
        rw(cwd);
    if (botId && ID.test(botId)) {
        const own = join(dataDir, "workspaces", botId);
        if (!covered(own))
            rw(own);
    }
    const ownFolders = botId && ID.test(botId) ? [join(dataDir, "workspaces", botId), join(dataDir, "task-workspaces", botId)] : [];
    if (mutate.has("bind-otherws")) {
        rw(join(dataDir, "workspaces"));
        rw(join(dataDir, "task-workspaces"));
    }
    for (const name of PATH_ENV_NAMES) {
        const value = request.env[name];
        // A temp folder stays the box's own private one; anything else the engine writes is put back.
        if (!value || !isAbsolute(value) || covered(resolve(value)) || PRIVATE_INSIDE.some((base) => under(resolve(value), base)))
            continue;
        if (request.configured && (under(resolve(value), dataDir) || under(dataDir, resolve(value))) && !ownFolders.some((folder) => under(resolve(value), folder)))
            continue;
        rw(resolve(value));
    }
    for (const path of request.rw ?? [])
        if (!covered(resolve(path)))
            rw(resolve(path));
    if (ownHome) {
        for (const file of request.shared ?? []) {
            if (under(resolve(file.target), ownHome))
                mounts.push({ kind: "bind", source: resolve(file.source), target: resolve(file.target), optional: true });
        }
    }
    // After every read-write line, so none of them can make an engine another conversation also runs writable.
    for (const root of setup.engineRoots) {
        const engines = resolve(root);
        mounts.push({ kind: mutate.has("engines-rw") ? "bind" : "ro", source: engines, target: engines, optional: true });
    }
    // The person's uploads for this conversation, after every read-write line: readable, but never writable or swappable.
    if (ids) {
        const shown = threads ? join(dataDir, "box-uploads", threads) : boxUploadsDir(dataDir, ids.botId, ids.threadId);
        mounts.push({ kind: "ro", source: shown, target: shown, optional: true });
    }
    const readOnly = new Set();
    const inBotFolder = (path) => ["workspaces", "task-workspaces"].some((kind) => {
        const [owner, ...rest] = relative(join(dataDir, kind), path).split(sep);
        return owner !== undefined && ID.test(owner) && !rest.includes("..") && (botId ? owner === botId : true);
    });
    const named = new Set((request.ro ?? []).map((path) => resolve(path)));
    // Only a caller's own `ro` grant may put a read-only copy over a writable folder, never the implicit SOUL.md line.
    const asked = new Set(named);
    if (botId && ID.test(botId))
        named.add(join(dataDir, "bots", botId, "SOUL.md"));
    for (const path of [...(request.ro ?? []), ...argvPaths(request.args), ...(botId && ID.test(botId) ? [join(dataDir, "bots", botId, "SOUL.md")] : [])]) {
        const full = resolve(path);
        if (request.ro?.includes(path))
            assertReadOnlySource(full);
        // Security: a command line is not a grant. A path on one that is in the data folder, or holds it, is shown only
        // when the caller named it in `ro`, or when it is in a bot's folder: this box's bot's, or any bot's where the caller
        // gave no bot (a configured server's program lives in the folder of the bot that added it).
        if (!named.has(full) && (under(full, dataDir) || under(dataDir, full)) && !covered(full) && !inBotFolder(full))
            continue;
        // Code and the system are already there; a file under HOME or /tmp the command line names is put back read-only.
        if ((!asked.has(full) && covered(full)) || readOnly.has(full))
            continue;
        if (["/usr", "/etc", "/opt", "/var/lib", ...setup.codeRoots, ...setup.engineRoots].some((base) => under(full, resolve(base))))
            continue;
        readOnly.add(full);
        mounts.push({ kind: "ro", source: full, target: full, optional: true });
    }
    const options = ["--unshare-user", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try", "--die-with-parent", "--hostname", BOX_HOSTNAME];
    if (!mutate.has("share-pid"))
        options.push("--unshare-pid");
    if (setup.seccompFd !== undefined && !mutate.has("no-seccomp"))
        options.push("--seccomp", String(setup.seccompFd));
    if (net === "isolated") {
        options.push("--unshare-net");
        mounts.push({ kind: "dir", target: IN_BOX_SOCKET_DIR });
        for (const bridge of setup.bridges)
            mounts.push({ kind: "bind", source: bridge.socket, target: join(IN_BOX_SOCKET_DIR, `${bridge.name}.sock`) });
        if (request.relay)
            mounts.push({ kind: "bind", source: resolve(request.relay), target: inBoxSocket(RELAY_SOCKET_NAME) });
    }
    if (cwd)
        options.push("--chdir", cwd);
    return { mounts, options, net, writable, botId };
}
/** bubblewrap's argv for the plan (the command follows `--`). */
export function bwrapArgs(plan) {
    const args = [];
    for (const mount of plan.mounts) {
        switch (mount.kind) {
            case "ro":
                assertReadOnlySource(mount.source);
                args.push(mount.optional ? "--ro-bind-try" : "--ro-bind", mount.source, mount.target);
                break;
            case "bind":
                args.push(mount.optional ? "--bind-try" : "--bind", mount.source, mount.target);
                break;
            case "tmpfs":
                args.push("--tmpfs", mount.target);
                break;
            case "proc":
                args.push("--proc", mount.target);
                break;
            case "dev":
                args.push("--dev", mount.target);
                break;
            case "dir":
                args.push("--dir", mount.target);
                break;
            case "symlink":
                args.push("--symlink", mount.target, mount.link);
                break;
        }
    }
    args.push(...plan.options);
    return args;
}
/** Whether `path` is visible inside the box, by the plan alone: the last line that covers it decides. */
export function visibleInBox(plan, path) {
    const full = resolve(path);
    let verdict = "none";
    for (const mount of plan.mounts) {
        if (mount.kind === "symlink")
            continue;
        if (!under(full, mount.target))
            continue;
        if (mount.kind === "bind")
            verdict = "rw";
        else if (mount.kind === "ro")
            verdict = "ro";
        else
            verdict = "none";
    }
    return verdict;
}
export function inBoxSocket(name) {
    return join(IN_BOX_SOCKET_DIR, `${name}.sock`);
}
