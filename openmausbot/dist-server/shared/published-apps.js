/** A site's own address on Netlify: https://<name>.netlify.app, with nothing but a path after it. */
export function isNetlifySiteUrl(value) {
    if (typeof value !== "string")
        return false;
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return false;
    }
    return url.protocol === "https:" && !url.username && !url.password && !url.port && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.netlify\.app$/.test(url.hostname.toLowerCase());
}
