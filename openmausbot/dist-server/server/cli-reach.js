// How other devices reach a server `openmausbot serve` started, and the lines that say so. A route is chosen by a flag
// (or the saved setup); the link always uses the first one in ROUTE_ORDER.
import { allowedServerOrigin, isLoopbackHost } from "../electron/server-address.mjs";
import { reachableAddresses } from "./lan-address.js";
const DESCRIPTOR = "/.well-known/openmausbot/environment";
/** `--public-url`: https anywhere, or http on a private network; never plain http on the open internet. */
export function publicUrlProblem(url) {
    if (!/^https?:\/\//i.test(url))
        return "--public-url must start with https:// (or http:// on your own network)";
    if (allowedServerOrigin(new URL(url).origin))
        return null;
    return `--public-url ${url} is on the open internet, where plain http isn't encrypted: use its https:// address, or --lan for this network only`;
}
/** OMB_PUBLIC_URL set in the environment: the address a server behind the person's own proxy or tunnel prints. */
export function envPublicUrl(env, log) {
    const raw = env.OMB_PUBLIC_URL?.trim().replace(/\/+$/, "");
    if (!raw)
        return undefined;
    const problem = publicUrlProblem(raw);
    if (problem)
        log(`OMB_PUBLIC_URL is ignored: ${problem.replace(/^--public-url /, "")}`);
    return problem ? undefined : raw;
}
/** `--lan` on a machine with no private address: say so, and serve on loopback only. */
export function lanProblem(addresses = reachableAddresses()) {
    return addresses.lan.length ? null : "--lan: this machine has no private network address, so --lan would reach nobody. Use --public-url, --domain or --tailscale.";
}
/** Whether `origin` answers with this server's own descriptor; never sends a code or a credential. */
export async function checkReach(port, origin, fetchImpl = fetch, now = Date.now) {
    try {
        const local = await (await fetchImpl(`http://127.0.0.1:${port}${DESCRIPTOR}`, { signal: AbortSignal.timeout(3_000) })).json();
        const response = await fetchImpl(`${origin}${DESCRIPTOR}`, { signal: AbortSignal.timeout(5_000), redirect: "error", cache: "no-store" });
        const remote = await response.json().catch(() => null);
        if (typeof local.environmentId !== "string")
            return { ok: false, kind: "unreachable", reason: "this server didn't answer" };
        if (remote?.environmentId === local.environmentId)
            return { ok: true, at: now() };
        return remote?.environmentId ? { ok: false, kind: "other-server" } : { ok: false, kind: "unreachable", reason: `HTTP ${response.status}` };
    }
    catch (error) {
        const code = error?.cause?.code;
        return { ok: false, kind: "unreachable", reason: code === "ECONNREFUSED" ? "connection refused" : code === "ENOTFOUND" ? "no such name yet" : code ?? "no answer" };
    }
}
/** Checks again for up to `budgetMs`: a tunnel, a certificate or a tailnet name can take a few seconds to answer. */
export async function waitForReach(port, origin, budgetMs = 15_000, check = checkReach, pause = (ms) => new Promise((done) => setTimeout(done, ms)), now = Date.now) {
    const deadline = now() + budgetMs;
    let last = { ok: false, kind: "unreachable" };
    do {
        last = await check(port, origin);
        if (last.ok || last.kind === "other-server")
            return last;
        await pause(1_000);
    } while (now() < deadline);
    return last;
}
const clock = (at) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const NOTE = {
    "public-url": "",
    domain: "",
    tunnel: "MausBot web address",
    tailscale: "your tailnet",
    lan: "this network only, not encrypted",
};
/** The Reach line (and its fix, when the address doesn't answer as this server). `check` is absent for the LAN. */
export function reachLines(route, origin, port, prefix, check) {
    if (!check)
        return [`Reach    ${origin}   ${NOTE[route]}`.trimEnd()];
    if (check.ok)
        return [`Reach    ${origin}   ✓ answers as this server (${clock(check.at)})${NOTE[route] ? ` · ${NOTE[route]}` : ""}`];
    if (check.kind === "other-server")
        return [`Reach    ✗ ${origin} answers as a different server.`, `           Check your tunnel or proxy points at this machine's port ${port}.`];
    if (route === "domain")
        return [`Reach    … ${origin} doesn't answer yet (${check.reason ?? "no answer"}).`, "           Check the domain's DNS points at this machine and ports 80 and 443 are open; the certificate follows."];
    return [`Reach    ✗ ${origin} doesn't reach this server (${check.reason ?? "no answer"}).`, `           Point your tunnel or proxy at http://127.0.0.1:${port} (on another machine: add --lan and use this machine's address), then run: ${prefix} status`];
}
/** `serve` with no way in: nothing to pair from elsewhere yet, so no code; the ways in, as commands that paste. */
export function noRouteLines(port, prefix) {
    return [
        `Listening on 127.0.0.1:${port}, reachable from this machine only.`,
        "",
        "Pick a way in and run again:",
        `  ${prefix} serve --public-url https://…     you already have HTTPS in front (cloudflared, Caddy)`,
        `  ${prefix} serve --domain maus.example.com  we get the certificate (ports 80, 443)`,
        `  ${prefix} serve --tailscale                your tailnet (needs Tailscale)`,
        `  ${prefix} serve --lan                      this network only, not encrypted`,
        `  ${prefix} serve --tunnel                   a free MausBot web address; sign in first: ${prefix} login`,
        `Sign in from a browser on this machine with the link from: ${prefix} pair`,
    ];
}
/** Where a browser on the same machine opens a code's link: the configured loopback address (Docker's published port),
 * or this server's own port. */
export function localLinkBase(publicUrl, port, env = process.env) {
    const docker = Boolean(env.OMB_CLI_PREFIX?.includes("docker"));
    if (publicUrl && isLoopbackHost(new URL(publicUrl).hostname))
        return { base: publicUrl, place: docker ? "docker" : "machine" };
    return { base: `http://127.0.0.1:${port}`, place: "machine" };
}
