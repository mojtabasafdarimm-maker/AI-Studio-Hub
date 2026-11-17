// The bot box runtime: one per server. Decides once at boot whether turns are boxed (detect.ts), opens the two gates the
// boxes reach through unix sockets (egress-gate.ts, harness-gate.ts), and wraps each bot spawn (server/procs.ts spawnCli
// with owner "bot") in bubblewrap by the plan (plan.ts). Nothing here changes a spawn when the box is off: the command,
// its arguments and its environment go through untouched, so every host that is not a Cloud home behaves as before.
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { engineInstallRoots } from "../engine-roots.js";
import { homeProgramDirs, resetPathCache } from "../env-path.js";
import { SERVER_ROOT, resolveProxy } from "../proxy-paths.js";
import { bridgedCommand } from "./bridge.js";
import { brokerRewrite } from "./broker-env.js";
import { openCredentialBroker } from "./broker.js";
import { detectBox } from "./detect.js";
import { openBoxEgressGate } from "./egress-gate.js";
import { boxEnvironment } from "./env.js";
import { openHarnessGate } from "./harness-gate.js";
import { distrustHomePrograms } from "./program-trust.js";
import { procHidepid } from "./hidepid.js";
import { DENIED_SYSCALLS, seccompBytes, seccompSupported } from "./seccomp.js";
import { RELAY_SOCKET_NAME, boxUploadsDir, bwrapArgs, inBoxSocket, planBox, taskWorkspaceIds } from "./plan.js";
import { openBoxRelay } from "./relay.js";
/** The loopback port inside a box that reaches the egress gate. The harness gate sits at the server's own port. */
export const BOX_EGRESS_PORT = 3128;
/** What the box sets on an isolated network: the egress proxy, and the local hosts that skip it. */
export const BOX_PROXY_ENV = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"], BOX_NO_PROXY_ENV = ["NO_PROXY", "no_proxy"];
/** The loopback port inside a box that reaches the credential broker. */
export const BOX_BROKER_PORT = 18080;
/** The descriptor the box reads its seccomp filter from: the first after stdio. */
export const BOX_SECCOMP_FD = 3;
export const BOX_BRIDGE_SCRIPT = resolveProxy("bot-box/box-bridge");
export const BOX_PROBE_SCRIPT = resolveProxy("bot-box/box-probe");
/** Wraps spawns for one setup (the server's, or a self-check fixture's). */
export class BoxRunner {
    options;
    /** Paths a conversation's turns may write besides the bot's own folder (a member's or a room's memory layer on a Team Cloud). */
    lent = new Map();
    constructor(options) { this.options = options; }
    get setup() { return this.options.setup; }
    /** Lends `rw` paths to every box of this conversation until `lend` is called again with none. */
    lend(botId, threadId, rw) {
        if (rw.length)
            this.lent.set(`${botId}/${threadId}`, [...rw]);
        else
            this.lent.delete(`${botId}/${threadId}`);
    }
    lentTo(botId, threadId) {
        return this.lent.get(`${botId}/${threadId}`) ?? [];
    }
    wrap(given) {
        const ids = given.cwd ? taskWorkspaceIds(given.cwd, this.options.setup.dataDir) : null;
        const lent = ids ? this.lentTo(ids.botId, ids.threadId) : [];
        // Made before the box starts, so an upload a later turn adds shows up in a box that is still running.
        if (ids)
            try {
                mkdirSync(boxUploadsDir(this.options.setup.dataDir, ids.botId, ids.threadId), { recursive: true, mode: 0o700 });
            }
            catch (error) {
                // The bind stays optional, but an upload named later would then be unreadable in this box: say so.
                console.error(`bot box: could not make the uploads folder, so uploads stay unreadable in this box: ${error instanceof Error ? error.message : String(error)}`);
            }
        const request = lent.length ? { ...given, rw: [...(given.rw ?? []), ...lent] } : given;
        const extraFds = [];
        const seccomp = this.options.seccompFile && !this.options.setup.mutate?.has("no-seccomp") ? this.options.seccompFile : null;
        const plan = planBox({ ...this.options.setup, seccompFd: seccomp ? BOX_SECCOMP_FD : undefined }, request);
        const mutate = this.options.setup.mutate;
        const env = mutate?.has("env-all")
            ? Object.fromEntries(Object.entries(request.env).filter((entry) => entry[1] !== undefined))
            : boxEnvironment(request.env, this.options.denyEnv, new Set(request.allowEnv ?? []));
        // The server's own PATH leaves out the programs in HOME (program-trust.ts); inside the box they are the bot's own.
        const homePrograms = homeProgramDirs(resolve(request.home ?? this.options.setup.home)).filter((dir) => !(env.PATH ?? "").split(":").includes(dir));
        if (homePrograms.length)
            env.PATH = [...(env.PATH ? [env.PATH] : []), ...homePrograms].join(":");
        if (plan.net === "isolated") {
            const proxy = `http://127.0.0.1:${this.options.egressPort ?? BOX_EGRESS_PORT}`;
            for (const name of BOX_PROXY_ENV)
                env[name] = proxy;
            // Node's env proxy matches an IPv6 host only bracketed; curl and the engines take the plain forms.
            for (const name of BOX_NO_PROXY_ENV)
                env[name] = "127.0.0.1,localhost,::1,[::1]";
        }
        const bridges = plan.net === "isolated" ? this.options.setup.bridges : [];
        const relay = plan.net === "isolated" && request.relay ? inBoxSocket(RELAY_SOCKET_NAME) : undefined;
        const inner = bridgedCommand(this.options.bridge, bridges, request.command, request.args, relay);
        const brokered = this.broker(env, plan, request);
        try {
            const vouched = (request.allowEnv ?? []).filter((name) => /(?:KEY|TOKEN|SECRET)$/.test(name) && brokered.env[name] !== undefined && brokered.env[name] === request.env[name]);
            const unbrokered = [...new Set([...brokered.unbrokered, ...vouched])];
            if (seccomp)
                extraFds.push(openSync(seccomp, "r"));
            return { command: this.options.bwrap, args: [...bwrapArgs(plan), "--", inner.command, ...inner.args], env: brokered.env, plan, token: brokered.token, release: brokered.release, unbrokered, extraFds };
        }
        catch (error) {
            for (const fd of extraFds) {
                try {
                    closeSync(fd);
                }
                catch { }
            }
            brokered.release();
            throw error;
        }
    }
    /** Keys become a per-process token when the broker is on and the box has its own network (the bridge to the broker). */
    broker(env, plan, request) {
        const broker = this.options.broker;
        if (!broker || plan.net !== "isolated")
            return { env, token: null, release: () => { }, unbrokered: [] };
        const ids = request.cwd ? taskWorkspaceIds(request.cwd, this.options.setup.dataDir) : null;
        // The token is minted first (its value goes in the environment), then granted exactly what the rewrite took out.
        // A process the bot's conversations share belongs to none of them.
        const threadId = request.botThreads ? null : ids?.threadId ?? null;
        const minted = broker.mintForProcess({ botId: plan.botId, threadId, grants: {} });
        const rewrite = brokerRewrite(env, minted.token, broker.port);
        broker.revoke(minted.token);
        if (!Object.keys(rewrite.grants).length)
            return { env, token: null, release: () => { }, unbrokered: rewrite.unbrokered };
        const granted = broker.mintForProcess({ botId: plan.botId, threadId, grants: rewrite.grants });
        const again = brokerRewrite(env, granted.token, broker.port);
        return { env: again.env, token: granted.token, release: () => broker.revoke(granted.token), unbrokered: again.unbrokered };
    }
}
/** The filter file, written once at start (0600) and handed to each box on a read-only descriptor. */
export function writeSeccompFile(dir) {
    if (!seccompSupported())
        return null;
    const file = join(dir, "seccomp.bpf");
    writeFileSync(file, seccompBytes(), { mode: 0o600 });
    return file;
}
/** Whether Fly's local API socket folder is root's alone (no bits for group or others). */
export function flyApiPrivate(stat = statSync) {
    try {
        return (stat("/.fly").mode & 0o077) === 0;
    }
    catch {
        return true;
    }
}
export function defaultCodeRoots() {
    const roots = [dirname(SERVER_ROOT)];
    const node = dirname(dirname(process.execPath));
    if (!roots.some((root) => node.startsWith(root)))
        roots.push(node);
    return roots;
}
export class BotBox {
    detection = { box: "off", reason: "not-cloud", tools: null };
    runner = null;
    egress = null;
    harness = null;
    credentials = null;
    seccompFile = null;
    checks = null;
    boxed = 0;
    unbrokered = new Set();
    started = null;
    /** Detects, and when the box is on opens the gates. Safe to call once; returns what it decided. */
    async start(options) {
        this.started = options;
        const env = options.env ?? process.env;
        this.detection = (options.detect ?? ((e) => detectBox({ env: e })))(env);
        const log = options.log ?? ((line) => console.log(line));
        if (this.detection.box !== "bwrap" || !this.detection.tools) {
            log(`bot box: off (${this.detection.reason})`);
            return this.detection;
        }
        const dir = join(options.dataDir, "box");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const egressSocket = join(dir, "egress.sock"), harnessSocket = join(dir, "harness.sock"), brokerSocket = join(dir, "broker.sock");
        for (const socket of [egressSocket, harnessSocket, brokerSocket])
            rmSync(socket, { force: true });
        this.egress = await openBoxEgressGate({ socketPath: egressSocket });
        this.harness = await openHarnessGate({ socketPath: harnessSocket, port: options.port });
        this.credentials = await openCredentialBroker({ socketPath: brokerSocket });
        this.seccompFile = writeSeccompFile(dir);
        const bridges = [
            { name: "egress", port: BOX_EGRESS_PORT, socket: egressSocket },
            { name: "harness", port: options.port, socket: harnessSocket },
            { name: "broker", port: BOX_BROKER_PORT, socket: brokerSocket },
        ];
        this.runner = new BoxRunner({
            bwrap: this.detection.tools.bwrap,
            bridge: { socat: this.detection.tools.socat, bridgeScript: BOX_BRIDGE_SCRIPT, node: process.execPath },
            setup: { dataDir: options.dataDir, home: options.home, codeRoots: options.codeRoots ?? defaultCodeRoots(), engineRoots: options.engineRoots ?? engineInstallRoots(options.dataDir), bridges },
            denyEnv: options.denyEnv, seccompFile: this.seccompFile,
            broker: { port: BOX_BROKER_PORT, mintForProcess: this.credentials.mintForProcess, revoke: this.credentials.revoke },
        });
        distrustHomePrograms(options.home, [options.dataDir], ["workspaces", "task-workspaces", "engine-homes"].map((name) => join(options.dataDir, name)));
        resetPathCache();
        log(`bot box: on (bubblewrap, ${this.detection.tools.socat ? "socat" : "node"} bridges, credential broker, seccomp ${this.seccompFile ? "on" : "unsupported here"})`);
        return this.detection;
    }
    /** The broker for callers that mint conversation-bound grants, or null when the box (and so the broker) is off. */
    broker() {
        const credentials = this.credentials;
        return credentials ? { port: BOX_BROKER_PORT, mintForThread: credentials.mintForThread, touchThread: credentials.touchThread, revokeThread: credentials.revokeThread, lookup: credentials.lookup } : null;
    }
    /** The broker's socket, for a self-check that bridges it. */
    brokerSocket() { return this.credentials?.socketPath ?? null; }
    /** The filter file each box gets, for a self-check. */
    seccomp() { return this.seccompFile; }
    /** The box for one spawn, or null when turns are not boxed here. */
    wrap(request) {
        if (!this.runner)
            return null;
        const wrapped = this.runner.wrap(request);
        this.boxed += 1;
        for (const name of wrapped.unbrokered)
            this.unbrokered.add(name);
        return wrapped;
    }
    enabled() { return this.runner !== null; }
    /** A relay for one boxed spawn (BoxRequest.relay), or null when bot spawns are not boxed here. */
    async openRelay() {
        if (!this.runner)
            return null;
        return openBoxRelay(join(this.runner.setup.dataDir, "box", `relay-${randomBytes(6).toString("hex")}.sock`));
    }
    /** The box a bot's Chrome runs in: the system read-only, private /tmp and /run, the host's network (the browser's own
     * gate filters it), `ro` paths, and nothing of HOME or the data folder; the launcher binds the one profile it starts
     * Chrome on. bubblewrap's options before `--`; null when turns are not boxed here. */
    browserBox(seccompFd, ro) {
        if (!this.runner || !this.detection.tools)
            return null;
        const setup = { ...this.runner.setup, engineRoots: [] };
        const seccomp = this.seccompFile && !setup.mutate?.has("no-seccomp") ? this.seccompFile : null;
        const plan = planBox({ ...setup, seccompFd: seccomp ? seccompFd : undefined }, { command: "chrome", args: [], env: {}, net: "shared", ro });
        const home = resolve(setup.home), dataDir = resolve(setup.dataDir);
        const mounts = plan.mounts.filter((mount) => !(mount.kind === "bind" && mount.target === home) && !(mount.kind === "tmpfs" && mount.target === dataDir));
        return { bwrap: this.detection.tools.bwrap, options: bwrapArgs({ ...plan, mounts }), seccomp };
    }
    /** More read-write folders for one conversation's boxes (a memory layer); nothing without a runner. */
    lend(botId, threadId, rw) { this.runner?.lend(botId, threadId, rw); }
    tools() { return this.detection.tools; }
    noteChecks(checks) { this.checks = checks; }
    report() {
        return {
            box: this.detection.box,
            reason: this.detection.reason,
            checks: this.checks,
            bridge: this.detection.tools ? (this.detection.tools.socat ? "socat" : "node") : null,
            boxed: this.boxed,
            refused: { egress: this.egress?.refused ?? 0, harness: this.harness?.refused ?? 0 },
            broker: { on: this.credentials !== null, ...(this.credentials?.stats() ?? { tokens: 0, forwarded: 0, refused: 0 }), unbrokered: [...this.unbrokered].sort() },
            hardening: {
                seccomp: this.runner ? (this.seccompFile ? "on" : "unsupported") : "off", denied: this.seccompFile ? DENIED_SYSCALLS.length : 0,
                hidepid: process.platform === "linux" && procHidepid(), flyApiPrivate: process.platform === "linux" && existsSync("/.fly") ? flyApiPrivate() : true,
            },
        };
    }
    startOptions() { return this.started; }
    async stop() {
        await Promise.all([this.egress?.close(), this.harness?.close(), this.credentials?.close()]);
        this.egress = null;
        this.harness = null;
        this.credentials = null;
        this.seccompFile = null;
        this.runner = null;
        distrustHomePrograms(null);
        resetPathCache();
    }
}
export const botBox = new BotBox();
