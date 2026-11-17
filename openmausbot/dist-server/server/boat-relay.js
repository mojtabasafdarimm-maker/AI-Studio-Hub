const LEGACY_RELAY_BASE = /\/api\/box\/v1$/;
const legacyRelay = (account) => account?.included === true && LEGACY_RELAY_BASE.test(account.api);
/** A v1 path as the legacy relay routes it: /sandboxes… becomes /boxes…. */
export function relayPath(account, path) {
    return legacyRelay(account) ? path.replace(/^\/sandboxes(?=[/?]|$)/, "/boxes") : path;
}
/** box becomes sandbox, boxes sandboxes, and a deletion operation's kind box sandbox; every other field is already the same. */
export function relayBody(account, body) {
    if (!legacyRelay(account) || !body || typeof body !== "object" || Array.isArray(body))
        return body;
    const { box, boxes, ...rest } = body;
    return {
        ...rest,
        ...(box !== undefined ? { sandbox: box } : {}),
        ...(boxes !== undefined ? { sandboxes: boxes } : {}),
        ...(rest.operation?.kind === "box" ? { operation: { ...rest.operation, kind: "sandbox" } } : {}),
    };
}
