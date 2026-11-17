// Imports nothing but node:fs, so the server reads its secrets before anything it loads can start a process.
import { closeSync, readFileSync } from "node:fs";
/** Never in a child's environment (/proc/<pid>/environ stays readable by the same user): the launcher hands them to the
 * server over an inherited pipe named by CLOUD_SECRETS_FD_ENV. */
export const CLOUD_HOME_SECRET_KEYS = ["OMB_CLOUD_BOOTSTRAP_SECRET", "OMB_CLOUD_BOAT_TOKEN", "OMB_CLOUD_VOICE_TOKEN", "OMB_CLOUD_DECIDER_TOKEN", "OMB_CLOUD_AI_TOKEN", "OMB_CLOUD_CONNECTED_APPS_GRANT", "OMB_CLOUD_X_TOKEN", "OMB_CLOUD_HOSTING_TOKEN"];
export const CLOUD_SECRETS_FD_ENV = "OMB_CLOUD_SECRETS_FD";
export function cloudHomeSecrets(env) {
    return Object.fromEntries(CLOUD_HOME_SECRET_KEYS.flatMap((key) => env[key] ? [[key, env[key]]] : []));
}
export function withoutCloudSecrets(env) {
    const kept = { ...env };
    for (const key of CLOUD_HOME_SECRET_KEYS)
        delete kept[key];
    return kept;
}
function invalid(why) {
    throw new Error(`Cloud home configuration is invalid: ${why}.`);
}
/** Read to the end and closed, so no child inherits the pipe; only the known secret names are taken. */
export function takeCloudSecrets(env = process.env) {
    const named = env[CLOUD_SECRETS_FD_ENV];
    if (named === undefined)
        return {};
    delete env[CLOUD_SECRETS_FD_ENV];
    const fd = Number(named);
    if (!Number.isInteger(fd) || fd < 3 || fd > 1024)
        invalid(`${CLOUD_SECRETS_FD_ENV} must name an inherited descriptor`);
    let raw;
    try {
        raw = readFileSync(fd, "utf8");
    }
    catch {
        invalid("the Cloud home's secrets could not be read from the launcher");
    }
    finally {
        try {
            closeSync(fd);
        }
        catch { }
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        parsed = null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        invalid("the Cloud home's secrets from the launcher are not readable");
    const record = parsed;
    return Object.fromEntries(CLOUD_HOME_SECRET_KEYS.flatMap((key) => typeof record[key] === "string" && record[key] ? [[key, record[key]]] : []));
}
