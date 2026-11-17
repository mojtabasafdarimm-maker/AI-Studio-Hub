// The Docker CLI is the only local piece of the VPS backend — every command is `docker -H ssh://<alias>` and
// the daemon stays on the server — so a missing client is the one VPS problem a person fixes in a terminal.
// These are the sentences the bot panel and Settings show while that is the case.
const DOCKER_CLI_INSTALL = {
    darwin: "brew install docker",
    win32: "winget install -e --id Docker.DockerCLI",
    linux: "sudo apt install docker-ce-cli",
};
export function dockerCliInstallCommand(platform = process.platform) {
    return DOCKER_CLI_INSTALL[platform] ?? null;
}
/** spawn reports ENOENT for an absent `docker`; every other transport failure keeps its own message. */
export function dockerCliMissing(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /\bENOENT\b/.test(message) && /docker/i.test(message);
}
export function dockerCliMissingProblem() {
    const command = dockerCliInstallCommand();
    return command
        ? `The Docker CLI is not on PATH. Install the client only: ${command}`
        : "The Docker CLI is not on PATH. Install the Docker client, then retry.";
}
/** Lifecycle errors surface the spawn failure raw, so it carries the hint too. */
export function dockerCliStartMessage(error) {
    return `Docker-over-SSH could not start: ${error.message}${dockerCliMissing(error) ? `. ${dockerCliMissingProblem()}` : ""}`;
}
export function vpsStartsForTurn(input) {
    if (input.wants === "cloud")
        return true;
    if (input.wants !== undefined)
        return false;
    return input.autoStartVps === true || Boolean(input.automationSource);
}
export function vpsUnavailableHint(input) {
    if (input.automationSource)
        return "This scheduled run tried to start the VPS computer and could not reach it. Check the VPS connection in Settings → AI → Other services.";
    if (input.autoStartVps || input.reachable === false)
        return "Check the VPS connection in Settings → AI → Other services.";
    return input.reachable ? "Open Computer and enable Start VPS automatically, or choose Cloud computer to start it manually." : "";
}
