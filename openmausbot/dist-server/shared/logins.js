/**
 * Saved logins: a website username and password (and optionally its 2FA key)
 * a bot signs in with but never receives: it calls fill_login and the server
 * fills the fields itself. Clients see a saved login as a list row, never its
 * secrets.
 */
import { getDomain } from "tldts";
/** The longest username or password a form takes. */
export const LOGIN_FIELD_MAX = 512;
/** The most sign-in hosts one login keeps. */
export const LOGIN_HOSTS_MAX = 20;
function isLoopbackHost(host) {
    return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
}
/** A host as pages report it: lower case, without the root's trailing dot. */
export function plainHost(host) {
    return host.toLowerCase().replace(/\.$/u, "");
}
/** The site a host belongs to. Loopback names, IP addresses and hosts that
 * are themselves a public suffix are their own site. */
export function loginSite(host) {
    const name = plainHost(host);
    return getDomain(name, { allowPrivateDomains: true }) ?? name;
}
/** A login's host from what the person typed: a page address or a bare
 * domain. Anything that is not a plain http(s) address is refused. */
export function normalizeLoginHost(raw) {
    if (typeof raw !== "string")
        return null;
    const text = raw.trim();
    // eslint-disable-next-line no-control-regex -- Reject control characters and spaces before URL parsing normalizes them.
    if (!text || text.length > 2048 || /[\u0000- \u007f\\]/u.test(text))
        return null;
    let url;
    try {
        url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`);
    }
    catch {
        return null;
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password)
        return null;
    const host = plainHost(url.hostname);
    if (!host.includes(".") && host !== "localhost" && !host.startsWith("["))
        return null;
    return host;
}
/** Where a new login may be filled: the site of the address it was saved
 * for, and the hosts its sign-in page was seen on (that address's own host
 * when none was). */
export function loginPlace(host, signInHosts = [], exactHost = false) {
    const hosts = [...new Set(signInHosts.length ? signInHosts : [host])].slice(0, LOGIN_HOSTS_MAX);
    return { site: loginSite(host), hosts, exactHost };
}
/** Whether a login may be filled on a page whose host is `pageHost`: one of
 * its sign-in hosts, or (unless it is kept to those) any host of its site. */
export function loginMatchesHost(login, pageHost) {
    const host = plainHost(pageHost);
    return login.hosts.includes(host) || (!login.exactHost && loginSite(host) === login.site);
}
/** Whether `pageUrl` is a page any login may be filled on: https, or plain
 * http on this computer, for a developer's own app. A reason when not. */
export function loginPageCheck(pageUrl) {
    let url;
    try {
        url = new URL(pageUrl);
    }
    catch {
        return { ok: false, pageHost: null, reason: "address" };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
        return { ok: false, pageHost: null, reason: "address" };
    const pageHost = plainHost(url.hostname);
    if (url.protocol === "http:" && !isLoopbackHost(pageHost))
        return { ok: false, pageHost, reason: "insecure" };
    return { ok: true, pageHost };
}
/** Whether `login` may be filled on the page at `pageUrl`: a page any login
 * may be filled on, at a host the login matches. */
export function loginOriginCheck(pageUrl, login) {
    const page = loginPageCheck(pageUrl);
    if (!page.ok)
        return page;
    return loginMatchesHost(login, page.pageHost) ? page : { ok: false, pageHost: page.pageHost, reason: "host" };
}
/** The other bots that use this bot's named browser profile, and so share what it is signed in to. A guest browser is
 * the bot's own temporary one (server/host/browser.ts sessionFor), so it has none. */
export function browserMatesOf(bots, botId) {
    const profile = bots.find((bot) => bot.id === botId)?.browserProfile;
    return profile && profile !== "guest" ? bots.filter((bot) => bot.id !== botId && bot.browserProfile === profile).map((bot) => bot.id) : [];
}
/** The bots a login is kept to that it is still not filled for, because they share a browser with a bot it isn't kept to. */
export function loginHeldBackFor(login, bots) {
    const kept = login.bots;
    if (kept === "all")
        return [];
    return kept.filter((id) => browserMatesOf(bots, id).some((mate) => !kept.includes(mate)));
}
/** Whether a bot may use a login; given several (bots that sign in through one browser), whether every one of them may. */
export function loginUsableBy(login, botIds) {
    const bots = login.bots;
    return bots === "all" || (typeof botIds === "string" ? [botIds] : botIds).every((id) => bots.includes(id));
}
/** A login as a bot hears of it: its site, or its hosts when it is kept to
 * them, and the username. */
export function loginLabel(login) {
    const where = login.exactHost ? login.hosts.join(" or ") : login.site;
    return login.username ? `${where} (${login.username})` : where;
}
/** The resume line after the person saved a login from a sign-in card. */
export function savedLoginResumePrompt(site) {
    return `OpenMausBot sign-in update: the person saved a login for ${site}. Open its login page in your browser and call fill_login there: it fills the form and submits it. Then check you are signed in. You never see the password. Never ask for a password or a one-time code in chat.`;
}
