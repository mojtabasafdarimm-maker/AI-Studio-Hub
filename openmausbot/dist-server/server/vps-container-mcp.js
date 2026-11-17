// Stdio bridge to the Cua MCP server in a VPS container; auth is the user's SSH config and agent, and nothing is stored here.
import { runMcpBridge } from "./mcp-bridge.js";
import { vpsContainerMcpArgs, vpsDockerArgs } from "./vps-computer.js";
import { DATA_DIR } from "./config.js";
import { augmentedPath } from "./env-path.js";
import { ensureVpsSshMaster, prepareVpsSsh } from "./vps-ssh.js";
const [alias, containerName] = process.argv.slice(2);
const sshAlias = alias ?? "";
let args;
try {
    args = vpsContainerMcpArgs(sshAlias, containerName ?? "");
}
catch {
    process.stderr.write("invalid VPS MCP connection\n");
    process.exit(2);
}
// The driving pair rides in env, not argv: argv is world-readable through `ps`.
const controlUrl = process.env.OMB_CONTROL_URL ?? "";
const controlToken = process.env.OMB_CONTROL_TOKEN ?? "";
const ssh = prepareVpsSsh(DATA_DIR, augmentedPath());
try {
    await ensureVpsSshMaster(ssh, sshAlias);
}
catch (error) {
    process.stderr.write(`VPS SSH initialization failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
}
runMcpBridge({
    command: "docker",
    args,
    env: { ...process.env, PATH: ssh.path },
    label: "VPS Cua Driver",
    // Probe the transport, not the driver: a busy desktop mid-tool-call must never look dead.
    liveness: { command: "docker", args: vpsDockerArgs(sshAlias, ["version", "--format", "{{.Server.Version}}"]) },
    ...(controlUrl && controlToken ? { gate: { url: controlUrl, token: controlToken } } : {}),
});
