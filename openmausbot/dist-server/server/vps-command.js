import { DATA_DIR } from "./config.js";
import { augmentedPath } from "./env-path.js";
import { killCliTree, spawnCli } from "./procs.js";
import { ensureVpsSshMaster, prepareVpsSsh } from "./vps-ssh.js";
import { dockerCliStartMessage } from "./vps-hints.js";
// ssh + docker need this long to tear down a remote exec over a WAN; an orphaned exec keeps the driver socket busy.
const COMMAND_TIMEOUT_TERM_GRACE_MS = 5_000;
// killCliTree also waits up to one second for the forced group exit.
export const COMMAND_TIMEOUT_KILL_GRACE_MS = COMMAND_TIMEOUT_TERM_GRACE_MS + 1_000;
const STREAM_CAP_CHARS = 16 * 1024 * 1024;
function tailCollector() {
    const chunks = [];
    let total = 0;
    return {
        push(chunk) {
            chunks.push(chunk);
            total += chunk.length;
            for (;;) {
                const first = chunks[0];
                if (chunks.length < 2 || first === undefined || total - first.length < STREAM_CAP_CHARS)
                    break;
                chunks.shift();
                total -= first.length;
            }
        },
        text() {
            return chunks.join("").slice(-STREAM_CAP_CHARS);
        },
    };
}
export async function defaultRunner(args, options = {}) {
    const ssh = prepareVpsSsh(DATA_DIR, augmentedPath());
    let deadline = Date.now() + (options.timeoutMs ?? 120_000);
    const destination = args[0] === "-H" && args[1]?.startsWith("ssh://") ? args[1].slice(6) : null;
    // Time spent waking a paused host does not count against the command's own timeout.
    if (destination)
        deadline += await ensureVpsSshMaster(ssh, destination, Math.min(30_000, deadline - Date.now()));
    if (Date.now() >= deadline)
        throw new Error("Docker-over-SSH command timed out");
    return new Promise((resolve, reject) => {
        // Docker's SSH transport runs the first `ssh` on PATH: the app's shim, which shares one connection.
        const child = spawnCli("docker", args, {
            shell: false,
            env: { ...process.env, PATH: ssh.path },
            stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout = tailCollector();
        const stderr = tailCollector();
        let settled = false;
        let failure = null;
        let timeout;
        const settle = (finish) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            finish();
        };
        const fail = (error) => {
            if (settled || failure)
                return;
            failure = error;
            clearTimeout(timeout);
            // ssh can hold these pipes after Docker exits; stop only this command's process group (SSH masters detach from it).
            const cleaned = () => {
                child.stdin.destroy();
                child.stdout.destroy();
                child.stderr.destroy();
                settle(() => reject(error));
            };
            void killCliTree(child, COMMAND_TIMEOUT_TERM_GRACE_MS).then(cleaned, cleaned);
        };
        timeout = setTimeout(() => fail(new Error("Docker-over-SSH command timed out")), Math.max(1, deadline - Date.now()));
        timeout.unref?.();
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout.push(chunk);
        });
        child.stderr.on("data", (chunk) => {
            stderr.push(chunk);
        });
        child.stdin.on("error", (error) => {
            fail(new Error(`Docker-over-SSH stdin failed: ${error.message}`));
        });
        child.on("error", (error) => {
            fail(new Error(dockerCliStartMessage(error)));
        });
        child.on("close", (code, signal) => {
            if (failure)
                return;
            settle(() => {
                if (code === 0)
                    return resolve({ stdout: stdout.text(), stderr: stderr.text() });
                const detail = stderr.text().trim().slice(-1000);
                reject(new Error(detail || `Docker-over-SSH exited ${code ?? signal ?? "without a status"}`));
            });
        });
        try {
            child.stdin.end(options.input);
        }
        catch (error) {
            fail(new Error(`Docker-over-SSH stdin failed: ${error instanceof Error ? error.message : String(error)}`));
        }
    });
}
