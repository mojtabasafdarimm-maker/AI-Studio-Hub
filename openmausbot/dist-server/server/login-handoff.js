import { loginFingerprints, VERIFY_NONCE } from "./cloud-send-verify.js";
import { ONE_PASSWORD_MALFORMED, ONE_PASSWORD_REFUSED } from "./onepassword.js";
export const LOGIN_HANDOFF_REQUEST = "openmausbot:login-handoff";
export const LOGIN_HANDOFF_RESULT = "openmausbot:login-handoff-result";
const REQUEST_ID = /^[\w-]{8,64}$/u;
const LOGIN_ID = /^[\w-]{1,128}$/u;
const CONNECTION_ID = /^(?:mcp:[a-z][a-z0-9_-]{0,31}|key:\w{1,40}|composio|email)$/u;
const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
export function totpAddress(key) {
    const query = new URLSearchParams({ secret: key.secret, algorithm: key.algorithm, digits: String(key.digits), period: String(key.period) });
    return `otpauth://totp/OpenMausBot?${query}`;
}
function parse(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return null;
    const message = raw;
    if (message.type !== LOGIN_HANDOFF_REQUEST || typeof message.requestId !== "string" || !REQUEST_ID.test(message.requestId))
        return null;
    const what = message.what;
    if (what?.kind === "1password")
        return { requestId: message.requestId, what: { kind: "1password" } };
    if (what?.kind === "login" && typeof what.id === "string" && LOGIN_ID.test(what.id))
        return { requestId: message.requestId, what: { kind: "login", id: what.id } };
    if (what?.kind === "secret" && typeof what.id === "string" && LOGIN_ID.test(what.id))
        return { requestId: message.requestId, what: { kind: "secret", id: what.id } };
    if (what?.kind === "connection" && typeof what.id === "string" && CONNECTION_ID.test(what.id))
        return { requestId: message.requestId, what: { kind: "connection", id: what.id } };
    if (what?.kind === "composio-share" && typeof what.for === "string" && INSTALLATION_ID.test(what.for))
        return { requestId: message.requestId, what: { kind: "composio-share", for: what.for } };
    if (what?.kind === "connection-release" && typeof what.id === "string" && CONNECTION_ID.test(what.id) && typeof what.digest === "string" && DIGEST.test(what.digest)) {
        return { requestId: message.requestId, what: { kind: "connection-release", id: what.id, digest: what.digest } };
    }
    if (what?.kind === "verify-secrets" && typeof what.nonce === "string" && VERIFY_NONCE.test(what.nonce))
        return { requestId: message.requestId, what: { kind: "verify-secrets", nonce: what.nonce } };
    return null;
}
export const ONE_PASSWORD_DEAD_HERE = "1Password did not accept this computer's token, so it was not sent to My Cloud. Connect 1Password again in Settings → Vault with a new service account token, and it goes to My Cloud by itself.";
export function answerLoginHandoff(store, what, onePasswordProblem = () => undefined) {
    if (what.kind === "1password") {
        const token = store.onePasswordToken();
        if (!token)
            return { ok: false, error: "1Password is not connected on this computer." };
        // 1Password itself refused this token here: My Cloud would only refuse it too, in words meant for its own page.
        const problem = onePasswordProblem();
        if (problem === ONE_PASSWORD_REFUSED || problem === ONE_PASSWORD_MALFORMED)
            return { ok: false, error: ONE_PASSWORD_DEAD_HERE };
        return { ok: true, onePassword: { token, grants: store.onePasswordGrants(), itemGrants: store.onePasswordItemGrants() } };
    }
    if (what.kind === "secret") {
        const secret = store.secret(what.id);
        if (!secret || secret.person)
            return { ok: false, error: "This secret is no longer saved on this computer." };
        return { ok: true, secret: { id: secret.id, name: secret.name, value: secret.value, bots: secret.bots, source: secret.source, ...(secret.refOnly ? { refOnly: true } : {}) } };
    }
    const login = store.get(what.id);
    if (!login)
        return { ok: false, error: "This login is no longer saved on this computer." };
    return { ok: true, login: { site: login.hosts[0] ?? login.site, exactHost: login.exactHost, username: login.username, password: login.password,
            totp: login.totp ? totpAddress(login.totp) : null, bots: login.bots } };
}
/** True when the message was a handoff ask, answered or refused; anything else is left for the next handler. A
 * connection's ask is answered by `connections`, once its answer is ready. */
export function receiveLoginHandoff(raw, store, post, onePasswordProblem, connections) {
    if (raw?.type !== LOGIN_HANDOFF_REQUEST)
        return false;
    const ask = parse(raw);
    if (!ask)
        return true;
    const { requestId, what } = ask;
    if (what.kind === "connection" || what.kind === "composio-share" || what.kind === "connection-release") {
        const refused = { ok: false, error: "This connection could not be read on this computer." };
        const answer = connections ? connections(what).catch(() => refused) : Promise.resolve(refused);
        void answer.then((answered) => post({ type: LOGIN_HANDOFF_RESULT, requestId, ...answered }));
        return true;
    }
    if (what.kind === "verify-secrets") {
        const logins = loginFingerprints(what.nonce, store);
        const theirs = connections ? connections({ kind: "connection-fingerprints", nonce: what.nonce }).catch(() => null) : Promise.resolve(null);
        void theirs.then((answered) => post(answered?.ok && "secrets" in answered ? { type: LOGIN_HANDOFF_RESULT, requestId, ok: true, secrets: { ...logins, ...answered.secrets } }
            : { type: LOGIN_HANDOFF_RESULT, requestId, ok: false, error: "This computer's apps and keys could not be checked." }));
        return true;
    }
    post({ type: LOGIN_HANDOFF_RESULT, requestId, ...answerLoginHandoff(store, what, onePasswordProblem) });
    return true;
}
