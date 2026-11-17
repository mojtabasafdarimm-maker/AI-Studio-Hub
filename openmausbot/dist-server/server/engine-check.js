import { engineFailureMessage } from "./drivers/engine-errors.js";
import { redactSecretsInText } from "./redact.js";
import { userError } from "./user-errors.js";
const PROMPT = "This is a connection check. Reply with the single word OK.";
const TIMEOUT_MS = 90_000;
const SIGNED_OUT = /not logged in|please run \/login|\blogin required\b|not signed in|sign in again|invalid api key|invalid_api_key|\b401\b|unauthori[sz]ed/i;
/** What a failed check says: the provider's own refusal in plain words, a sign-in to make again, or its own short text. */
export function engineCheckError(name, message) {
    if (SIGNED_OUT.test(message))
        return `${name} isn't signed in on this computer anymore. Sign in again, then check again.`;
    const plain = engineFailureMessage(name, message);
    if (plain)
        return plain;
    const said = redactSecretsInText(message.replace(/\s+/g, " ").trim()).slice(0, 300);
    return said ? `${name} couldn't answer: ${said}` : `${name} didn't answer. Check again in a minute.`;
}
const running = new Map();
/** `ok: null` for an engine without a one-off call to check with; one check per engine at a time. A check that outlasts
 * `timeoutMs` fails then, whatever the engine does, and tells the engine to stop. */
export function checkEngine(instance, options = {}) {
    // Codex and the ACP engines have only the background call: a fresh process with no tools, which is all a check needs.
    const call = instance.generateText ?? instance.generateMemoryText;
    if (!call)
        return Promise.resolve({ ok: null });
    const name = instance.displayName || instance.driverKind;
    const existing = running.get(instance.instanceId);
    if (existing)
        return existing;
    const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    const pending = new Promise((resolve) => {
        const stop = new AbortController();
        const timer = setTimeout(() => {
            stop.abort();
            resolve({ ok: false, ...userError("serverError.engineCheck.timeout", { name, seconds: String(Math.round(timeoutMs / 1000)) }) });
        }, timeoutMs);
        timer.unref?.();
        // Wrapped so a call that throws synchronously fails the check too.
        new Promise((answer) => answer(call.call(instance, PROMPT, { timeoutMs, signal: stop.signal })))
            .then((answer) => answer.trim() ? { ok: true } : { ok: false, error: `${name} answered with nothing. Check again in a minute.` }, (error) => ({ ok: false, error: engineCheckError(name, error instanceof Error ? error.message : String(error)) }))
            .then((result) => {
            clearTimeout(timer);
            resolve(result);
        });
    }).finally(() => running.delete(instance.instanceId));
    running.set(instance.instanceId, pending);
    return pending;
}
