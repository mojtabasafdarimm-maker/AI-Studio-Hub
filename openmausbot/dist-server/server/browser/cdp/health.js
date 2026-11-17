// What a page reports without the Runtime domain: failed requests, the Log
// domain (network, CORS, private-network blocks, interventions) and human-check
// frames. Chrome 153 does not deliver a main-world ErrorEvent or
// PromiseRejectionEvent to isolated-world listeners (measured), and console
// output needs Runtime, so uncaught errors and console lines are not seen.
import { siteOf } from "../../../shared/site.js";
export const HEALTH_BUFFER_LIMIT = 200;
const REQUESTS_REMEMBERED = 2_000;
const REPORTED_TYPES = new Set(["Document", "XHR", "Fetch", "Script"]);
/** Origin and path only: queries carry tokens. */
export function reportableUrl(raw) {
    try {
        const url = new URL(raw);
        if (url.protocol === "data:" || url.protocol === "blob:")
            return `${url.protocol}…`;
        return `${url.origin}${url.pathname}`.slice(0, 300);
    }
    catch {
        return raw.slice(0, 120);
    }
}
function hostOf(raw) {
    try {
        return new URL(raw).hostname || null;
    }
    catch {
        return null;
    }
}
export function humanChecksIn(frames) {
    const found = [];
    for (const frame of frames) {
        const host = hostOf(frame.url) ?? "";
        let kind = null;
        if (host === "challenges.cloudflare.com")
            kind = "Cloudflare Turnstile";
        else if (frame.parentId === null && /\/cdn-cgi\/challenge-platform\//.test(frame.url))
            kind = "Cloudflare challenge";
        else if ((host === "www.google.com" || host === "www.recaptcha.net") && /\/recaptcha\//.test(frame.url))
            kind = "reCAPTCHA";
        else if (host === "hcaptcha.com" || host.endsWith(".hcaptcha.com"))
            kind = "hCaptcha";
        if (kind && !found.some((check) => check.kind === kind))
            found.push({ kind, frameUrl: reportableUrl(frame.url) });
    }
    return found;
}
class Bounded {
    items = [];
    dropped = 0;
    push(item) {
        this.items.push(item);
        if (this.items.length > HEALTH_BUFFER_LIMIT) {
            this.items.shift();
            this.dropped++;
        }
    }
    take() {
        const taken = { items: this.items.splice(0), dropped: this.dropped };
        this.dropped = 0;
        return taken;
    }
}
/** One tab's health signals since they were last taken. */
export class PageHealth {
    #requests = new Map();
    #failed = new Bounded();
    #log = new Bounded();
    #pageUrl;
    constructor(pageUrl) {
        this.#pageUrl = pageUrl;
    }
    watch(session) {
        const offs = [
            session.on("Network.requestWillBeSent", (params) => this.#sent(params)),
            session.on("Network.responseReceived", (params) => this.#response(params)),
            session.on("Network.loadingFailed", (params) => this.#failedLoad(params)),
            session.on("Network.loadingFinished", (params) => this.#requests.delete(String(params.requestId))),
            session.on("Log.entryAdded", (params) => this.#entry(params)),
        ];
        return () => {
            for (const off of offs)
                off();
        };
    }
    take(frames) {
        const failed = this.#failed.take();
        const log = this.#log.take();
        return { failedRequests: failed.items, log: log.items, humanChecks: humanChecksIn(frames), dropped: { failedRequests: failed.dropped, log: log.dropped } };
    }
    #firstParty(url) {
        const host = hostOf(url);
        const page = hostOf(this.#pageUrl());
        return host !== null && page !== null && siteOf(host) === siteOf(page);
    }
    #sent(params) {
        const request = params.request;
        if (this.#requests.size >= REQUESTS_REMEMBERED)
            this.#requests.delete(this.#requests.keys().next().value);
        this.#requests.set(String(params.requestId), { url: String(request?.url ?? ""), method: String(request?.method ?? "GET") });
    }
    #response(params) {
        const response = params.response;
        const type = String(params.type ?? "Other");
        const status = Number(response?.status);
        if (!REPORTED_TYPES.has(type) || !(status >= 400))
            return;
        const url = String(response?.url ?? "");
        const method = this.#requests.get(String(params.requestId))?.method ?? "GET";
        this.#failed.push({ url: reportableUrl(url), method, resourceType: type, status, firstParty: this.#firstParty(url) });
    }
    #failedLoad(params) {
        const id = String(params.requestId);
        const request = this.#requests.get(id);
        this.#requests.delete(id);
        const type = String(params.type ?? "Other");
        if (params.canceled === true || !REPORTED_TYPES.has(type) || !request)
            return;
        const cors = params.corsErrorStatus;
        this.#failed.push({
            url: reportableUrl(request.url),
            method: request.method,
            resourceType: type,
            status: null,
            errorText: String(params.errorText ?? "").slice(0, 200),
            ...(typeof params.blockedReason === "string" ? { blockedReason: params.blockedReason } : cors?.corsError ? { blockedReason: `cors:${cors.corsError}` } : {}),
            firstParty: this.#firstParty(request.url),
        });
    }
    #entry(params) {
        const entry = params.entry;
        if (!entry || (entry.level !== "error" && entry.level !== "warning"))
            return;
        this.#log.push({
            source: String(entry.source ?? "other"),
            level: entry.level,
            text: String(entry.text ?? "").slice(0, 500),
            ...(entry.url ? { url: reportableUrl(entry.url) } : {}),
        });
    }
}
