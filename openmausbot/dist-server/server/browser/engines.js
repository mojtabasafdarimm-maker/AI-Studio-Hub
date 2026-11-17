// The bots' browser runs on agent-browser or, with browserEngine.engine set to "chrome", on OpenMausBot's own Chrome
// driver. A session's spec says which: the new engine's names the profile it drives. Everything that reaches a browser
// goes through the two routers here, which keep the agent-browser engine's API.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LocalBackend } from "./backends.js";
import { sandboxDisabled } from "./chrome/host-setup.js";
import { ChromeLauncher } from "./chrome/launcher.js";
import { ProcessRegistry, sweep } from "./chrome/processes.js";
import { browserRoot } from "./chrome/profile.js";
import { browserLanguage, browserTimeZone, languageList } from "./chrome/wrapper.js";
import { displayScreen } from "./display.js";
import { BrowserService } from "./service.js";
import { LiveV1 } from "./viewers/live-v1.js";
import { StreamV2 } from "./viewers/stream-v2.js";
/** A spec's command when the new engine runs the session; its one argument is the profile key. */
export const CHROME_ENGINE = "omb-cdp";
export function chromeTarget(session, spec) {
    const key = spec?.command === CHROME_ENGINE ? spec.args?.[0] : undefined;
    return key ? { session, key } : null;
}
/** The profile a bot's browser is on the new engine: its own, a shared one, or a temporary one. */
export function profileKey(botId, session, profile) {
    if (profile.guest)
        return `temp:${session}`;
    return profile.partitionId ? `shared:${profile.partitionId}` : `bot:${botId}`;
}
const MAX_RUNNING = { desktop: 6, server: 4, container: 2 };
const SWEEP_MS = 60_000;
/** The new engine: one Chrome launcher (no agent-browser wrapper), the browser service, its live views and its sweep. */
export class ChromeEngine {
    launcher;
    service;
    live;
    stream;
    #targets = new Map();
    #registry;
    #options;
    #timer = null;
    #inUse = false;
    #cleared = false;
    constructor(options) {
        this.#options = options;
        const env = options.env ?? process.env;
        const platform = options.platform ?? process.platform;
        const sandbox = !sandboxDisabled(env);
        this.launcher = new ChromeLauncher({ dataDir: options.dataDir, env, platform, language: options.language, engine: () => ({ managed: true }), wrapper: false, sandbox, ...(options.log ? { log: options.log } : {}) });
        this.#registry = new ProcessRegistry(browserRoot(options.dataDir));
        let screen = null;
        const locale = () => browserLanguage(env, options.language?.()) ?? null;
        const backend = new LocalBackend({
            dataDir: options.dataDir,
            host: options.host,
            platform,
            binary: async () => {
                const binary = await this.launcher.binary();
                return { path: binary.path, identity: { ...binary.identity, product: binary.product } };
            },
            screen: () => (screen ??= displayScreen(options.host, { platform, env })),
            locale,
            acceptLanguages: () => languageList(locale() ?? undefined),
            timezone: () => browserTimeZone(env, platform) ?? null,
            egressPort: (key) => options.egressPort(key),
            registry: this.#registry,
            sandbox,
            ...(options.log ? { log: options.log } : {}),
        });
        const maxRunning = Number(env.OMB_BROWSER_MAX_RUNNING) || MAX_RUNNING[options.host];
        this.service = new BrowserService({
            dataDir: options.dataDir,
            backend: () => backend,
            maxRunning,
            idleMs: options.idleMs,
            held: options.held,
            egressNotice: options.egressNotice,
            ...(options.log ? { log: options.log } : {}),
        });
        this.live = new LiveV1({ service: this.service, target: (session) => this.target(session) });
        this.stream = new StreamV2({ service: this.service });
    }
    /** The spec a session gets on the new engine, remembered so its live view finds the profile. */
    spec(session, key) {
        this.#targets.set(session, key);
        return { command: CHROME_ENGINE, args: [key], env: {} };
    }
    target(session) {
        const key = this.#targets.get(session);
        return key ? { session, key } : null;
    }
    /**
     * In use, it prepares Chrome before a bot needs it. In use, or while a Chrome it started still runs, it closes idle
     * browsers and stray processes every minute. Otherwise it only clears, once, what an earlier run of the engine left
     * behind, so a server that never turned it on lists no processes.
     */
    start({ inUse, prepare }) {
        const starting = inUse && !this.#inUse;
        this.#inUse = inUse;
        if (!inUse && !this.#cleared && this.#everUsed())
            this.#tick();
        this.#cleared = true;
        if (inUse && prepare && this.launcher.plan().kind !== "legacy")
            void this.launcher.prepare();
        if (starting)
            this.#tick();
        this.#timer ??= setInterval(() => { if (this.#inUse || this.#running())
            this.#tick(); }, SWEEP_MS);
        this.#timer.unref?.();
    }
    #tick() {
        void this.service.closeIdle().catch(() => undefined);
        void sweep({ root: browserRoot(this.#options.dataDir), registry: this.#registry }).catch(() => undefined);
    }
    #running() {
        return this.service.profiles().some((profile) => profile.run || profile.starting) || this.#registry.list().length > 0;
    }
    /** Whether this engine ever made a profile in this data folder. */
    #everUsed() {
        const root = browserRoot(this.#options.dataDir);
        return existsSync(join(root, "profiles")) || existsSync(join(root, "temp"));
    }
    async close() {
        if (this.#timer)
            clearInterval(this.#timer);
        this.#timer = null;
        this.live.closeAll();
        this.stream.closeAll();
        await this.service.closeAll();
    }
    /** A deleted bot's or profile's browser: stopped, and its folder, downloads and screenshots gone. */
    async erase(request) {
        const key = request.kind === "bot" ? `bot:${request.id}` : `shared:${request.partitionId}`;
        if (!this.#everUsed())
            return true;
        try {
            await this.service.erase(key);
            return true;
        }
        catch (error) {
            this.#options.log?.(`browser cleanup: could not erase ${key}: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }
    /** For the browser status: what the new engine will run here. */
    summary() {
        const plan = this.launcher.plan();
        if (plan.kind === "legacy")
            return { kind: "unavailable", reason: `Chrome is needed for the new browser: ${plan.reason}` };
        return { kind: "engine", version: "omb-cdp", chrome: this.launcher.describe() };
    }
    /** fill_login's reads and typing on the new engine. */
    loginDeps(session) {
        const target = this.target(session);
        return target ? this.service.loginDeps(target) : null;
    }
}
/** afterClaim's refusal, thrown out of the engine's dispatch and answered as the call's result. */
class ClaimRefused extends Error {
}
/** BrowserRuntime's API, each call going to the engine its session runs on. */
export class RuntimeRouter {
    #old;
    #chrome;
    #refusal;
    #room;
    #afterClaim;
    #annotate;
    #afterCall;
    constructor(old, chrome, options = {}) {
        this.#old = old;
        this.#chrome = chrome;
        this.#refusal = options.refusal;
        this.#room = options.room;
        this.#afterClaim = options.afterClaim;
        this.#annotate = options.annotate;
        this.#afterCall = options.afterCall;
    }
    async agentRpc(session, spec, method, params, beforeDispatch, ctx) {
        const refusal = method === "tools/call" ? this.#refusal?.(session, spec, params) : null;
        if (refusal)
            return { isError: true, content: [{ type: "text", text: refusal }] };
        const target = chromeTarget(session, spec);
        const full = method === "tools/call" && target ? await this.#room?.(session, spec, params) : null;
        if (full)
            return { isError: true, content: [{ type: "text", text: full }] };
        const afterClaim = method === "tools/call" ? this.#afterClaim : undefined;
        const dispatch = afterClaim ? () => {
            beforeDispatch?.();
            const text = afterClaim(session, spec);
            if (text)
                throw new ClaimRefused(text);
        } : beforeDispatch;
        let result;
        try {
            result = await (target ? this.#chrome.service.agentRpc(target, method, params, dispatch) : this.#old.agentRpc(session, spec, method, params, dispatch, ctx));
        }
        catch (error) {
            if (error instanceof ClaimRefused)
                return { isError: true, content: [{ type: "text", text: error.message }] };
            throw error;
        }
        if (method !== "tools/call")
            return result;
        const annotated = this.#annotate ? this.#annotate(spec, result) : result;
        return this.#afterCall ? this.#afterCall(session, spec, annotated) : annotated;
    }
    previewFrame(session, capture, spec) {
        return chromeTarget(session, spec) ? this.#chrome.service.previewFrame(session) : this.#old.previewFrame(session, capture);
    }
    withSecretInput(session, spec, fn, ctx) {
        const target = chromeTarget(session, spec);
        return target ? this.#chrome.service.withSecretInput(target, fn) : this.#old.withSecretInput(session, spec, fn, ctx);
    }
    heldBy(session) {
        return this.#chrome.service.heldBy(session) ?? this.#old.heldBy(session);
    }
    working(session) {
        return this.#chrome.service.working(session) || this.#old.working(session);
    }
    interrupted(session) {
        return this.#chrome.service.interrupted(session) || this.#old.interrupted(session);
    }
    interruptedCount() {
        return this.#chrome.service.interruptedCount() + this.#old.interruptedCount();
    }
    /** The new engine closes its own idle browsers. */
    closeIfIdle(session, idleMs, spec) {
        if (chromeTarget(session, spec))
            return Promise.resolve(false);
        return this.#old.closeIfIdle(session, idleMs, spec ? { command: spec.command, args: spec.args ?? [], env: spec.env } : undefined);
    }
    /** Closes a session's browser now unless a call, an agent or a person is using it. */
    closeUnused(session, spec) {
        if (chromeTarget(session, spec))
            return this.#chrome.service.closeUnused(session);
        return this.#old.closeIfIdle(session, 1, { command: spec.command, args: spec.args ?? [], env: spec.env });
    }
    async close(session) {
        await Promise.all([this.#chrome.service.close(session), this.#old.close(session)]);
    }
    async closeAll() {
        await Promise.all([this.#chrome.close(), this.#old.closeAll()]);
    }
}
/**
 * BrowserLive's API: a viewer of a new-engine session gets the v1 adapter, every other the agent-browser one. The v2
 * stream, its file pickers and its downloads exist on the new engine only.
 */
export class LiveRouter {
    #old;
    #chrome;
    constructor(old, chrome) {
        this.#old = old;
        this.#chrome = chrome;
    }
    open(options) {
        if (chromeTarget(options.session, options.spec)) {
            const { spec: _spec, ...rest } = options;
            return this.#chrome.live.open(rest);
        }
        return this.#old.open(options);
    }
    action(options) {
        return this.#chrome.live.has(options.viewerId) ? this.#chrome.live.action(options) : this.#old.action(options);
    }
    /** False when the session runs on agent-browser, whose only view is v1. */
    stream({ session, spec, ...request }) {
        const target = chromeTarget(session, spec);
        if (!target)
            return false;
        this.#chrome.stream.open({ ...request, target });
        return true;
    }
    fileChooserOffered({ session, spec }, owner, chooserId) {
        return chromeTarget(session, spec) ? this.#chrome.service.fileChooserOffered(session, owner, chooserId) : false;
    }
    answerFileChooser({ session, spec }, owner, chooserId, paths) {
        return chromeTarget(session, spec) ? this.#chrome.service.answerFileChooser(session, owner, chooserId, paths) : Promise.resolve(false);
    }
    download({ session, spec }, id) {
        return chromeTarget(session, spec) ? this.#chrome.service.download(session, id) : undefined;
    }
    handBack(session) { this.#chrome.live.handBack(session); this.#old.handBack(session); }
    closeForSession(session) { this.#chrome.live.closeForSession(session); this.#chrome.stream.closeForSession(session); this.#old.closeForSession(session); }
    closeForOwner(owner) { this.#chrome.live.closeForOwner(owner); this.#chrome.stream.closeForOwner(owner); this.#old.closeForOwner(owner); }
    closeForBot(botId) { this.#chrome.live.closeForBot(botId); this.#chrome.stream.closeForBot(botId); this.#old.closeForBot(botId); }
    closeAll() { this.#chrome.live.closeAll(); this.#chrome.stream.closeAll(); this.#old.closeAll(); }
    /** Who may see what changed: every v2 view that no longer shows its browser to a person allowed to see it closes now. */
    recheck() { this.#chrome.stream.recheck(); }
}
