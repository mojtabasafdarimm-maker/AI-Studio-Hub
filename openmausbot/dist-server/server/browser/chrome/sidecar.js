// A second CDP connection to the browser agent-browser started: every page, cross-site frame and worker gets the browser's
// own identity before it runs (auto-attach paused on start), so no page or worker ever reads "HeadlessChrome". It sends
// nothing but the override and the release; never Runtime.enable, the call sites detect (deviceandbrowserinfo, Chrome 153).
import { execFile } from "node:child_process";
import { inRunningBrowser } from "../../browser-engine.js";
import { browserRuntimeEnv } from "../../browser-runtime.js";
import { spawnBotWork } from "../../oom-score.js";
import { connectCdp } from "../../browser-sites.js";
import { NO_PASSKEY_COMMANDS } from "../cdp/passkeys.js";
/** The pages and workers the browser session attaches to itself; frames and dedicated workers come through their page. */
const BROWSER_TARGETS = [{ type: "page" }, { type: "service_worker" }, { type: "shared_worker" }, { exclude: true }];
const PAUSED_ON_START = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
/** How long a browser's start waits for its open tabs to take the identity: a tab that never answers must not keep the browser
 * from starting. */
export const IDENTITY_LANDS_MS = 3_000;
export async function startIdentitySidecar(url, identity, connect = connectCdp, options = {}) {
    let onClosed;
    const closed = new Promise((resolve) => { onClosed = resolve; });
    let cdp = null;
    const applying = new Set();
    const configure = (message) => {
        if (message.method !== "Target.attachedToTarget" || !cdp)
            return;
        const { sessionId, targetInfo } = (message.params ?? {});
        if (typeof sessionId !== "string")
            return;
        const applied = applyIdentity(cdp, sessionId, targetInfo?.type ?? "", identity, options).finally(() => { applying.delete(applied); });
        applying.add(applied);
    };
    cdp = await connect(url, 15_000, { event: configure, closed: () => onClosed() });
    try {
        await cdp.send("Target.setAutoAttach", { ...PAUSED_ON_START, filter: BROWSER_TARGETS });
    }
    catch (error) {
        cdp.close();
        throw error;
    }
    await identityLanded(applying);
    return { closed, close: () => cdp?.close() };
}
/** A tab already open isn't paused, so it can navigate before its override lands. Chrome 156 then gives that page and its frames
 * empty high-entropy client hints, because the launcher's --user-agent leaves the override their only source. */
async function identityLanded(applying) {
    if (!applying.size)
        return;
    let timer;
    await Promise.race([Promise.allSettled(applying), new Promise((resolve) => { timer = setTimeout(resolve, IDENTITY_LANDS_MS); })]);
    clearTimeout(timer);
}
/** A paused worker answers its overrides only once it runs, so a worker is sent them and released at once. */
async function applyIdentity(cdp, sessionId, type, identity, options) {
    try {
        if (type === "page" && options.noPasskeys)
            for (const [method, params] of NO_PASSKEY_COMMANDS)
                await cdp.send(method, params, sessionId).catch(() => undefined);
        if (type === "page" || type === "iframe") {
            await cdp.send("Emulation.setUserAgentOverride", { ...identity }, sessionId);
            await cdp.send("Target.setAutoAttach", PAUSED_ON_START, sessionId);
        }
        else if (type.endsWith("worker")) {
            if (type !== "worker")
                void cdp.send("Emulation.setUserAgentOverride", { ...identity }, sessionId).catch(() => undefined);
            void cdp.send("Network.setUserAgentOverride", { ...identity }, sessionId).catch(() => undefined);
        }
    }
    catch { }
    await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
}
/** One sidecar per browser session, attached again whenever the session's browser was started anew. */
export class IdentitySidecars {
    live = new Map();
    attaching = new Map();
    cdpUrl;
    start;
    constructor(options = {}) {
        this.cdpUrl = options.cdpUrl ?? runningBrowserCdpUrl;
        this.start = options.start ?? startIdentitySidecar;
    }
    attached(session) { return this.live.has(session); }
    ensure(session, spec, identity) {
        if (this.live.has(session))
            return Promise.resolve();
        let attaching = this.attaching.get(session);
        if (!attaching) {
            attaching = this.attach(session, spec, identity).finally(() => this.attaching.delete(session));
            this.attaching.set(session, attaching);
        }
        return attaching;
    }
    forget(session) {
        this.live.get(session)?.close();
        this.live.delete(session);
    }
    async attach(session, spec, identity) {
        const url = await this.cdpUrl(session, spec);
        if (!url)
            return;
        const sidecar = await this.start(url, identity, undefined, { noPasskeys: spec.env?.AGENT_BROWSER_HEADLESS === "1" });
        this.live.get(session)?.close();
        this.live.set(session, sidecar);
        void sidecar.closed.then(() => { if (this.live.get(session) === sidecar)
            this.live.delete(session); });
    }
}
/** The engine's own Chrome on this machine only, read with the session's launch settings so the engine does not relaunch the
 * browser for it. A session closed since (a bot can close its browser) is started first, with `open` and no URL, which never
 * navigates, so the identity is in place before the bot's next command. */
async function runningBrowserCdpUrl(session, spec) {
    const env = browserRuntimeEnv({ ...spec.env, AGENT_BROWSER_SESSION: session });
    let answer = await inRunningBrowser(spec.command, env, ["get", "cdp-url"]);
    if (!answer) {
        await new Promise((resolve, reject) => {
            spawnBotWork(() => execFile(spec.command, ["open", "--json", "--no-webmcp"], { env, timeout: 60_000, windowsHide: true }, (error) => error ? reject(error) : resolve()));
        });
        answer = await inRunningBrowser(spec.command, env, ["get", "cdp-url"]);
    }
    const url = answer?.cdpUrl;
    return typeof url === "string" && /^wss?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\//u.test(url) ? url : null;
}
