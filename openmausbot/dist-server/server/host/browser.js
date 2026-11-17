// The bots' browser as the server hosts it: the engine's runtime and live view, which session a bot's browser is, and
// the integration a turn mounts. browserEngine.engine picks agent-browser (the default) or the new Chrome engine; a
// person's own Chrome (My Chrome) stays on agent-browser either way.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { browserEngineAttachCdpUrl, browserProfilePartitionId, browserProfilePartitionTarget, builtInBrowserEnabled, DATA_DIR } from "../config.js";
import { BrowserRuntime, TransportError, attachesToChrome, browserRuntimeEnv, formatBrowserTiming } from "../browser-runtime.js";
import { RelayTimeout, relay, relayCommand, relayInput } from "../browser-relay.js";
import { browserSteps } from "../browser-steps.js";
import { BrowserLive } from "../browser-live.js";
import { browserEgress } from "../browser/egress/registry.js";
import { releaseEndedGates } from "../browser/egress/release-ended.js";
import { agentBrowserIntegration, BUILT_IN_BROWSER_SYSTEM_PROMPT, browserDaemonFile, browserEngineEncryptionKey, prepareBrowserSessionState, clearBrowserSessionState, closeBrowserSession, browserEngineStatus, inRunningBrowser, browserSessionId, isTemporaryBrowserSession, browserProfileDirectory, noteBrowserEngineUnavailable, setBrowserViewport, } from "../browser-engine.js";
import { BrowserRoom, defaultBrowserRoomSize, spareForRoom } from "../browser-room.js";
import { BrowserSweep, browserIdleMs } from "../browser-lifecycle-cleanup.js";
import { AudienceBrowsers, audienceBrowserSuffix } from "../browser/audience.js";
import { namedUploadPaths } from "../browser-upload.js";
import { chromeLauncher } from "../browser/chrome/launcher.js";
import { LAUNCHER_SECCOMP_FD, browserLanguage } from "../browser/chrome/wrapper.js";
import { browserEngineKind } from "../browser/config.js";
import { parseSocks5Proxy } from "../browser/egress/policy.js";
import { ChromeEngine, chromeTarget, LiveRouter, profileKey, RuntimeRouter } from "../browser/engines.js";
import { CHROME_BROWSER_SYSTEM_PROMPT } from "../browser/prompt.js";
import { passkeyAnnotation } from "../browser/passkey-notice.js";
import { LentChromeDoors, lentChromeGuidance } from "../browser/lent-chrome.js";
import { processBudget } from "../process-room.js";
import { augmentedPath } from "../env-path.js";
import { harnessMcpTokenEnv } from "../harness-mcp-token.js";
import { AGENTS_NODE_FLAG, SPAWNED_PROXIES } from "../proxy-paths.js";
/** The lent computer's connection for a browser's pages, under the rule for everything it lends: only while the last
 * turn to hold that browser may use the lent computer. A browser no turn has held is the person's own. */
