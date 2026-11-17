/** Reddit's names. Each one covers its subdomains too: www, old, new, np, i, m, oauth, i.redd.it, v.redd.it… */
export const REDDIT_HOSTS = ["reddit.com", "redd.it", "redditmedia.com", "redditstatic.com", "reddit.app.link"];
/** What a bot reads instead of a Reddit page. */
export const REDDIT_REFUSAL = "Reddit blocks bots that browse from cloud computers and can ban the person's account, so this browser doesn't open Reddit. Use the Reddit connected app if it's connected, or ask the person to do this on their own computer.";
/** Whether `name`, as a URL or a SOCKS request carries it, is one of Reddit's names or under one. */
export function isRedditHost(name) {
    const host = name.trim().toLowerCase().replace(/\.+$/u, "");
    return REDDIT_HOSTS.some((site) => host === site || host.endsWith(`.${site}`));
}
/** Whether an address a bot passed opens Reddit. A bare host means https, as the browser tools read it. */
export function isRedditAddress(raw) {
    const text = raw.trim();
    try {
        return isRedditHost(new URL(/^[a-z][a-z\d+.-]*:\/\//iu.test(text) ? text : `https://${text}`).hostname);
    }
    catch {
        return false;
    }
}
/** Only a MausBot Cloud home's browsers connect from a data centre. */
const inCloud = (host) => host === "cloud";
/** Whether a browser on `host` refuses to connect to `name`. */
export function refusesReddit(host, name) {
    return inCloud(host) && isRedditHost(name);
}
/** Whether a browser tool call on `host` would open Reddit: every tool that opens an address, on either engine, takes it as `url`. */
export function opensReddit(host, params) {
    if (!inCloud(host) || !params || typeof params !== "object")
        return false;
    const args = params.arguments;
    const url = args && typeof args === "object" ? args.url : undefined;
    return typeof url === "string" && isRedditAddress(url);
}
