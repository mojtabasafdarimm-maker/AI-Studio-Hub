import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { deviceSignInPrompt } from "../../shared/device-sign-in.js";
import { killCliTree, spawnCli } from "../procs.js";
const MAX_OUTPUT = 16_384;
// Only the auth operation on a shared credential home is exclusive, never normal turns.
const authenticatingHomes = new Set();
export function canonicalPath(path) {
    try {
        return realpathSync(path);
    }
    catch {
        const parent = dirname(path);
        return parent === path ? path : join(canonicalPath(parent), basename(path));
    }
}
/** The instance surface an ACP driver exposes for its device sign-in: start/get/cancel, plus `signOut` when the spec
 * can actually perform one (a CLI logout command or a credential removal). Lives beside the controller so the
 * instance wiring stays one line in each driver. */
export function deviceAuthInstanceSurface(deviceSignIn, spec) {
    return {
        startAuthentication: () => deviceSignIn.start(),
        getAuthentication: (flowId) => deviceSignIn.get(flowId),
        cancelAuthentication: () => deviceSignIn.cancel(),
        ...((spec.logoutArgs || spec.removeCredentials) ? { signOut: () => deviceSignIn.signOut() } : {}),
    };
}
/** A fixed login command, not a terminal: CLI output stays in bounded private memory; only the page and code leave. */
export class DeviceAuthController {
    flow = null;
    command = null;
    signingOut = null;
    disposed = false;
    spec;
    options;
    constructor(spec, options) {
        this.spec = spec;
        this.options = options;
    }
    home(env, action) {
        const { homeEnv, homeDir, product } = this.spec;
        const home = env.HOME || env.USERPROFILE || homedir();
        const named = env[homeEnv];
        if (!isAbsolute(home) || (named && !isAbsolute(named))) {
            throw new Error(`Use an absolute HOME and ${homeEnv} path for this server's ${product} provider before ${action}.`);
        }
        return { home, homeKey: canonicalPath(resolve(named || join(home, homeDir))) };
    }
    async start() {
        const { product, account, status } = this.spec;
        if (this.disposed)
            throw new Error("This provider was removed. Refresh Settings before signing in.");
        if (this.flow?.status.phase === "waiting") {
            if (this.flow.ready)
                return { ...this.flow.status, phase: "waiting" };
            throw new Error(`A ${account} sign-in is already starting. Please wait for the code.`);
        }
        await this.flow?.stopping;
        if (this.disposed)
            throw new Error("This provider was removed. Refresh Settings before signing in.");
        const env = this.options.environment();
        const { home, homeKey } = this.home(env, "signing in");
        if (authenticatingHomes.has(homeKey)) {
            throw new Error(`A ${account} sign-in is already running for this server account. Finish or cancel it before starting another.`);
        }
        authenticatingHomes.add(homeKey);
        return new Promise((resolveStart, reject) => {
            const flow = {
                status: {
                    phase: "waiting", flowId: randomUUID(), authorizationUrl: null,
                    expiresAt: new Date(Date.now() + (this.options.lifetimeMs ?? 15 * 60_000)).toISOString(),
                },
                child: null, ready: false, resolve: resolveStart, reject, homeKey,
                startupTimer: setTimeout(() => this.finish(flow, "failed", `${product} did not provide a sign-in code in time. Check the server connection and update ${product}, then try again.`), this.options.startupTimeoutMs ?? 30_000),
                expiryTimer: setTimeout(() => this.finish(flow, "expired", `The ${account} sign-in code expired. Start sign-in again.`), this.options.lifetimeMs ?? 15 * 60_000),
            };
            flow.startupTimer.unref();
            flow.expiryTimer.unref();
            this.flow = flow;
            const login = () => this.run(flow, [...this.spec.loginArgs], env, home, (loginCode, loginOutput) => {
                if (loginCode !== 0 || !flow.ready) {
                    this.finish(flow, "failed", this.spec.failure(loginOutput));
                    return;
                }
                flow.startupTimer = setTimeout(() => this.finish(flow, "failed", `${product} finished sign-in but could not confirm the account. Refresh Settings and try again.`), this.options.startupTimeoutMs ?? 30_000);
                flow.startupTimer.unref();
                this.confirm(flow, env, home, (signedIn) => this.finish(flow, signedIn ? "succeeded" : "failed", `${product} finished sign-in but did not confirm a ${account} account. Refresh Settings and try again.`));
            }, true);
            // Never overwrite a working login; one the provider refused is not working, whatever status says.
            if (!status) {
                login();
                return;
            }
            this.run(flow, [...status.args], env, home, (code, output) => {
                const state = status.read(code, output);
                if (state === "signed-in" && !this.options.signInRejected?.())
                    this.finish(flow, "succeeded");
                else if (state === "signed-in" || state === "signed-out")
                    login();
                else if (state === "other")
                    this.finish(flow, "failed", `${product} already has a different sign-in method on this server. Ask the server administrator to review it before changing accounts.`);
                else
                    this.finish(flow, "failed", `${product} could not confirm the existing sign-in on this server. Update ${product} and check its login status before trying again.`);
            });
        });
    }
    async get(flowId) {
        if (!flowId || this.flow?.status.flowId !== flowId)
            throw new Error("This sign-in is no longer available. Start sign-in again.");
        return { ...this.flow.status };
    }
    async cancel() {
        if (this.flow?.status.phase === "waiting")
            this.finish(this.flow, "cancelled", `${this.spec.account} sign-in cancelled.`);
        await this.flow?.stopping;
        if (this.flow?.terminationFailed)
            throw new Error(this.flow.status.message);
        if (this.command && !await this.stopChild(this.command)) {
            throw new Error(`${this.spec.product} could not be stopped on this server. Ask the server administrator to stop the account command before trying again.`);
        }
    }
    async dispose() {
        this.disposed = true;
        await this.cancel();
        // A stopped sign-out frees the account's lock once its pipes close, which can come after the exit cancel() waits for.
        const signingOut = this.signingOut;
        if (signingOut)
            await Promise.race([signingOut.catch(() => { }), new Promise((resolve) => setTimeout(resolve, 1_500).unref())]);
        this.flow = null;
    }
    /** A sign-in in progress is never pulled away underneath the browser completing it. */
    async signOut() {
        const run = this.signOutNow();
        this.signingOut = run;
        try {
            await run;
        }
        finally {
            if (this.signingOut === run)
                this.signingOut = null;
        }
    }
    async signOutNow() {
        const { product, account, status, signedIn, signInState, logoutArgs, removeCredentials } = this.spec;
        if (!logoutArgs && !removeCredentials)
            throw new Error(`Signing out of ${account} is not available from here.`);
        if (!status && !signedIn && !signInState)
            throw new Error(`Signing out of ${account} is not available from here.`);
        if (this.disposed)
            throw new Error("This provider was removed. Refresh Settings before signing out.");
        if (this.flow?.status.phase === "waiting")
            throw new Error(`Finish or cancel the ${account} sign-in in progress before signing out.`);
        await this.flow?.stopping;
        if (this.disposed)
            throw new Error("This provider was removed. Refresh Settings before signing out.");
        const env = this.options.environment();
        const { home, homeKey } = this.home(env, "signing out");
        if (authenticatingHomes.has(homeKey)) {
            throw new Error(`A ${account} sign-in is running for this server account. Finish or cancel it before signing out.`);
        }
        authenticatingHomes.add(homeKey);
        try {
            const held = async () => {
                if (signInState)
                    return signInState(env);
                if (!status)
                    return signedIn(env) ? "signed-in" : "signed-out";
                const probe = await this.exec([...status.args], env, home);
                return status.read(probe.code, probe.output);
            };
            const state = await held();
            if (state === "signed-out")
                return;
            if (state !== "signed-in") {
                throw new Error(`${product} did not confirm a ${account} sign-in. Other authentication methods will not be removed; ask the server administrator to check the account.`);
            }
            if (logoutArgs) {
                const logout = await this.exec([...logoutArgs], env, home);
                if (logout.code !== 0)
                    throw new Error(`${product} could not remove the sign-in on this server. Check the server's ${product} installation and try again.`);
            }
            else {
                try {
                    await removeCredentials(env);
                }
                catch {
                    throw new Error(`${product} could not remove the sign-in on this server. Check the server's ${product} installation and try again.`);
                }
            }
            if (await held() !== "signed-out") {
                throw new Error(`${product} still reports a sign-in on this server. Update ${product} and check its login status before trying again.`);
            }
        }
        finally {
            // A command the OS could not stop may still change credentials: keep the home reserved until it exits.
            const child = this.command;
            if (child && child.exitCode === null && child.signalCode === null) {
                child.once("close", () => authenticatingHomes.delete(homeKey));
            }
            else
                authenticatingHomes.delete(homeKey);
        }
    }
    confirm(flow, env, home, done) {
        const status = this.spec.status;
        if (status) {
            this.run(flow, [...status.args], env, home, (code, output) => done(status.read(code, output) === "signed-in"));
            return;
        }
        let signedIn = false;
        try {
            signedIn = this.spec.signedIn?.(env) === true;
        }
        catch { }
        done(signedIn);
    }
    startFailure(error) {
        const { product, install } = this.spec;
        return error.code === "ENOENT"
            ? `${product} is not installed on this server. ${install}`
            : `${product} could not start on this server. Check the configured CLI path and its executable permissions.`;
    }
    /** Callers see an exit code and a status-line match, never the output. */
    exec(args, env, cwd) {
        const { product } = this.spec;
        return new Promise((resolveExec, rejectExec) => {
            if (this.disposed) {
                rejectExec(new Error("This provider was removed. Refresh Settings before signing out."));
                return;
            }
            let child;
            try {
                child = spawnCli(this.options.cli, args, { env: { ...env, NO_COLOR: "1", ...this.spec.env }, cwd, stdio: ["pipe", "pipe", "pipe"] });
            }
            catch {
                rejectExec(new Error(`${product} could not start on this server. Install or update the configured ${product} CLI, then try again.`));
                return;
            }
            this.command = child;
            child.stdin.end();
            let output = "";
            const receive = (chunk) => {
                if (output.length < MAX_OUTPUT)
                    output += chunk.toString("utf8").slice(0, MAX_OUTPUT - output.length);
            };
            child.stdout.on("data", receive);
            child.stderr.on("data", receive);
            // A hung CLI must not hold the credential-home lock forever.
            const timer = setTimeout(() => {
                void this.stopChild(child).catch(() => false).then((stopped) => {
                    if (!stopped)
                        rejectExec(new Error(`${product} could not be stopped on this server. Ask the server administrator to stop the account command before trying again.`));
                });
            }, this.options.startupTimeoutMs ?? 30_000);
            timer.unref();
            child.once("error", (error) => {
                clearTimeout(timer);
                rejectExec(new Error(this.startFailure(error)));
            });
            child.once("close", (code) => {
                clearTimeout(timer);
                if (this.command === child)
                    this.command = null;
                resolveExec({ code, output: stripVTControlCharacters(output) });
            });
        });
    }
    run(flow, args, env, cwd, done, parsePrompt = false) {
        const { product, provider } = this.spec;
        if (flow.status.phase !== "waiting")
            return;
        let child;
        try {
            child = spawnCli(this.options.cli, args, { env: { ...env, NO_COLOR: "1", ...this.spec.env }, cwd, stdio: ["pipe", "pipe", "pipe"] });
        }
        catch {
            this.finish(flow, "failed", `${product} could not start on this server. Install or update the configured ${product} CLI, then try again.`);
            return;
        }
        flow.child = child;
        child.stdin.end();
        let output = "";
        const receive = (chunk) => {
            if (flow.status.phase !== "waiting")
                return;
            if (output.length + chunk.length > MAX_OUTPUT) {
                this.finish(flow, "failed", `${product} returned an unexpected sign-in response. Update the server's ${product} CLI and try again.`);
                return;
            }
            output += chunk.toString("utf8");
            const prompt = parsePrompt ? deviceSignInPrompt(provider, stripVTControlCharacters(output)) : null;
            if (!prompt || (prompt.userCode === flow.status.userCode && prompt.authorizationUrl === flow.status.authorizationUrl))
                return;
            flow.status = { ...flow.status, ...prompt };
            if (!flow.ready) {
                flow.ready = true;
                clearTimeout(flow.startupTimer);
                flow.resolve({ ...flow.status, phase: "waiting" });
            }
        };
        child.stdout.on("data", receive);
        child.stderr.on("data", receive);
        child.once("error", (error) => this.finish(flow, "failed", this.startFailure(error)));
        child.once("close", (code) => {
            if (flow.child === child)
                flow.child = null;
            if (flow.status.phase === "waiting")
                done(code, stripVTControlCharacters(output));
            output = "";
        });
    }
    finish(flow, phase, message) {
        const { product, account } = this.spec;
        if (flow.status.phase !== "waiting")
            return;
        clearTimeout(flow.startupTimer);
        clearTimeout(flow.expiryTimer);
        flow.status = {
            phase, flowId: flow.status.flowId, authorizationUrl: null, expiresAt: null,
            ...(phase !== "succeeded" && message ? { message } : {}),
        };
        if (!flow.ready) {
            if (phase === "succeeded")
                flow.resolve({ ...flow.status, phase });
            else
                flow.reject(new Error(message ?? `${account} sign-in did not finish.`));
        }
        flow.stopping = this.stopChild(flow.child).catch(() => false).then((stopped) => {
            const release = () => authenticatingHomes.delete(flow.homeKey);
            if (stopped) {
                release();
                return;
            }
            flow.terminationFailed = true;
            flow.status = { ...flow.status, phase: "failed", message: `${product} could not be stopped on this server. Ask the server administrator to stop the login process before trying again.` };
            // Retain the credential-home lock until the OS actually reports exit.
            const child = flow.child;
            if (!child || child.exitCode !== null || child.signalCode !== null)
                release();
            else
                child.once("close", release);
        });
        if (phase === "succeeded")
            void this.options.onAuthenticated?.().catch(() => { });
    }
    async stopChild(child) {
        if (!child || await killCliTree(child, this.options.terminateTimeoutMs ?? 1500))
            return true;
        // A broken CLI may ignore SIGTERM; a cancelled device flow must not go on to write credentials.
        if (process.platform !== "win32" && child.pid) {
            try {
                process.kill(-child.pid, "SIGKILL");
            }
            catch {
                child.kill("SIGKILL");
            }
        }
        else
            child.kill("SIGKILL");
        await new Promise((resolveStop) => {
            if (child.exitCode !== null || child.signalCode !== null)
                return resolveStop();
            const timer = setTimeout(resolveStop, 1500);
            timer.unref();
            child.once("close", () => { clearTimeout(timer); resolveStop(); });
        });
        return child.exitCode !== null || child.signalCode !== null;
    }
}