function lentDevice(device, holder, mayLend) {
    const lends = new Map();
    return (session) => {
        const turn = holder(session);
        if (turn)
            lends.set(session, mayLend(turn));
        return lends.get(session) === false ? null : device(session);
    };
}
const BOT_SESSION = /^bot-[A-Za-z0-9_.-]+$/;
export function createBrowserHost(deps) {
    const { cfg, turnResources, activeInternalGenerationByThread, mintInternalCapability, DESKTOP_MANAGED, CLOUD_HOME, PORT } = deps;
    chromeLauncher.setLanguageProvider(deps.language);
    const store = { get bots() { return deps.store().bots; }, bot: (id) => deps.store().bot(id),
        botByThread: (threadId) => deps.store().botByThread(threadId) };
    // Where turns wait for room (a self-hosted server under its pids limit), a new browser also waits for room for its
    // processes. `runs` is read only when a browser call asks, after usedBrowserSessions exists.
    const processRoom = deps.engineMemory?.selfHosted?.() ? processBudget.browserRoom((session) => browserRunning(session, usedBrowserSessions.get(session))) : null;
    // Only a bot waiting for a slot closes a browser a running turn holds; the idle sweep below never does.
    const browserRoom = new BrowserRoom({
        max: deps.browsersAtOnce ?? (() => defaultBrowserRoomSize()),
        spare: (session) => spareForRoom(agentBrowserRuntime.spare(session), { holds: !turnResources.free(`browser:${session}`), idleMs: idleMs() }),
        close: (session) => agentBrowserRuntime.closeIfIdle(session, 1),
        ...(processRoom ? { admit: (session) => processRoom.enter(session) } : {}),
    });
    const agentBrowserRuntime = new BrowserRuntime({
        closeBrowser: (session, spec) => closeBrowserSession(spec.command, browserRuntimeEnv({ ...spec.env, AGENT_BROWSER_SESSION: session })),
        applyViewport: (spec, size) => setBrowserViewport(spec.command, spec.env, size),
        // A browser a person's view started counts toward the limit too. It is not refused, so a bot's next new one waits.
        launch: {
            ready: (spec) => chromeLauncher.ready(spec),
            started: (session, spec) => {
                if (!attachesToChrome(spec.env ?? {}))
                    browserRoom.entered(session);
                return chromeLauncher.started(session, spec);
            },
            stopped: (session) => chromeLauncher.stopped(session),
        },
        room: browserRoom,
        relayCommand: (spec, session, command, timeoutMs) => relayCommand(spec, session, command, timeoutMs).catch((error) => {
            throw error instanceof RelayTimeout ? new TransportError(error.message) : error;
        }),
        steps: browserSteps,
        onTiming: process.env.OMB_BROWSER_TIMING === "1" ? (timing) => console.info(formatBrowserTiming(timing)) : undefined,
    });
    const browserBox = deps.browserBox;
    const boxed = Boolean(browserBox?.(LAUNCHER_SECCOMP_FD, []));
    if (browserBox)
        chromeLauncher.boxWith(() => browserBox(LAUNCHER_SECCOMP_FD, []));
    const agentBrowserLive = new BrowserLive({ runtime: agentBrowserRuntime, devTools: {
            url: (port) => relay(port, { action: "cdp_url" }, { timeoutMs: 5_000, maxBytes: 65_536 }).then((answer) => answer.data?.cdpUrl),
        } });
    const host = DESKTOP_MANAGED ? "desktop" : CLOUD_HOME || existsSync("/.dockerenv") ? "container" : "server";
    const idleMs = () => browserIdleMs(cfg, { cloudHome: Boolean(CLOUD_HOME) });
    const chromeEngine = new ChromeEngine({
        dataDir: DATA_DIR,
        host,
        egressPort: (key) => browserEgress.open(key),
        egressNotice: (key) => browserEgress.takeNotice(key),
        idleMs,
        language: deps.language,
        held: (session) => !turnResources.free(`browser:${session}`),
        log: (line) => console.warn(line),
    });
    const lendRefusal = deps.lendRefusal ?? (() => "unproven");
    const mayLend = (turn) => lendRefusal(turn) === null;
    const lentChrome = deps.lentChrome;
    const chromeRefusals = new Map();
    /** lentDevice's rule for the lent Chrome: the last holder's verdict, and a browser no turn has held is the person's own. */
    function chromeRefusal(session) {
        const turn = turnResources.holder(`browser:${session}`);
        if (turn)
            chromeRefusals.set(session, lendRefusal(turn));
        return chromeRefusals.get(session) ?? null;
    }
    const lentChromeAllowed = (session) => chromeRefusal(session) === null;
    /** Each refusal has its own way out: a new conversation can't undo a memory change, for one. */
    const refusedAs = (session) => chromeRefusals.get(session) ?? "not-allowed";
    // The desktop's idle time, not a Cloud home's shorter one: each reconnect may make Chrome ask the person to Allow again.
    const doors = lentChrome ? new LentChromeDoors({ route: () => lentChrome.route(), allowed: lentChromeAllowed, idleMs: () => browserIdleMs(cfg, { cloudHome: false }) }) : undefined;
    const doorUrls = new Map();
    const leftovers = new Map();
    async function lentChromeDoor(session) {
        if (!doors)
            return undefined;
        // A browser already running when this server first opens the session's door was told another address: an earlier
        // server's door, gone after a restart, or none. An attached browser is never swept or idle-closed, so it is closed
        // before anything uses the new door.
        if (!doors.owns(session))
            leftovers.set(session, closeLeftover(session));
        const url = await doors.door(session);
        await leftovers.get(session);
        doorUrls.set(session, url);
        return url;
    }
    async function closeLeftover(session) {
        const engine = browserEngineStatus();
        if (engine.kind !== "ready" || !browserRunning(session, undefined))
            return;
        const closed = await closeBrowserSession(engine.binaryPath, browserRuntimeEnv({ AGENT_BROWSER_SESSION: session })).catch(() => false);
        if (!closed)
            console.warn(`browser ${session}: could not close the browser left running before its door to your Chrome opened`);
    }
    /** A profile switched back to the built-in browser keeps its session name and its door, but its calls no longer use it. */
    function viaDoor(session, spec) {
        const url = doorUrls.get(session);
        return url !== undefined && spec.env.AGENT_BROWSER_CDP === url;
    }
    // A tool call that would open Reddit from MausBot Cloud is refused before it reaches the browser. My Chrome is the
    // person's own, outside the egress gate too; on My Cloud a call that can't reach it now says why instead.
    const browserRuntime = new RuntimeRouter(agentBrowserRuntime, chromeEngine, {
        refusal: (_session, spec, params) => (attachesToChrome(spec.env) ? null : browserEgress.callRefusal(params)),
        // The opt-in engine's browsers wait for the server's room here; agent-browser's wait in browserRoom above. The
        // person's own Chrome runs outside this server, and a close frees room.
        room: (session, spec, params) => (!processRoom || attachesToChrome(spec.env) || params?.name === "agent_browser_close"
            ? Promise.resolve(null) : processRoom.enter(session)),
        // After beforeDispatch's claim the holder is this call's own turn, so the verdict is the caller's, not the last
        // holder's. Only a caller who may use the computer learns whether it lends Chrome or is online.
        afterClaim: (session, spec) => {
            if (!viaDoor(session, spec))
                return null;
            const lender = lentChrome?.lender() ?? null;
            if (!lentChromeAllowed(session))
                return lentChromeGuidance(refusedAs(session), lender);
            if (!lender)
                return lentChromeGuidance("not-lent", null);
            return lender.online ? null : lentChromeGuidance("offline", lender);
        },
        annotate: passkeyAnnotation(CLOUD_HOME ? "cloud" : DESKTOP_MANAGED ? "desktop" : "server"),
        // agent-browser's own error names only the CDP connection; the door knows what went wrong on the way.
        afterCall: (session, spec, result) => {
            const failed = result;
            const found = failed?.isError === true && viaDoor(session, spec) ? doors?.problem(session) : null;
            // A door refused under an earlier holder says nothing about a caller that may use it.
            const problem = found === "not-allowed" && lentChromeAllowed(session) ? null : found;
            if (!problem)
                return result;
            const content = Array.isArray(failed.content) ? failed.content : [];
            return { ...failed, content: [...content, { type: "text", text: lentChromeGuidance(problem === "not-allowed" ? refusedAs(session) : problem, lentChrome?.lender() ?? null) }] };
        },
    });
    // agent-browser keeps its Chrome connection across turns, so a turn that may not lend must not inherit an open one.
    if (doors)
        turnResources.onClaim((resource, owner) => {
            const session = resource.startsWith("browser:") ? resource.slice("browser:".length) : null;
            if (session === null || !doors.owns(session))
                return;
            const refused = lendRefusal(owner);
            if (refused === null)
                return;
            chromeRefusals.set(session, refused);
            doors.drop(session);
        });
    const browserLive = new LiveRouter(agentBrowserLive, chromeEngine);
    const usedBrowserSessions = new Map();
    const audiences = new AudienceBrowsers(join(DATA_DIR, "browser", "audiences.json"));
    const browserAudience = (threadId) => (threadId && deps.audienceOf ? deps.audienceOf(threadId) : "team");
    const device = deps.device && lentDevice(deps.device, (session) => turnResources.holder(`browser:${session}`), mayLend);
    const egressHost = DESKTOP_MANAGED ? "desktop" : CLOUD_HOME ? "cloud" : "server";
    // Self-hosted servers only: the owner's switch for this server's own sites and its local network. A shared company
    // workspace's network is the operator's, so its stored switch and allow-list are ignored, like MausBot Cloud's.
    const hostedServer = egressHost === "server" && Boolean(deps.HOSTED_WORKSPACE);
    const sitesSwitch = egressHost === "server" && !hostedServer;
    browserEgress.configure({ host: egressHost, config: () => (hostedServer ? undefined : cfg.browserEngine?.egress), ...(device ? { device } : {}) });
    /** A live bot's, profile's or temporary browser of this data dir, for any audience. */
    const belongs = (session) => isTemporaryBrowserSession(session) || audiences.variants().some((suffix) => store.bots.some((bot) => browserSessionId(bot.id + suffix, "") === session)
        || (cfg.browserProfiles ?? []).some((profile) => !usesMyChrome(profile.id) && browserSessionId("", browserProfilePartitionId(profile) + suffix) === session));
    // The agent-browser daemon outlives its MCP transport and this server; My Chrome is the person's own. A Cloud home's
    // HOME is this server's alone, so a deleted bot's browser there is closed too.
    const agentBrowserSweep = new BrowserSweep({
        engine: () => { const engine = browserEngineStatus(); return engine.kind === "ready" ? engine.binaryPath : null; },
        owns: (session) => belongs(session) || (Boolean(CLOUD_HOME) && BOT_SESSION.test(session)),
        live: (session) => usedBrowserSessions.has(session) && belongs(session),
        held: (session) => !turnResources.free(`browser:${session}`),
        closeIdle: (session) => browserRuntime.closeIfIdle(session, idleMs(), usedBrowserSessions.get(session)),
    });
    // A browser that has ended keeps no loopback listener: its gate opens again with it, on the same port where it can, and
    // the session's launch settings are worked out again then.
    const releaseGates = () => releaseEndedGates({ sessions: () => browserEgress.sessions(), release: async (session) => { usedBrowserSessions.delete(session); await browserEgress.release(session); },
        env: (session) => { const spec = usedBrowserSessions.get(session); return spec && !chromeTarget(session, spec) ? spec.env : null; },
        running: (session) => browserRunning(session, usedBrowserSessions.get(session)),
        inUse: (session) => !turnResources.free(`browser:${session}`) || agentBrowserRuntime.working(session) });
    let gateTimer;
    const browserSweep = {
        start() {
            gateTimer = setInterval(() => void releaseGates().catch(() => undefined), 60_000);
            gateTimer.unref?.();
            agentBrowserSweep.start();
            chromeEngine.start({ inUse: browserEngineKind(cfg) === "chrome", prepare: builtInBrowserEnabled(cfg) });
            return browserSweep;
        },
        closeAll: () => {
            clearInterval(gateTimer);
            doors?.close();
            doorUrls.clear();
            leftovers.clear();
            return agentBrowserSweep.closeAll();
        },
    };
    // The viewer and the agent must address the SAME temporary browser.
    const temporaryBrowserSessions = new Map();
    /** The suffix an audience gives a browser's name, remembered so a deletion erases every audience's browser. */
    function noted(audience) {
        const suffix = audienceBrowserSuffix(audience);
        audiences.note(suffix);
        return suffix;
    }
    function sessionFor(botId, profile, suffix) {
        if (profile === "guest") {
            const key = botId + suffix;
            let session = temporaryBrowserSessions.get(key);
            if (!session) {
                session = browserSessionId(key, "guest");
                temporaryBrowserSessions.set(key, session);
            }
            return session;
        }
        const target = profile ? browserProfilePartitionTarget(cfg, profile) : null;
        return browserSessionId(botId + suffix, target ? target.partitionId + suffix : "");
    }
    function currentBrowserSession(botId, profile, audience = "team") {
        return sessionFor(botId, profile, noted(audience));
    }
    /** Every audience's browser of a bot as it is named now; a temporary one only once it started. */
    function browserSessionsOf(botId, profile) {
        return audiences.variants().flatMap((suffix) => {
            if (profile !== "guest")
                return [sessionFor(botId, profile, suffix)];
            const session = temporaryBrowserSessions.get(botId + suffix);
            return session ? [session] : [];
        });
    }
    async function forgetTemporaryBrowser(botId) {
        await Promise.all(audiences.variants().map((suffix) => forgetTemporaryKey(botId + suffix)));
    }
    async function forgetTemporaryKey(key) {
        const session = temporaryBrowserSessions.get(key);
        if (!session)
            return;
        temporaryBrowserSessions.delete(key);
        const spec = usedBrowserSessions.get(session);
        usedBrowserSessions.delete(session);
        if (chromeTarget(session, spec)) {
            await chromeEngine.service.close(session);
            return;
        }
        const engine = browserEngineStatus();
        if (engine.kind !== "ready")
            return;
        const closed = await clearBrowserSessionState(engine.binaryPath, session, {
            env: { PATH: augmentedPath() }, encryptionKey: browserEngineEncryptionKey(),
        });
        if (closed)
            await browserRuntime.close(session);
        else
            console.warn(`temporary browser ${session}: could not close its session; run agent-browser --session ${session} close on this server`);
    }
    function myChromeAvailable() {
        return DESKTOP_MANAGED || browserEngineAttachCdpUrl(cfg) !== null || Boolean(lentChrome?.lender());
    }
    /** A My Chrome profile on My Cloud: the person's lent Chrome, through this session's door. */
    function lentChromeSession(profileId) {
        return !DESKTOP_MANAGED && browserEngineAttachCdpUrl(cfg) === null && doors !== undefined && usesMyChrome(profileId);
    }
    /** Where My Chrome is on My Cloud: the computer that lends it, or that one could. */
    function lentChromeSummary() {
        const lender = lentChrome?.lender() ?? null;
        if (lender)
            return { myChromeOn: lender };
        return lentChrome ? { myChromeLendable: true } : {};
    }
    /** On My Cloud a My Chrome profile stays the person's Chrome while no computer lends it: its calls say so, and never
     * fall back to the built-in browser, whose sign-ins differ. */
    function usesMyChrome(profileId) {
        return Boolean(profileId) && (myChromeAvailable() || lentChrome !== undefined)
            && cfg.browserProfiles?.some((profile) => profile.id === profileId && profile.browser === "chrome") === true;
    }
    function browserSessionSpec(binaryPath, session, profile, egressPort, cdpUrl) {
        const attachCdpUrl = cdpUrl ?? browserEngineAttachCdpUrl(cfg);
        const locale = browserLanguage(process.env, deps.language?.());
        return agentBrowserIntegration({
            binaryPath, session, encryptionKey: browserEngineEncryptionKey(), persistent: profile !== "guest", egressPort,
            env: { ...process.env, PATH: augmentedPath(), ...(locale ? { OMB_BROWSER_LANG: locale } : {}) },
            launcher: chromeLauncher.env(),
            ...(usesMyChrome(profile) ? { attach: attachCdpUrl ? { cdpUrl: attachCdpUrl } : {} } : {}),
        });
    }
    function browserProfileIdOf(profile) {
        const target = profile && profile !== "guest" ? browserProfilePartitionTarget(cfg, profile) : null;
        return target?.profileId ?? profile;
    }
    /** The new engine runs a bot's browser when the flag is on, except in the person's own Chrome. */
    function onChrome(profile) {
        return browserEngineKind(cfg) === "chrome" && !usesMyChrome(browserProfileIdOf(profile));
    }
    function chromeSpec(botId, profile, audience) {
        const suffix = noted(audience);
        const session = sessionFor(botId, profile, suffix);
        const target = profile && profile !== "guest" ? browserProfilePartitionTarget(cfg, profile) : null;
        return { session, spec: chromeEngine.spec(session, profileKey(botId + suffix, session, { guest: profile === "guest", partitionId: target ? target.partitionId + suffix : null })) };
    }
    /** Chrome for the new engine, the installed agent-browser otherwise. */
    function browserReady(profile) {
        return onChrome(profile) ? chromeEngine.summary().kind === "engine" : browserEngineStatus().kind === "ready";
    }
    function turnIntegration(botId, session, turn) {
        const token = mintInternalCapability({ botId, ...turn, browserSession: session,
            kind: "browser", depth: 0, skillAuthoring: false, createdBots: 0, openedThreads: 0 });
        return {
            command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, "browser"], env: {
                ...AGENTS_NODE_FLAG, [harnessMcpTokenEnv("browser")]: token, OMB_HARNESS_URL: `http://127.0.0.1:${PORT}`,
            },
        };
    }
    async function browserIntegration(botId, profile, turn, audience = browserAudience(turn?.threadId)) {
        const profileTarget = profile && profile !== "guest" ? browserProfilePartitionTarget(cfg, profile) : null;
        const partitionId = profile === "guest" ? "guest" : (profileTarget?.partitionId ?? "");
        const browserProfileId = profileTarget?.profileId ?? profile;
        if (onChrome(profile)) {
            const { session, spec } = chromeSpec(botId, profile, audience);
            usedBrowserSessions.set(session, spec);
            return { profile: partitionId, session, spec, integration: turn ? turnIntegration(botId, session, turn) : spec };
        }
        const status = browserEngineStatus();
        if (status.kind !== "ready") {
            noteBrowserEngineUnavailable(status);
            return null;
        }
        const session = currentBrowserSession(botId, profile, audience);
        const cdpUrl = lentChromeSession(browserProfileId) ? await lentChromeDoor(session) : undefined;
        const spec = browserSessionSpec(status.binaryPath, session, browserProfileId, usesMyChrome(browserProfileId) ? undefined : await browserEgress.open(session), cdpUrl);
        usedBrowserSessions.set(session, spec);
        await prepareBrowserSessionState(status.binaryPath, session, { env: spec.env, persistent: profile !== "guest" && !attachesToChrome(spec.env), isCurrent: () => {
                const current = store.bot(botId);
                return !!current && current.browser !== false && builtInBrowserEnabled(cfg)
                    && currentBrowserSession(current.id, current.browserProfile, audience) === session
                    && (!turn || activeInternalGenerationByThread.get(turn.threadId) === turn.generation);
            } });
        if (!turn)
            return { profile: partitionId, session, spec, integration: spec };
        return { profile: partitionId, session, spec, integration: turnIntegration(botId, session, turn) };
    }
    /** A bot's browser as it runs or would run now, without preparing it; null while its engine is not installed. */
    async function currentBrowserSpec(botId, profile, audience = "team") {
        if (onChrome(profile))
            return chromeSpec(botId, profile, audience);
        const engine = browserEngineStatus();
        if (engine.kind !== "ready")
            return null;
        const session = currentBrowserSession(botId, profile, audience);
        const used = usedBrowserSessions.get(session);
        if (used)
            return { session, spec: used };
        const profileId = browserProfileIdOf(profile);
        const cdpUrl = lentChromeSession(profileId) ? await lentChromeDoor(session) : undefined;
        return { session, spec: browserSessionSpec(engine.binaryPath, session, profileId, usesMyChrome(profileId) ? undefined : await browserEgress.open(session), cdpUrl) };
    }
    /** fill_login's reads and typing, on whichever engine runs the session. */
    function loginInput(session, spec, env) {
        if (chromeTarget(session, spec)) {
            const deps = chromeEngine.loginDeps(session);
            if (deps)
                return deps;
        }
        return { engine: (args) => inRunningBrowser(spec.command, env, args), ...relayInput(spec, session) };
    }
    function browserSystemPrompt(profile) {
        return onChrome(profile) ? CHROME_BROWSER_SYSTEM_PROMPT : BUILT_IN_BROWSER_SYSTEM_PROMPT;
    }
    /** The signed-in sites list reads agent-browser's saved state, which My Chrome and the new browser do not keep. */
    function signedInSitesRefusal(profile) {
        if (usesMyChrome(profile))
            return "This profile uses your own Chrome. Sign in and out of sites there.";
        return onChrome(profile) ? "The new browser does not list signed-in sites yet. Sign out in the browser itself, or turn off New browser in Settings." : null;
    }
    async function closeBrowser(session, spec) {
        if (!chromeTarget(session, spec))
            return closeBrowserSession(spec.command, browserRuntimeEnv({ ...spec.env, AGENT_BROWSER_SESSION: session }));
        await chromeEngine.service.close(session);
        return true;
    }
    /** After browserEngine.engine changed: viewers reconnect and each bot's next call starts its browser on the engine now chosen. */
    function browserEngineSwitched() {
        browserLive.closeAll();
        for (const [session, spec] of usedBrowserSessions) {
            if (attachesToChrome(spec.env))
                continue;
            usedBrowserSessions.delete(session);
            void closeBrowser(session, spec).then((closed) => {
                if (!closed)
                    console.warn(`browser ${session}: could not close it after the browser engine changed`);
            });
        }
        if (browserEngineKind(cfg) !== "chrome")
            void chromeEngine.service.closeAll().catch(() => undefined);
        chromeEngine.start({ inUse: browserEngineKind(cfg) === "chrome", prepare: builtInBrowserEnabled(cfg) });
    }
    function browserRunning(session, spec) {
        if (chromeTarget(session, spec))
            return chromeEngine.service.runs(session);
        return existsSync(browserDaemonFile(browserRuntimeEnv({ ...spec?.env, AGENT_BROWSER_SESSION: session }), ".pid"));
    }
    /** The browser a thread's bot would start; a temporary one has no session until its first call. My Chrome is the person's own. */
    function threadBrowser(threadId) {
        const bot = store.botByThread(threadId);
        if (!bot || bot.browser === false || bot.computer === "off" || !builtInBrowserEnabled(cfg) || usesMyChrome(bot.browserProfile))
            return null;
        const audience = browserAudience(threadId);
        const session = bot.browserProfile === "guest" ? temporaryBrowserSessions.get(bot.id + audienceBrowserSuffix(audience)) : currentBrowserSession(bot.id, bot.browserProfile, audience);
        return { session, spec: session === undefined ? undefined : usedBrowserSessions.get(session) };
    }
    /** Tried until no turn holds the browser and no call runs in it, or for 30 s: the stopped turn may still be settling. */
    async function closeForMemory(session, spec) {
        for (let attempt = 0; attempt < 15 && browserRunning(session, spec); attempt++) {
            if (turnResources.free(`browser:${session}`) && await browserRuntime.closeUnused(session, spec)) {
                console.info(`browser ${session}: closed to free memory after its bot was stopped`);
                return;
            }
            await sleep(2_000);
        }
    }
    const engineBrowsers = {
        starts: (threadId) => {
            const browser = threadBrowser(threadId);
            return browser !== null && (browser.session === undefined || !browserRunning(browser.session, browser.spec));
        },
        which: (threadId) => threadBrowser(threadId)?.session,
        running: (threadId) => {
            const browser = threadBrowser(threadId);
            return browser?.session !== undefined && browserRunning(browser.session, browser.spec);
        },
        stopped: (threadId) => {
            const browser = threadBrowser(threadId);
            if (browser?.session !== undefined && browser.spec)
                void closeForMemory(browser.session, browser.spec);
        },
    };
    deps.engineMemory?.useBrowsers(engineBrowsers);
    /** A deleted bot's or profile's browser on the new engine, whatever the flag says now. */
    function eraseChromeBrowser(request) {
        if (request.type === "openmausbot:browser-bot-deleted" && request.botId)
            return chromeEngine.erase({ kind: "bot", id: request.botId, partitionId: "" });
        if (request.partitionId)
            return chromeEngine.erase({ kind: "profile", id: request.partitionId, partitionId: request.partitionId });
        return Promise.resolve(true);
    }
    /**
     * The agent-browser whose saved sessions a deletion erases: the one OpenMausBot installed, or on a Cloud home the
     * image's own. Another one on PATH may be a wrapper whose failing close would hold the cleanup journal forever, so
     * it only closes the running browser.
     */
    function cleanupEngine() {
        const managed = browserEngineStatus({ managedOnly: true });
        if (managed.kind === "ready")
            return managed;
        const used = browserEngineStatus();
        return CLOUD_HOME && used.kind === "ready" ? used : null;
    }
    /** A deleted bot's or profile's browser on both engines, for every audience: stopped and its saved sign-ins erased;
     * true once that is done. */
    async function eraseDeletedBrowser(request) {
        const results = await Promise.all(audiences.variants().map((suffix) => eraseOneBrowser({
            ...request, ...(request.botId ? { botId: request.botId + suffix } : {}), ...(request.partitionId ? { partitionId: request.partitionId + suffix } : {}),
        })));
        return results.every(Boolean);
    }
    async function eraseOneBrowser(request) {
        const session = request.type === "openmausbot:browser-bot-deleted" && request.botId ? browserSessionId(request.botId, "")
            : request.partitionId ? browserSessionId("", request.partitionId) : null;
        const engine = cleanupEngine();
        const erased = async (name) => {
            if (!engine) {
                const used = browserEngineStatus();
                if (used.kind === "ready")
                    void closeBrowserSession(used.binaryPath, browserRuntimeEnv({ AGENT_BROWSER_SESSION: name }));
                return true;
            }
            const ok = await clearBrowserSessionState(engine.binaryPath, name, { encryptionKey: browserEngineEncryptionKey() });
            if (!ok)
                console.warn(`browser cleanup: could not clear saved state for session ${name}; restart OpenMausBot to retry this profile's cleanup. Do not use state clear --all: it erases other profiles too.`);
            return ok;
        };
        const results = await Promise.all([eraseChromeBrowser(request), ...session ? [erased(session)] : []]);
        return results.every(Boolean);
    }
    /** A person who left a Team Cloud: their own browser of every bot and every shared profile, stopped and its saved
     * sign-ins and profile folder erased. True once that is done. */
    async function eraseAudienceBrowsers(audience) {
        const suffix = audienceBrowserSuffix(audience);
        if (!suffix || !audiences.variants().includes(suffix))
            return true;
        const requests = [
            ...store.bots.map((bot) => ({ type: "openmausbot:browser-bot-deleted", requestId: "team-member-left", botId: bot.id + suffix })),
            ...(cfg.browserProfiles ?? []).filter((profile) => !usesMyChrome(profile.id)).map((profile) => ({
                type: "openmausbot:browser-profile-deleted", requestId: "team-member-left", partitionId: browserProfilePartitionId(profile) + suffix
            })),
        ];
        return (await Promise.all(requests.map((request) => eraseOneBrowser(request)))).every(Boolean);
    }
    /** Chrome receives private copies; a boxed agent-browser reads them from its own profile's folder. */
    function uploadPaths(files, session, spec) {
        const chrome = chromeTarget(session, spec);
        const folder = boxed && !chrome ? join(browserProfileDirectory(session), "omb-uploads") : join(DATA_DIR, "browser-uploads");
        return namedUploadPaths(files, folder, Date.now(), { everyFile: boxed || Boolean(chrome) });
    }
    /** The saved sign-ins of a bot's or a shared profile's browser, for one audience. */
    async function signedInSitesTarget(which, audience = "team") {
        const engine = browserEngineStatus();
        if (engine.kind !== "ready")
            return { status: 409, error: engine.reason };
        let session;
        let profile;
        if ("profile" in which) {
            const target = browserProfilePartitionTarget(cfg, which.profile);
            if (!target)
                return { status: 404, error: "This browser profile was removed." };
            session = browserSessionId("", target.partitionId + noted(audience));
            profile = target.profileId;
        }
        else {
            const bot = store.bot(which.bot);
            if (!bot)
                return { status: 404, error: "no such bot" };
            if (bot.browserProfile === "guest")
                return { status: 409, error: "A temporary browser saves no sign-ins." };
            session = currentBrowserSession(bot.id, bot.browserProfile, audience);
            profile = bot.browserProfile;
        }
        const refusal = signedInSitesRefusal(profile);
        if (refusal)
            return { status: 409, error: refusal };
        return { binaryPath: engine.binaryPath, session, env: browserSessionSpec(engine.binaryPath, session, profile, await browserEgress.open(session)).env, encryptionKey: browserEngineEncryptionKey() };
    }
    /** What Settings shows of the engine that runs bots' browsers here; My Chrome stays on agent-browser. */
    function engineSummary(agentBrowser) {
        const serverSites = sitesSwitch ? { serverSites: cfg.browserEngine?.egress?.localNetwork === true } : {};
        const engine = browserEngineKind(cfg);
        const proxyValue = cfg.browserEngine?.egress?.proxy;
        const proxySaved = typeof proxyValue === "string" && proxyValue.trim().length > 0;
        const proxyConfigured = builtInBrowserEnabled(cfg) && !hostedServer && parseSocks5Proxy(proxyValue) !== null;
        return {
            ...(engine === "chrome" ? { ...chromeEngine.summary(), myChrome: agentBrowser.myChrome, ...lentChromeSummary(), engine } : { ...agentBrowser, engine }),
            ...serverSites,
            ...(proxyConfigured ? { proxyConfigured: true } : {}),
            ...(proxySaved ? { proxySaved: true } : {}),
        };
    }
    return {
        browserRuntime, browserLive, browserRoom, usedBrowserSessions, browserSweep, temporaryBrowserSessions, browserIdleMs: idleMs,
        currentBrowserSession, forgetTemporaryBrowser, myChromeAvailable, lentChromeSummary, usesMyChrome, browserSessionSpec, browserIntegration,
        browserReady, currentBrowserSpec, loginInput, browserSystemPrompt, signedInSitesRefusal, closeBrowser, browserEngineSwitched,
        eraseDeletedBrowser, engineSummary, engineBrowsers, browserAudience, browserSessionsOf, signedInSitesTarget, uploadPaths,
        eraseAudienceBrowsers,
    };
}
