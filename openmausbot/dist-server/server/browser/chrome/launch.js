import { execFile, spawn } from "node:child_process";
import { spawnBotWork } from "../../oom-score.js";
import { pipeTransport } from "../cdp/transport.js";
import { chromeArgs, chromeEnv } from "./flags.js";
import { diagnoseLaunchFailure } from "./host-setup.js";
import { devShmIsSmall } from "./shm.js";
export class ChromeLaunchError extends Error {
    output;
    /** The host setup Chrome needs, when that is why it could not start, is the cause. */
    constructor(message, output, host = null) {
        super(message, host ? { cause: host } : undefined);
        this.name = "ChromeLaunchError";
        this.output = output;
    }
}
const OUTPUT_LIMIT = 64 * 1024;
/** A binary's first start on a machine: Windows scans a newly downloaded Chrome before it runs, over 60 s for Chrome
 * for Testing 156 on GitHub's Windows runner. */
export const FIRST_START_MS = 120_000;
const HANDSHAKE_ID = 0;
function killTree(child, signal) {
    if (child.pid === undefined)
        return;
    if (process.platform === "win32") {
        execFile("taskkill", ["/PID", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], { windowsHide: true }, () => { });
        return;
    }
    try {
        child.kill(signal);
    }
    catch { }
}
/** Browser.getVersion over the fresh pipe: the first answer proves the pipe works. */
function handshake(transport, exited, timeoutMs) {
    return new Promise((resolve, reject) => {
        let done = false;
        const finish = (error, version) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            if (error)
                reject(error);
            else
                resolve(version);
        };
        transport.onMessage((text) => {
            if (done || !text.startsWith(`{"id":${HANDSHAKE_ID},`))
                return;
            try {
                const message = JSON.parse(text);
                if (message.id !== HANDSHAKE_ID)
                    return;
                if (message.error || !message.result)
                    finish(new Error(`Chrome refused its DevTools pipe: ${message.error?.message ?? "no answer"}`));
                else
                    finish(null, message.result);
            }
            catch { }
        });
        transport.onClose((reason) => finish(new Error(`Chrome closed its DevTools pipe before answering (${reason}).`)));
        void exited.then((exit) => finish(new Error(`Chrome exited before answering (${exit.signal ?? `code ${exit.code}`}).`)));
        const timer = setTimeout(() => finish(new Error(`Chrome did not answer on its DevTools pipe within ${timeoutMs} ms.`)), timeoutMs);
        transport.send(JSON.stringify({ id: HANDSHAKE_ID, method: "Browser.getVersion", params: {} }));
    });
}
/** Starts Chrome on --remote-debugging-pipe (fd 3 to Chrome, fd 4 back) and waits until it answers. */
export async function launchChrome(options) {
    const argv = chromeArgs({ ...options, smallShm: options.smallShm ?? devShmIsSmall() });
    const env = chromeEnv(options.env ?? process.env, {
        host: options.host,
        timezone: options.timezone ?? null,
        sandboxHelper: options.sandboxHelper ?? null,
        profileMarker: options.profileMarker ?? null,
    });
    const child = spawnBotWork(() => spawn(options.executablePath, argv, { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"], env, windowsHide: true }));
    let output = "";
    const keep = (chunk) => {
        output = (output + chunk.toString("utf8")).slice(-OUTPUT_LIMIT);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const exited = new Promise((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
        child.once("error", (error) => {
            keep(Buffer.from(`${error.message}\n`));
            resolve({ code: null, signal: null });
        });
    });
    const pid = child.pid;
    if (pid !== undefined)
        void exited.then(() => options.registry?.remove(pid));
    const transport = pipeTransport(child.stdio[3], child.stdio[4]);
    let version;
    try {
        if (pid !== undefined)
            options.registry?.add({ pid, startTime: null, userDataDir: options.userDataDir, ownerPid: process.pid, launchedAt: new Date().toISOString() });
        version = await handshake(transport, exited, options.handshakeTimeoutMs ?? 60_000);
    }
    catch (error) {
        killTree(child, "SIGKILL");
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
        const diagnosis = await diagnoseLaunchFailure({ executable: options.executablePath, output, env }).catch(() => null);
        throw new ChromeLaunchError(diagnosis?.message ?? (error instanceof Error ? error.message : String(error)), output, diagnosis);
    }
    const wait = (ms) => Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
    const stop = async (graceMs) => {
        const polite = await wait(graceMs);
        if (polite)
            return polite;
        // Chrome quits when its pipe closes.
        transport.close();
        const unpiped = await wait(2_000);
        if (unpiped)
            return unpiped;
        killTree(child, "SIGTERM");
        const terminated = await wait(2_000);
        if (terminated)
            return terminated;
        killTree(child, "SIGKILL");
        return exited;
    };
    const kill = async () => {
        killTree(child, "SIGKILL");
        return exited;
    };
    return {
        pid: pid,
        argv,
        transport,
        version,
        exited,
        output: () => output,
        close: (graceMs = 5_000) => stop(graceMs),
        kill,
    };
}
