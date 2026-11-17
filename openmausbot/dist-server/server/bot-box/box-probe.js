// Runs INSIDE a bot box (self-check.ts starts it) and tries what a hostile bot would: the server's database and settings,
// another bot's folders, another turn's process and environment, the server's own loopback routes, the local network,
// the cloud metadata service and the engines every turn runs; and what a legitimate turn needs: its own folders, an
// engine OpenMausBot installed, the harness routes and the public internet. Prints one JSON line of results. Every
// check is named here once, so the report's `checks: n/n` means these.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
export const PROBE_SPEC_ENV = "OMB_BOX_PROBE";
/** A process's start, in clock ticks since boot: field 22 of /proc/<pid>/stat, counted after the command's last ")". */
export function processStart(pid, read = (path) => readFileSync(path, "utf8")) {
    try {
        const stat = read(`/proc/${pid}/stat`);
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
    }
    catch {
        return null;
    }
}
/** The box's /proc shows that very process, not one of its own that got the same pid. */
export function seesProcess(pid, start, startOf = processStart) {
    return start ? startOf(pid) === start : existsSync(`/proc/${pid}`);
}
const fails = (fn) => {
    try {
        fn();
        return { failed: false, code: "ok" };
    }
    catch (error) {
        return { failed: true, code: error.code ?? "error" };
    }
};
function connectStatus(port, host, timeoutMs = 2_000) {
    return new Promise((resolve) => {
        const socket = connect({ host, port });
        socket.setTimeout(timeoutMs, () => { socket.destroy(); resolve("timeout"); });
        socket.once("connect", () => { socket.destroy(); resolve("connected"); });
        socket.once("error", (error) => resolve(error.code ?? "error"));
    });
}
function httpStatus(port, path) {
    return new Promise((resolve) => {
        const req = request({ host: "127.0.0.1", port, path, method: "GET", timeout: 5_000 }, (res) => { res.resume(); resolve(String(res.statusCode)); });
        req.on("timeout", () => { req.destroy(); resolve("timeout"); });
        req.on("error", (error) => resolve(error.code ?? "error"));
        req.end();
    });
}
/** `CONNECT host:port` through the egress bridge: the status line's code. */
function connectThroughGate(port, target) {
    return new Promise((resolve) => {
        const socket = connect({ host: "127.0.0.1", port });
        let buffer = "";
        socket.setTimeout(10_000, () => { socket.destroy(); resolve("timeout"); });
        socket.once("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
        socket.on("data", (chunk) => {
            buffer += chunk.toString("latin1");
            if (buffer.includes("\r\n\r\n")) {
                socket.destroy();
                resolve(/^HTTP\/1\.[01] (\d{3})/.exec(buffer)?.[1] ?? "malformed");
            }
        });
        socket.once("error", (error) => resolve(error.code ?? "error"));
    });
}
function scanForMarker(root, marker, budget) {
    let hits = 0;
    let entries;
    try {
        entries = readdirSync(root);
    }
    catch {
        return 0;
    }
    for (const name of entries) {
        if (budget.files-- <= 0)
            return hits;
        const path = join(root, name);
        try {
            const stat = statSync(path);
            if (stat.isDirectory())
                hits += scanForMarker(path, marker, budget);
            else if (stat.isFile() && stat.size < 1_000_000 && readFileSync(path, "latin1").includes(marker))
                hits += 1;
        }
        catch { }
    }
    return hits;
}
export async function runProbe(spec, env = process.env) {
    const results = [];
    const add = (id, ok, detail) => results.push({ id, ok, detail });
    const hidden = (id, path) => { const r = fails(() => readFileSync(path)); add(id, r.failed, r.code); };
    hidden("messages-db-hidden", spec.messagesDb);
    hidden("config-hidden", spec.configJson);
    let listing = [];
    try {
        listing = readdirSync(spec.dataDir);
    }
    catch { }
    const leaked = listing.filter((name) => spec.serverFiles.includes(name));
    add("data-dir-empty", leaked.length === 0, leaked.length ? `sees ${leaked.join(",")}` : `sees ${listing.length} entries`);
    hidden("other-bot-folder-hidden", join(spec.otherWorkspace, "MEMORY.md"));
    hidden("other-task-folder-hidden", join(spec.otherTaskWorkspace, "notes.md"));
    add("fly-api-hidden", !existsSync("/.fly"), existsSync("/.fly") ? "/.fly visible" : "absent");
    // The spec itself names the marker; every other value must not.
    const inEnv = Object.entries(env).filter(([name, value]) => name !== PROBE_SPEC_ENV && value?.includes(spec.marker)).map(([name]) => name);
    add("secret-not-in-env", inEnv.length === 0, inEnv.length ? `in ${inEnv.join(",")}` : "absent");
    const onDisk = scanForMarker(spec.dataDir, spec.marker, { files: 5_000 }) + scanForMarker("/tmp", spec.marker, { files: 5_000 }) + scanForMarker(spec.cwd, spec.marker, { files: 5_000 });
    add("secret-not-on-disk", onDisk === 0, `${onDisk} hits`);
    const canaryVisible = seesProcess(spec.canaryPid, spec.canaryStart);
    add("other-pid-hidden", !canaryVisible, canaryVisible ? "visible" : "absent");
    const environ = fails(() => readFileSync(`/proc/${spec.canaryPid}/environ`));
    add("other-env-unreadable", !canaryVisible || environ.failed, canaryVisible ? environ.code : "absent");
    const serverVisible = seesProcess(spec.serverPid, spec.serverStart);
    add("server-pid-hidden", !serverVisible, serverVisible ? "visible" : "absent");
    const own = fails(() => { writeFileSync(join(spec.cwd, ".box-probe"), "ok"); if (readFileSync(join(spec.cwd, ".box-probe"), "utf8") !== "ok")
        throw new Error("mismatch"); });
    add("own-cwd-rw", !own.failed, own.code);
    const folder = fails(() => writeFileSync(join(spec.botFolder, ".box-probe"), "ok"));
    add("bot-folder-rw", !folder.failed, folder.code);
    const engine = spawnSync(spec.engine.name, [], { encoding: "utf8", timeout: 10_000, env: env });
    add("engine-runs", engine.stdout?.trim() === spec.engine.says, engine.error ? engine.error.code ?? "error" : `exit ${engine.status}`);
    const tamper = fails(() => writeFileSync(join(spec.engine.bin, ".box-probe"), "#!/bin/sh\n"));
    add("engine-read-only", existsSync(join(spec.engine.bin, spec.engine.name)) && tamper.failed, tamper.code);
    add("tmp-private", !existsSync(spec.hostTmpFile), existsSync(spec.hostTmpFile) ? "host /tmp visible" : "private");
    add("hostname-private", hostname() === "omb-box", hostname() === "omb-box" ? "omb-box" : "host name visible");
    if (spec.cpuList) {
        // TCMalloc runtimes (Google's Antigravity) stop at start without it: exit 134.
        const cpus = fails(() => { if (!/^\d/.test(readFileSync("/sys/devices/system/cpu/possible", "utf8")))
            throw new Error("empty"); });
        add("cpu-list-readable", !cpus.failed, cpus.code);
    }
    add("harness-internal-allowed", (await httpStatus(spec.harnessPort, "/api/internal/box-probe")) === "200", "GET /api/internal/box-probe");
    add("harness-other-refused", (await httpStatus(spec.harnessPort, "/api/bots")) === "403", "GET /api/bots");
    if (spec.isolatedNet) {
        const direct = await connectStatus(spec.privatePort, "127.0.0.1");
        add("host-loopback-unreachable", direct !== "connected", direct);
        const outside = await connectStatus(443, "1.1.1.1", 3_000);
        add("no-direct-internet", outside !== "connected", outside);
    }
    add("egress-loopback-refused", (await connectThroughGate(spec.egressPort, `127.0.0.1:${spec.privatePort}`)) === "403", "CONNECT loopback");
    add("egress-metadata-refused", (await connectThroughGate(spec.egressPort, "169.254.169.254:80")) === "403", "CONNECT metadata");
    add("egress-private-refused", (await connectThroughGate(spec.egressPort, "10.0.0.1:443")) === "403", "CONNECT private");
    if (spec.publicTarget)
        add("egress-public-allowed", (await connectThroughGate(spec.egressPort, spec.publicTarget)) === "200", `CONNECT ${spec.publicTarget}`);
    if (spec.seccomp) {
        // add_key(2) into the process keyring: fine for any user, EPERM under the box's filter. python3 is in the image.
        const probe = "import ctypes,os;l=ctypes.CDLL(None,use_errno=True);r=l.syscall(248,b'user',b'omb-box-probe',b'v',1,-2);print('ok' if r>=0 else os.strerror(ctypes.get_errno()))";
        const result = spawnSync("python3", ["-c", probe], { encoding: "utf8", timeout: 10_000 });
        const text = (result.stdout || result.stderr || "").trim();
        add("keyring-denied", /Operation not permitted/.test(text), text.slice(0, 60) || `exit ${result.status}`);
    }
    if (spec.broker) {
        const { port, token, provider, path, keyNames, marker: key } = spec.broker;
        const keys = keyNames.filter((name) => !env[name] || !env[name].startsWith("omb_t0_"));
        const anywhere = Object.entries(env).filter(([name, value]) => name !== PROBE_SPEC_ENV && value?.includes(key)).map(([name]) => name);
        add("no-provider-key-in-env", keys.length === 0 && anywhere.length === 0, anywhere.length ? `raw key in ${anywhere.join(",")}` : keys.length ? `no token in ${keys.join(",")}` : "tokens only");
        const base = env.ANTHROPIC_BASE_URL ?? "";
        add("base-url-is-broker", base === `http://127.0.0.1:${port}/b/${token}/${provider}`, base ? "points at the broker" : "unset");
        add("broker-call-works", (await httpStatus(port, `/b/${token}/${provider}${path}`)) === "200", `GET /b/<token>/${provider}${path}`);
        add("broker-wrong-token-refused", (await httpStatus(port, `/b/omb_t0_${"0".repeat(48)}/${provider}${path}`)) === "401", "wrong token");
        add("broker-other-grant-refused", (await httpStatus(port, `/b/${token}/openai${path}`)) === "403", "a grant the token lacks");
        add("broker-key-not-on-disk", scanForMarker(spec.dataDir, key, { files: 5_000 }) + scanForMarker("/tmp", key, { files: 5_000 }) === 0, "0 hits");
    }
    return results;
}
if (process.argv[1] && /box-probe\.[jt]s$/.test(process.argv[1])) {
    const raw = process.env[PROBE_SPEC_ENV];
    if (!raw) {
        console.error(`${PROBE_SPEC_ENV} is not set`);
        process.exit(2);
    }
    runProbe(JSON.parse(raw)).then((results) => { process.stdout.write(`${JSON.stringify({ results })}\n`); }, (error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
