// Ported from upstream's provider contracts with Promises for Effect and listeners for Stream; shapes and names are kept.
export class ProviderError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.name = "ProviderError";
        this.code = code;
    }
}
/** The attempt never reached a prompt or client-side action and its process stopped, so the harness may recover it. */
export class TurnNotStartedError extends Error {
    turnId;
    constructor(turnId, message) {
        super(message);
        this.name = "TurnNotStartedError";
        this.turnId = turnId;
    }
}
/** The CLI refused sign-in before any model or tool activity, and its process stopped. `known`: refused here because the
 * engine is already known to be signed out, so it is no new refusal. */
export class TurnAuthenticationRefusedError extends TurnNotStartedError {
    name = "TurnAuthenticationRefusedError";
    known;
    constructor(turnId, message, known = false) {
        super(turnId, message);
        this.known = known;
    }
}
/** The engine's usage limit refused the turn before any model or tool activity (or is known to be refusing until
 * `resetsAt`), and no process of it is running the turn. `scope`: the limit is the account's on that engine, or one
 * model's own window ("model") or extra usage credits ("credits"), which leave the engine's other models working.
 * `known`: refused here by a limit already noted, so it is no new refusal. */
export class TurnUsageLimitRefusedError extends TurnNotStartedError {
    name = "TurnUsageLimitRefusedError";
    resetsAt;
    scope;
    known;
    constructor(turnId, message, resetsAt, scope = "engine", known = false) {
        super(turnId, message);
        this.resetsAt = resetsAt;
        this.scope = scope;
        this.known = known;
    }
}
/** Variants are opaque provider IDs, not the cross-engine effort enum. */
export function isModelVariant(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 256 &&
        value.trim() === value && !/\p{Cc}/u.test(value);
}
/** What a client may see of an install descriptor: the standalone pins (URLs, hashes) stay on the server. */
export function clientInstall(install) {
    if (!install)
        return undefined;
    const { standalone: _pins, ...shown } = install;
    return shown;
}
/** "gpt-5.4-mini" → "Gpt 5.4 Mini", splitting on the caller's word breaks. */
export function titleCaseModelId(id, wordBreaks) {
    return id
        .split(wordBreaks)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}
/** A picker label with a second facet (display name, provider host) unless the id already says it. */
export function qualifiedModelLabel(id, qualifier, options = {}) {
    const { redundantWhen = () => false, decorate = (facet) => ` — ${facet}` } = options;
    if (!qualifier || redundantWhen(id, qualifier))
        return id;
    return `${id}${decorate(qualifier)}`;
}
let eventCounter = 0;
export const newEventId = () => `ev-${Date.now().toString(36)}-${(eventCounter++).toString(36)}`;
export const newId = () => crypto.randomUUID();
