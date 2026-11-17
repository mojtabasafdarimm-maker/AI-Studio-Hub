// The driver's real-Chrome suites run when OMB_CDP_CHROME names a Chrome, or
// when OMB_CDP_E2E=1 asks for the one installed in the usual place (GitHub's
// runners have Google Chrome). Otherwise they are skipped.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir, waitForExit } from "../../../testing/cleanup.js";
import { loopbackPage, openOwnPage } from "../../chrome/calibrate.js";
import { chromeEnv } from "../../chrome/flags.js";
import { FIRST_START_MS, launchChrome } from "../../chrome/launch.js";
import { sandboxDisabled } from "../../chrome/host-setup.js";
import { credentialStoreFlags } from "../../egress/gate.js";
import { CdpBrowser } from "../browser.js";
import { CdpConnection } from "../connection.js";
import { DEFAULT_NAVIGATION_TIMEOUT_MS } from "../page.js";
import { pipeTransport, tracingTransport } from "../transport.js";
const INSTALLED = {
    darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"],
    win32: [
        `${process.env["PROGRAMFILES"] ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env["LOCALAPPDATA"] ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
    ],
};
export function chromeForTests() {
    const named = process.env.OMB_CDP_CHROME;
    if (named) {
        if (!existsSync(named))
            throw new Error(`OMB_CDP_CHROME names no file: ${named}`);
        return named;
    }
    if (process.env.OMB_CDP_E2E !== "1")
        return null;
    const found = (INSTALLED[process.platform] ?? []).find((path) => existsSync(path));
    if (!found)
        throw new Error("OMB_CDP_E2E=1 but no installed Google Chrome was found; set OMB_CDP_CHROME.");
    return found;
}
export const CHROME = chromeForTests();
if (!CHROME)
    console.log("skipping omb-cdp real-Chrome suites: set OMB_CDP_CHROME to a Chrome executable, or OMB_CDP_E2E=1 to use the installed Google Chrome");
export const FIRST_LAUNCH_MS = FIRST_START_MS;
/** Linux CI on containers and some runners needs the operator opt-out; never set by the driver itself. */
const sandbox = !sandboxDisabled(process.env);
export const HOST = process.env.OMB_CDP_HOST === "container" ? "container" : process.env.OMB_CDP_HOST === "server" ? "server" : "desktop";
export function testRoot() {
    const root = process.env.OMB_CDP_TEST_TMP ?? tmpdir();
    mkdirSync(root, { recursive: true });
    return root;
}
/** Every command a suite's browsers sent, for the forbidden-method assertion. */
export const TRACE = [];
let pageWorldCalls = 0;
/** Marks the commands `work` sends as a deliberate page-world evaluation. */
export async function inPageWorld(work) {
    pageWorldCalls++;
    try {
        return await work();
    }
    finally {
        pageWorldCalls--;
    }
}
/** Kept apart from the driver's own guard on purpose: a trace is checked against the design's list, not the code under test. */
const FORBIDDEN = /^(?:Runtime\.enable|Runtime\.addBinding|Console\.\w+|Debugger\.\w+|Profiler\.\w+|HeapProfiler\.\w+|Network\.getAllCookies)$/;
export function forbiddenCommand(sent) {
    if (FORBIDDEN.test(sent.method))
        return true;
    if (sent.method === "Runtime.evaluate" && sent.params.contextId === undefined)
        return !sent.pageWorld;
    return sent.method === "Page.addScriptToEvaluateOnNewDocument" && !sent.params.worldName;
}
export function forbiddenCommands(trace = TRACE) {
    return trace.filter(forbiddenCommand).map((sent) => `${sent.label}: ${sent.method} ${JSON.stringify(sent.params).slice(0, 120)}`);
}
export async function startChrome(label, { launch = {}, browser: browserOptions = {}, takeFirstNavigation = process.platform === "win32" } = {}) {
    if (!CHROME)
        throw new Error("No Chrome to test with.");
    const dir = mkdtempSync(join(testRoot(), "omb-cdp-"));
    const chrome = await launchChrome({
        executablePath: CHROME,
        userDataDir: join(dir, "profile"),
        mode: "headless",
        host: HOST,
        sandbox,
        handshakeTimeoutMs: FIRST_LAUNCH_MS,
        ...launch,
    });
    const trace = [];
    const transport = tracingTransport(chrome.transport, (sent) => {
        const traced = { ...sent, label, pageWorld: pageWorldCalls > 0 };
        trace.push(traced);
        TRACE.push(traced);
    });
    const browser = await CdpBrowser.connect(transport, { downloadDir: join(dir, "downloads"), ...browserOptions });
    if (takeFirstNavigation)
        await firstNavigation(browser);
    return {
        chrome,
        browser,
        dir,
        trace,
        async close() {
            await browser.close().catch(() => { });
            await chrome.close(3_000);
            await removeTempDir(dir);
        },
    };
}
async function firstNavigation(browser) {
    const own = await loopbackPage();
    try {
        const tab = await browser.waitForPage();
        await openOwnPage(tab, own.url, DEFAULT_NAVIGATION_TIMEOUT_MS);
        await tab.navigate("about:blank");
    }
    finally {
        own.close();
    }
}
/**
 * What Chrome alone takes on this machine to start and show `url`: the same binary on a fresh profile over its pipe,
 * with none of the driver's flags, setup or waits. The latency targets are measured against it.
 */
export async function bareChromeStart(url) {
    if (!CHROME)
        throw new Error("No Chrome to test with.");
    const dir = mkdtempSync(join(testRoot(), "omb-cdp-bare-"));
    const args = ["--remote-debugging-pipe", `--user-data-dir=${join(dir, "profile")}`, "--headless=new", "--no-first-run", "--no-default-browser-check", ...credentialStoreFlags(), ...(sandbox ? [] : ["--no-sandbox"]), "about:blank"];
    const started = performance.now();
    const child = spawn(CHROME, args, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], env: chromeEnv(process.env, { host: HOST }), windowsHide: true });
    const connection = new CdpConnection(pipeTransport(child.stdio[3], child.stdio[4]), { defaultTimeoutMs: FIRST_LAUNCH_MS });
    try {
        let targetId;
        while (!targetId) {
            const { targetInfos } = await connection.root.send("Target.getTargets");
            targetId = targetInfos.find((info) => info.type === "page")?.targetId;
            if (!targetId)
                await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const { sessionId } = await connection.root.send("Target.attachToTarget", { targetId, flatten: true });
        const page = connection.session(sessionId);
        await page.send("Page.enable");
        const loaded = page.waitFor("Page.loadEventFired", { timeoutMs: FIRST_LAUNCH_MS });
        await page.send("Page.navigate", { url });
        await loaded;
        return performance.now() - started;
    }
    finally {
        await connection.root.send("Browser.close", {}, { timeoutMs: 5_000 }).catch(() => { });
        connection.close();
        await waitForExit(child, { graceMs: 5_000 });
        await removeTempDir(dir);
    }
}
