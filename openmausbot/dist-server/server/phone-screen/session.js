import { randomInt } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { execCli, killCliTree, spawnCli } from "../procs.js";
import { deviceDir, deviceSocket, serverArgs, VideoReader } from "./scrcpy-wire.js";
const ADB_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 10_000;
const CONNECT_RETRY_MS = 100;
const SERVER_STDERR_KEPT = 2_048;
// adb's words for a serial that is unplugged or has dropped off the bus.
const DEVICE_GONE = /device '.*' not found|device offline|no devices\/emulators found/;
export function runAdb(adbPath, args) {
    return new Promise((resolve, reject) => {
        execCli(adbPath, args, { timeout: ADB_TIMEOUT_MS }, (error, stdout, stderr) => {
            if (error)
                reject(new Error(stderr?.trim() || error.message));
            else
                resolve(stdout);
        });
    });
}
function forwardedPortFrom(output) {
    const port = Number(output.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
        throw new Error("adb did not name the port it forwarded.");
    return port;
}
/** The socket once the phone has sent a byte, paused with that byte still unread. */
function firstByte(port, starting) {
    return new Promise((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port });
        const giveUp = () => {
            socket.destroy();
            reject(starting.reason);
        };
        const settle = (connected) => {
            starting.removeEventListener("abort", giveUp);
            resolve(connected);
        };
        starting.addEventListener("abort", giveUp, { once: true });
        // Node emits "close" after every socket "error".
        socket.on("error", () => { });
        socket.once("close", () => settle(null));
        socket.once("data", (first) => {
            socket.pause();
            socket.unshift(first);
            settle(socket);
        });
    });
}
// adb accepts a connection to the forwarded port before the phone listens, then closes it without a byte.
async function connectVideo(port, starting) {
    for (;;) {
        starting.throwIfAborted();
        const socket = await firstByte(port, starting);
        if (socket)
            return socket;
        await delay(CONNECT_RETRY_MS, undefined, { signal: starting });
    }
}
/** One run of scrcpy-server on one phone. The serial reaches adb only as an argument. */
export async function openPhoneSession(deps, serial) {
    const adb = (...args) => runAdb(deps.adbPath, ["-s", serial, ...args]);
    const scid = randomInt(2 ** 31);
    // Android 9 compiles the jar into oat/<abi>/ beside it, so each session has a directory of its own to remove whole.
    // `adb push` creates it.
    const dir = deviceDir(scid);
    const jar = `${dir}/scrcpy-server.jar`;
    const starting = new AbortController();
    const reader = new VideoReader();
    const listeners = new Set();
    let forwardedPort;
    let server;
    let socket;
    let controlSocket;
    let serverStderr = "";
    let ending;
    let settleClosed;
    const closed = new Promise((resolve) => {
        settleClosed = resolve;
    });
    const end = (reason) => (ending ??= (async () => {
        socket?.destroy();
        controlSocket?.destroy();
        if (server)
            await killCliTree(server);
        if (forwardedPort !== undefined)
            await adb("forward", "--remove", `tcp:${forwardedPort}`).catch(() => { });
        const cleanupError = await adb("shell", "rm", "-rf", dir).then(() => "", (error) => error.message);
        settleClosed(reason === "server-exit" && DEVICE_GONE.test(serverStderr + cleanupError) ? "device-gone" : reason);
    })());
    const serverStopped = (cause) => {
        starting.abort(cause);
        void end("server-exit");
    };
    const deliver = (chunk) => {
        let packets;
        try {
            packets = reader.push(chunk);
        }
        catch {
            void end("protocol");
            return;
        }
        try {
            for (const packet of packets)
                for (const listener of listeners)
                    if (!ending)
                        listener(packet);
        }
        catch {
            void end("closed");
        }
    };
    try {
        await adb("push", deps.serverFile, jar);
        forwardedPort = forwardedPortFrom(await adb("forward", "tcp:0", deviceSocket(scid)));
        server = spawnCli(deps.adbPath, ["-s", serial, "shell", `CLASSPATH=${jar}`, "app_process", "/", "com.genymobile.scrcpy.Server", ...serverArgs(scid)], { stdio: ["ignore", "pipe", "pipe"] });
        server.once("error", serverStopped);
        server.once("exit", () => serverStopped(new Error("scrcpy stopped on the phone before the screen was open.")));
        server.stdout.resume();
        server.stderr.on("data", (chunk) => {
            serverStderr = (serverStderr + chunk.toString("utf8")).slice(-SERVER_STDERR_KEPT);
        });
        const limitMs = deps.startTimeoutMs ?? START_TIMEOUT_MS;
        const limit = setTimeout(() => starting.abort(new Error(`The phone sent no video within ${limitMs / 1000} seconds.`)), limitMs);
        try {
            socket = await connectVideo(forwardedPort, starting.signal);
        }
        finally {
            clearTimeout(limit);
        }
        socket.on("data", deliver);
        socket.once("close", () => void end("server-exit"));
        // scrcpy 5.0.1 accepts its control connection next, on the same port, without a byte to say so. Nothing it sends
        // there later is used.
        controlSocket = connect({ host: "127.0.0.1", port: forwardedPort });
        controlSocket.on("error", () => { });
        await once(controlSocket, "connect", { signal: starting.signal }).catch(() => {
            throw new Error("The control connection to the phone could not be opened.");
        });
        controlSocket.once("close", () => void end("server-exit"));
        controlSocket.resume();
        await adb("forward", "--remove", `tcp:${forwardedPort}`);
        forwardedPort = undefined;
    }
    catch (error) {
        const cause = starting.signal.aborted ? starting.signal.reason : error;
        await end("closed");
        throw new Error(`Could not open the phone's screen. ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    const video = socket;
    const control = controlSocket;
    return {
        onPacket(listener) {
            listeners.add(listener);
            if (video.isPaused())
                video.resume();
            return () => {
                listeners.delete(listener);
            };
        },
        send(message) {
            if (!ending)
                control.write(message);
        },
        closed,
        close: () => end("closed"),
    };
}
