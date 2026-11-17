import { fetchPublicPage } from "./wait-probes.js";
const SCHEME_SOURCE = /^[a-z][a-z0-9+.-]*:$/;
const HOST_SOURCE = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d+|\*))?(\/[^?#]*)?$/;
function headerItems(value) {
    return (value === undefined ? [] : [value].flat()).flatMap((item) => item.split(","));
}
/** An app on https may sit in a frame that only names http, as CSP lets a scheme upgrade. */
function schemeMatches(scheme, app) {
    return scheme === app.protocol || (scheme === "http:" && app.protocol === "https:");
}
function hostMatches(host, app) {
    if (host === "*")
        return true;
    if (host.startsWith("*."))
        return app.hostname.endsWith(host.slice(1));
    return app.hostname === host;
}
function sourceMatches(token, page, app) {
    const source = token.toLowerCase();
    if (source === "*")
        return true;
    if (source === "'self'")
        return app.origin === page.origin;
    if (source.startsWith("'"))
        return false;
    if (SCHEME_SOURCE.test(source))
        return schemeMatches(source, app);
    const parts = HOST_SOURCE.exec(source);
    if (!parts)
        return null;
    const [, scheme, host, port, path] = parts;
    if (!schemeMatches(scheme ? `${scheme}:` : page.protocol, app))
        return false;
    if (!hostMatches(host, app))
        return false;
    const defaultPort = app.protocol === "https:" ? "443" : "80";
    const appPort = app.port || defaultPort;
    if (port === "80" && appPort === "443")
        return null;
    if (port !== "*" && (port ?? defaultPort) !== appPort)
        return false;
    return path === undefined || path === "/" ? true : null;
}
function ancestorsAllow(sources, page, app) {
    let unsure = false;
    for (const source of sources) {
        const matches = sourceMatches(source, page, app);
        if (matches)
            return true;
        if (matches === null)
            unsure = true;
    }
    return unsure ? null : false;
}
/** The source list of each enforced policy's first frame-ancestors directive. */
function frameAncestorLists(value) {
    const lists = [];
    for (const policy of headerItems(value)) {
        const directive = policy.split(";").map((part) => part.trim().split(/\s+/)).find(([name]) => name.toLowerCase() === "frame-ancestors");
        if (directive)
            lists.push(directive.slice(1));
    }
    return lists;
}
function xFrameOptionsAllow(value, page, app) {
    const options = new Set(headerItems(value).map((item) => item.trim().toLowerCase()));
    if (options.size > 1)
        return !["deny", "allowall", "sameorigin"].some((option) => options.has(option));
    if (options.has("deny"))
        return false;
    return !options.has("sameorigin") || page.origin === app.origin;
}
export function framingOf(headers, pageUrl, appOrigin) {
    let page;
    let app;
    try {
        page = new URL(pageUrl);
        app = new URL(appOrigin);
    }
    catch {
        return "unknown";
    }
    const lists = frameAncestorLists(headers["content-security-policy"]);
    if (lists.length === 0)
        return xFrameOptionsAllow(headers["x-frame-options"], page, app) ? "allowed" : "blocked";
    let unsure = false;
    for (const sources of lists) {
        const allows = ancestorsAllow(sources, page, app);
        if (allows === false)
            return "blocked";
        if (allows === null)
            unsure = true;
    }
    return unsure ? "unknown" : "allowed";
}
/** Never from this computer or a private network. This request carries none of the person's cookies, so a redirect or
 * an error answer may be a sign-in page their browser never gets: those say unknown. */
export async function checkFraming(url, appOrigin, options = {}) {
    const page = await fetchPublicPage(url, { maxBytes: 1, maxRedirects: 0, timeoutMs: 8_000, ...options });
    return page.ok ? framingOf(page.headers, page.url.href, appOrigin) : "unknown";
}
