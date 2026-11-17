import { randomUUID } from "node:crypto";
import { killCliTree, spawnCli } from "../../procs.js";
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** initialize is the only quick request; the long one is `authenticate`, under the flow's own expiry. */
const INIT_TIMEOUT_MS = 30_000;
/** The instance surface an ACP driver exposes for its browser sign-in: start/get/cancel, plus `signOut` when the spec
 * can remove the stored sign-in. Marked `browser` so the registry separates it from a device-code flow. Lives beside
 * the controller so the instance wiring stays one line in each driver, like deviceAuthInstanceSurface (see
 * device-auth.ts). */
export function acpBrowserAuthInstanceSurface(auth, spec) {
    return {
        authenticationMethod: "browser",
        startAuthentication: () => auth.start(),
        getAuthentication: (flowId) => auth.get(flowId),
        cancelAuthentication: () => auth.cancel(),
        ...(spec.removeCredentials ? { signOut: () => auth.signOut() } : {}),
    };
}
export class AcpBrowserAuth {
    flow = null;
    /** A finished flow's status stays findable by its flowId until the next start replaces it, so a status poll never
     * races a finishing sign-in. */
    finished = null;
    disposed = false;
    spec;
    options;
    /** The finishing flow's termination, kept controller-level so a start, sign-out or dispose that arrives
     * once `finish` cleared `flow` still waits for the old child to be down before touching credentials. */
    stopping = null;
    constructor(spec, options) {
        this.spec = spec;
        this.options = options;
    }
    async start() {
        if (this.disposed)
            throw new Error("This provider was removed. Refresh Settings before signing in.");
        if (this.flow)
            await this.flow.stopping;
        if (this.stopping)
            await this.takeStopping();
        if (this.flow)
            throw new Error(`A ${this.spec.product} sign-in is already in progress. Finish or cancel it first.`);
        if (this.disposed)
            throw new Error("This provider was removed. Refresh Settings before signing in.");
        return new Promise((resolveStart, rejectStart) => {
            const env = this.options.environment();
            const lifetimeMs = this.options.lifetimeMs ?? 15 * 60_000;
            const flow = {
                id: randomUUID(),
                status: {
                    phase: "waiting", flowId: null, authorizationUrl: null,
                    expiresAt: new Date(Date.now() + lifetimeMs).toISOString(),
                },
                child: null, ready: false, resolve: null,
                startupTimer: setTimeout(() => this.finish(flow, "failed", this.spec.failure("start")), this.options.startupTimeoutMs ?? 30_000),
                expiryTimer: setTimeout(() => this.finish(flow, "expired", this.spec.failure("expired")), lifetimeMs),
            };
            flow.startupTimer.unref();
            flow.expiryTimer.unref();
            this.flow = flow;
            this.finished = null;
            const failFlow = (stage, detail) => this.finish(flow, "failed", this.spec.failure(stage, detail));
            const spawnFail = (detail) => {
                const message = this.spec.failure("start", detail);
                const reported = detail === "ENOENT" && this.spec.serverHint ? `${message} ${this.spec.serverHint}` : message;
                this.finish(flow, "failed", reported);
                rejectStart(new Error(message));
            };
            let child;
            try {
                const extra = (this.spec.args ?? []).map((arg) => typeof arg === "function" ? arg(env) : arg).filter((arg) => arg !== undefined);
                const sessionArgs = this.options.sessionArgs ? this.options.sessionArgs(env) : [];
                const argv = [this.options.cli, ...extra, ...sessionArgs];
                child = spawnCli(argv[0], argv.slice(1), { cwd: this.options.cwd, env, stdio: ["pipe", "pipe", "pipe"] }, "bot");
            }
            catch (error) {
                spawnFail(error instanceof Error && typeof error.code === "string"
                    ? String(error.code) : undefined);
                return;
            }
            flow.child = child;
            child.once("error", (error) => {
                if (flow.ready || this.flow !== flow)
                    return;
                const code = error instanceof Error ? error.code : undefined;
                if (code === "ENOENT")
                    spawnFail("ENOENT");
                else
                    failFlow("processEnded", typeof code === "string" ? code : undefined);
            });
            child.once("close", (code) => {
                if (flow.ready || this.flow !== flow)
                    return;
                failFlow("processEnded", code !== null ? `exit ${code}` : undefined);
            });
            const pending = new Map();
            let requestSeq = 1;
            let buffer = "";
            child.stdout.on("data", (chunk) => {
                buffer += chunk.toString("utf8");
                if (buffer.length > MAX_OUTPUT_BYTES) {
                    failFlow("processEnded", "overflow");
                    return;
                }
                let newline;
                while ((newline = buffer.indexOf("\n")) >= 0) {
                    const line = buffer.slice(0, newline);
                    buffer = buffer.slice(newline + 1);
                    if (line.length > MAX_LINE_BYTES) {
                        failFlow("processEnded", "overflow");
                        return;
                    }
                    this.receive(flow, pending, line);
                }
            });
            child.stderr.on("data", () => { });
            const request = (method, params, timeoutMs) => new Promise((resolve, rejectRequest) => {
                const id = requestSeq++;
                const timer = setTimeout(() => {
                    pending.delete(id);
                    rejectRequest(new Error(`${method} was not answered in time`));
                }, timeoutMs);
                timer.unref?.();
                pending.set(id, {
                    resolve: (value) => { clearTimeout(timer); resolve(value); },
                    reject: (error) => { clearTimeout(timer); rejectRequest(error); },
                });
                if (child.stdin.writable)
                    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
                else
                    rejectRequest(new Error("the sign-in process ended early"));
            });
            // The engine holds `authenticate` open until the browser step ends, and its answer IS that step's end; every
            // request the engine itself raises is refused: this session grants nothing and decides nothing.
            request("initialize", {
                protocolVersion: 1,
                clientInfo: { name: "openmausbot", version: "0.0.0" },
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            }, INIT_TIMEOUT_MS).then((raw) => {
                if (this.flow !== flow)
                    return;
                // The handshake is the startup window's whole job; the authenticate wait is the person's, and it
                // owns no timer but the expiry one (the person may take the full window to finish in the browser).
                clearTimeout(flow.startupTimer);
                const methods = Array.isArray(raw?.authMethods)
                    ? raw.authMethods : [];
                const methodId = this.spec.methodId(methods, env);
                if (!methodId) {
                    failFlow("start");
                    return;
                }
                request("authenticate", { methodId }, lifetimeMs).then(() => this.finish(flow, "succeeded"), () => failFlow("authenticate"));
            }, () => failFlow("initialize"));
            // The browser opens behind this; the person's progress shows up on the status endpoint.
            resolveStart({ phase: "waiting", flowId: flow.id, authorizationUrl: null, expiresAt: flow.status.expiresAt });
        });
    }
    async get(flowId) {
        if (this.finished?.flowId === flowId)
            return { ...this.finished.status };
        if (!flowId || this.flow?.id !== flowId)
            throw new Error("This sign-in is no longer available. Start sign-in again.");
        const flow = this.flow;
        if (!flow.ready && this.spec.signedIn && this.spec.signedIn(this.options.environment()))
            this.finish(flow, "succeeded");
        return { ...(this.flow === flow ? flow.status : this.finished?.status ?? flow.status) };
    }
    async cancel() {
        const flow = this.flow;
        if (flow)
            this.finish(flow, "cancelled", `${this.spec.product} sign-in was cancelled.`);
        await flow?.stopping;
        if (this.stopping)
            await this.takeStopping();
    }
    async dispose() {
        this.disposed = true;
        await this.cancel();
        if (this.stopping)
            await this.takeStopping();
        this.flow = null;
    }
    /** Removes the engine's own stored sign-in; refuses while a sign-in is in progress. */
    async signOut() {
        if (!this.spec.removeCredentials)
            throw new Error(`Signing out of ${this.spec.product} is not available from here.`);
        if (this.flow)
            throw new Error(`Finish or cancel the ${this.spec.product} sign-in in progress before signing out.`);
        if (this.stopping)
            await this.takeStopping();
        const env = this.options.environment();
        if (this.spec.signedInByApiKey?.(env)) {
            throw new Error(`${this.spec.product} is signed in by an API key here, which signing out cannot remove. Remove the key under Settings → AI to disconnect it.`);
        }
        await this.spec.removeCredentials(env);
        // Checked again, as device-auth.ts does: a success the engine contradicts is not reported as one.
        if (this.spec.signedIn?.(env)) {
            throw new Error(`${this.spec.product} still reports a sign-in on this server. Update ${this.spec.product} and check its login status before trying again.`);
        }
    }
    /** One waiter takes the outstanding termination; later callers see null. */
    async takeStopping() {
        const stopping = this.stopping;
        this.stopping = null;
        await stopping;
    }
    /** Every request the engine raises is refused; a reply to this app's requests resolves or rejects its pending. */
    receive(flow, pending, line) {
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            return;
        }
        const message = (parsed ?? {});
        if (typeof message.method === "string" && message.id !== undefined && typeof message.id === "number") {
            const stdin = flow.child?.stdin;
            if (stdin?.writable) {
                stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Not available during sign-in." } })}\n`);
            }
            return;
        }
        if (typeof message.id !== "number")
            return;
        const entry = pending.get(message.id);
        if (!entry)
            return;
        pending.delete(message.id);
        if (message.error !== undefined && message.error !== null && typeof message.error === "object"
            && typeof message.error.message === "string") {
            // The CLI's own words never travel — the stage decides the message the person reads.
            entry.reject(new Error("a sign-in request was refused"));
        }
        else
            entry.resolve(message.result);
    }
    finish(flow, phase, message) {
        if (this.flow !== flow)
            return;
        this.flow = null;
        clearTimeout(flow.startupTimer);
        clearTimeout(flow.expiryTimer);
        flow.ready = true;
        const status = {
            ...flow.status, phase,
            authorizationUrl: null, expiresAt: null,
            ...(message ? { message } : {}),
        };
        this.finished = { flowId: flow.id, status };
        if (phase === "succeeded")
            void this.options.onAuthenticated?.().catch(() => { });
        // A start promise still open (a spawn failure before the early resolve) only ever rejects; finish's resolve was
        // consumed by start() right after the spawn, so this is for that window alone.
        flow.resolve?.({ phase: phase === "succeeded" ? "succeeded" : "waiting", flowId: flow.id, authorizationUrl: null, expiresAt: null });
        flow.resolve = null;
        const child = flow.child;
        flow.child = null;
        if (child) {
            flow.stopping = this.stopChild(child);
            this.stopping = flow.stopping;
            void flow.stopping.then(() => { if (this.stopping === flow.stopping)
                this.stopping = null; });
        }
    }
    async stopChild(child) {
        const stopped = await killCliTree(child, this.options.terminateTimeoutMs ?? 2_000).catch(() => false);
        if (stopped || child.exitCode !== null || child.signalCode !== null)
            return true;
        child.kill("SIGKILL");
        return false;
    }
}
