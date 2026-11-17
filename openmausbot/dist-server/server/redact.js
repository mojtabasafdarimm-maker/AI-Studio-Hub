// Native protocol logs keep the shape of credentials, never their values: they get pasted into issues.
const SECRET_KEY_PARTS = ["token", "secret", "password", "passwd", "apikey", "api_key", "authorization", "auth_token"];
export function isSecretName(name) {
    const lower = name.toLowerCase();
    if (lower === "omb_gate_upstream" || lower === "omb_remote_mcp_server" || lower.startsWith("omb_remote_mcp_config_"))
        return true;
    if (SECRET_KEY_PARTS.some((part) => lower.includes(part)))
        return true;
    return /(^|[_.-])keys?$/.test(lower);
}
import { mask, redactSecretsInText } from "../shared/redact.js";
export { addHeldSecretScrubber, HELD_SECRET_MASK, mask, redactParams, redactSecretsInText, scrubHeldSecrets } from "../shared/redact.js";
export function redactSecrets(input, depth = 0) {
    if (typeof input === "string")
        return redactSecretsInText(input);
    if (depth > 12 || input === null || typeof input !== "object")
        return input;
    if (Array.isArray(input)) {
        return input.map((item) => {
            if (item !== null &&
                typeof item === "object" &&
                !Array.isArray(item) &&
                typeof item.name === "string" &&
                typeof item.value === "string") {
                const entry = item;
                // A non-secret name does not clear the value: it still gets the content pass.
                return isSecretName(entry.name)
                    ? { ...entry, value: mask(entry.value) }
                    : { ...entry, value: redactSecretsInText(entry.value) };
            }
            return redactSecrets(item, depth + 1);
        });
    }
    const out = {};
    for (const [key, value] of Object.entries(input)) {
        if (typeof value === "string" && isSecretName(key)) {
            out[key] = mask(value);
            continue;
        }
        out[key] = redactSecrets(value, depth + 1);
    }
    return out;
}
