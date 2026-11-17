import { DriverError } from "./errors.js";
/** Unanswered, a challenge is cancelled, so the page shows the site's own refusal instead of loading forever. */
export const AUTH_WAIT_MS = 5 * 60_000;
/** Fetch.enable pauses each document request here; every one goes on at once, unchanged. */
export const AUTH_PATTERNS = [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }];
/**
 * A tab's HTTP basic or digest authentication challenge. A headless browser has no dialog to show it in, so it waits
 * here for a person or a saved login to answer; a proxy's challenge is never answered.
 */
export class AuthChallenges {
    /** Whether someone could answer a challenge now; when not, it is cancelled at once and the site's refusal shows. */
    answerable = () => true;
    #listeners = new Set();
    #pending = null;
    get pending() {
        return this.#pending?.challenge ?? null;
    }
    watch(session) {
        const clear = () => {
            if (this.#pending?.session !== session)
                return;
            clearTimeout(this.#pending.timer);
            this.#pending = null;
            this.#emit(null);
        };
        const offs = [
            session.on("Fetch.requestPaused", (params) => {
                void session.send("Fetch.continueRequest", { requestId: params.requestId }).catch(() => { });
            }),
            session.on("Fetch.authRequired", (params) => this.#required(session, params)),
            session.onDetach(clear),
        ];
        return () => {
            for (const off of offs)
                off();
            clear();
        };
    }
    onChange(listener) {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
    /** Credentials for the open challenge, or null to cancel it. */
    async answer(credentials) {
        const pending = this.#pending;
        if (!pending)
            throw new DriverError("refused", "No sign-in prompt is open on this tab.");
        this.#pending = null;
        clearTimeout(pending.timer);
        const response = credentials
            ? { response: "ProvideCredentials", username: credentials.username, password: credentials.password }
            : { response: "CancelAuth" };
        this.#emit(null);
        await pending.session.send("Fetch.continueWithAuth", { requestId: pending.challenge.id, authChallengeResponse: response });
        return pending.challenge;
    }
    #required(session, params) {
        const challenge = params.authChallenge;
        if (challenge?.source === "Proxy" || !this.answerable()) {
            void session.send("Fetch.continueWithAuth", { requestId: params.requestId, authChallengeResponse: { response: "CancelAuth" } }).catch(() => { });
            return;
        }
        if (this.#pending)
            void this.answer(null).catch(() => { });
        const next = {
            id: String(params.requestId),
            origin: String(challenge?.origin ?? "").slice(0, 300),
            realm: String(challenge?.realm ?? "").slice(0, 300),
            scheme: String(challenge?.scheme ?? "basic").toLowerCase().slice(0, 40),
            since: Date.now(),
        };
        const timer = setTimeout(() => {
            if (this.#pending?.challenge === next)
                void this.answer(null).catch(() => { });
        }, AUTH_WAIT_MS);
        timer.unref?.();
        this.#pending = { challenge: next, session, timer };
        this.#emit(next);
    }
    #emit(challenge) {
        for (const listener of this.#listeners) {
            try {
                listener(challenge);
            }
            catch { }
        }
    }
}
