/** How this CLI was started, so every command it prints can be pasted as is: `npx openmausbot`, `pnpm omb` in a
 * checkout, the Docker image's `docker compose exec omb openmausbot` (OMB_CLI_PREFIX), or plain `openmausbot`. */
export function cliPrefix(env = process.env, script = process.argv[1] ?? "") {
    const fixed = env.OMB_CLI_PREFIX?.trim();
    if (fixed)
        return fixed;
    if (env.npm_lifecycle_event === "omb")
        return "pnpm omb";
    // npm 7+ runs an `npx` package from its cache's `_npx` folder (npm_command=exec alone also marks `npx vitest`).
    if (/[\\/]_npx[\\/]/.test(script))
        return "npx openmausbot";
    return "openmausbot";
}
/** `openmausbot <rest>` the way this CLI was started. */
export function cliCommand(rest, env, script) {
    return `${cliPrefix(env, script)} ${rest}`;
}
