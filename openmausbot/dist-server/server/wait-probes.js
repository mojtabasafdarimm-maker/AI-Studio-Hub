import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveTarget } from "./browser/egress/gate.js";
import { addressClass, ownAddresses } from "./browser/egress/policy.js";
const execFileAsync = promisify(execFile);
export function expandHome(path, home) {
    if (path === "~")
        return home;
    if (path.startsWith("~/") || path.startsWith("~\\"))
        return join(home, path.slice(2));
    return path;
}
export async function fileStamp(path) {
    try {
        const info = await stat(path);
        return { size: info.size, mtimeMs: info.mtimeMs };
    }
    catch {
        return null;
    }
}
export function fileChanged(before, now) {
    if (!now)
        return false;
    if (!before)
        return true;
    return before.size !== now.size || before.mtimeMs !== now.mtimeMs;
}
export function parsePs(stdout) {
    const entries = [];
    for (const line of stdout.split(/\r?\n/)) {
        const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
        if (!match)
            continue;
        const name = match[2].slice(match[2].lastIndexOf("/") + 1);
        if (name)
            entries.push({ pid: Number(match[1]), name });
    }
    return entries;
}
export function parseTasklist(stdout) {
    const entries = [];
    for (const line of stdout.split(/\r?\n/)) {
        const match = /^"([^"]*)","(\d+)"/.exec(line);
        if (match)
            entries.push({ pid: Number(match[2]), name: match[1] });
    }
    return entries;
}
async function runFile(file, args) {
    const { stdout } = await execFileAsync(file, args, {
        timeout: 10_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
    });
    return stdout;
}
export async function listProcesses(platform = process.platform, run = runFile) {
    if (platform === "win32")
        return parseTasklist(await run("tasklist", ["/fo", "csv", "/nh"]));
    return parsePs(await run("ps", ["-axo", "pid=,comm="]));
}
export function processRunning(entries, wanted) {
    const target = wanted.trim();
    if (/^\d+$/.test(target))
        return entries.some((entry) => entry.pid === Number(target));
    const lower = target.toLowerCase();
    const withExe = lower.endsWith(".exe") ? lower : `${lower}.exe`;
    const withoutExe = lower.endsWith(".exe") ? lower.slice(0, -4) : lower;
    return entries.some((entry) => {
        const name = entry.name.toLowerCase();
        if (name === lower || name === withExe || name === withoutExe)
            return true;
        return name.length === 15 && name === lower.slice(0, 15);
    });
}
const NAMED_ENTITIES = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    "#39": "'",
    nbsp: " ",
};
function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (whole, body) => {
        const named = NAMED_ENTITIES[body.toLowerCase()];
        if (named !== undefined)
            return named;
        if (body[0] !== "#")
            return whole;
        const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (!Number.isInteger(code) || code < 0 || code > 0x10ffff)
            return whole;
        return String.fromCodePoint(code);
    });
}
/** `<script` or `<style` as a whole tag name: an element whose text a page never shows. */
const HIDDEN_OPEN = /<(script|style)(?=[\s/>])/iy;
const HIDDEN_CLOSE = { script: /<\/script[\s/>]/gi, style: /<\/style[\s/>]/gi };
const TAG_OPEN = /<[a-z!?/]/iy;
/**
 * Where markup ends (just past it), open + 1 for a literal `<`, or -1 when no complete tag follows.
 * A comment, script or style left open runs to the end, as in a browser.
 */
function markupEnd(body, open) {
    if (body.startsWith("<!--", open)) {
        const close = body.indexOf("-->", open + 2);
        return close === -1 ? body.length : close + 3;
    }
    TAG_OPEN.lastIndex = open;
    if (!TAG_OPEN.test(body))
        return open + 1;
    let close = -1;
    let quote = null;
    for (let at = open + 1; at < body.length; at += 1) {
        const char = body[at];
        if (quote !== null) {
            if (char === quote)
                quote = null;
        }
        else if (char === '"' || char === "'")
            quote = char;
        else if (char === ">") {
            close = at;
            break;
        }
    }
    if (close === -1)
        return -1;
    HIDDEN_OPEN.lastIndex = open;
    const hidden = HIDDEN_OPEN.exec(body)?.[1]?.toLowerCase();
    if (!hidden)
        return close + 1;
    const end = HIDDEN_CLOSE[hidden];
    end.lastIndex = close + 1;
    const found = end.exec(body);
    const after = found ? body.indexOf(">", found.index) : -1;
    return after === -1 ? body.length : after + 1;
}
/**
 * A page's words: tags, comments, scripts and styles out, entities decoded, spaces collapsed. One linear pass, so a
 * hostile 2 MB page costs milliseconds (the patterns this replaced backtracked, and took minutes on a page of `<`).
 */
export function pageText(body) {
    const words = [];
    for (let at = 0, search = 0; at < body.length;) {
        const open = body.indexOf("<", search);
        const end = open === -1 ? -1 : markupEnd(body, open);
        if (end === -1) {
            words.push(body.slice(at));
            break;
        }
        if (end === open + 1) {
            search = end;
            continue;
        }
        words.push(body.slice(at, open), " ");
        at = end;
        search = end;
    }
    return decodeEntities(words.join("")).replace(/\s+/g, " ").trim();
}
export function pageSays(text, wanted) {
    const needle = wanted.replace(/\s+/g, " ").trim().toLowerCase();
    return text.toLowerCase().includes(needle);
}
export const PAGE_TIMEOUT_MS = 15_000;
export const PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const PAGE_MAX_REDIRECTS = 3;
const fail = (error, refused = false) => ({ ok: false, refused, error });
function requestOnce(url, address, signal, maxBytes) {
    return new Promise((resolve, reject) => {
        const pinned = (_host, lookupOptions, callback) => {
            if (lookupOptions.all)
                callback(null, [address]);
            else
                callback(null, address.address, address.family);
        };
        const send = url.protocol === "https:" ? httpsRequest : httpRequest;
        const req = send(url, {
            agent: false,
            signal,
            lookup: pinned,
            headers: { "user-agent": "OpenMausBot-wait", accept: "text/html,text/plain;q=0.9,*/*;q=0.1" },
        }, (response) => {
            const status = response.statusCode ?? 0;
            const { headers } = response;
            if (status < 200 || status >= 300) {
                response.destroy();
                resolve({ status, location: headers.location, headers, body: Buffer.alloc(0) });
                return;
            }
            const chunks = [];
            let size = 0;
            response.on("data", (chunk) => {
                chunks.push(chunk);
                size += chunk.length;
                if (size >= maxBytes) {
                    response.destroy();
                    resolve({ status, headers, body: Buffer.concat(chunks).subarray(0, maxBytes) });
                }
            });
            response.on("end", () => resolve({ status, headers, body: Buffer.concat(chunks) }));
            response.on("error", reject);
        });
        req.on("error", reject);
        req.end();
    });
}
function withinSignal(promise, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted)
            return reject(signal.reason);
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}
export async function fetchPageText(rawUrl, options = {}) {
    const page = await fetchPublicPage(rawUrl, options);
    return page.ok ? { ok: true, text: pageText(page.body.toString("utf8")) } : page;
}
/** Security: only a public address, checked again on every redirect and pinned for the request, so a page can't
 * point this server at itself or a private network. */
export async function fetchPublicPage(rawUrl, options = {}) {
    const lookup = options.lookup ?? resolveTarget;
    const allow = options.allow ?? (({ address }) => addressClass(address, ownAddresses()) === "public");
    const maxBytes = options.maxBytes ?? PAGE_MAX_BYTES;
    const signal = AbortSignal.timeout(options.timeoutMs ?? PAGE_TIMEOUT_MS);
    let url;
    try {
        url = new URL(rawUrl);
    }
    catch {
        return fail("That is not a web address.", true);
    }
    try {
        for (let hop = 0;; hop++) {
            if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
                return fail("Only an http or https address with no sign-in details can be checked.", true);
            }
            const host = url.hostname.replace(/^\[|\]$/g, "");
            const literal = isIP(host);
            const addresses = literal ? [{ address: host, family: literal }] : await withinSignal(lookup(host), signal);
            if (addresses.length === 0)
                return fail("That address could not be found.");
            if (!addresses.every(({ address }) => allow({ host, address }))) {
                return fail(`${host} points at this computer or a private network, which waits never check. Use a page on the public web.`, true);
            }
            signal.throwIfAborted();
            const answer = await requestOnce(url, addresses[0], signal, maxBytes);
            if (answer.status >= 300 && answer.status < 400 && answer.location) {
                if (hop >= (options.maxRedirects ?? PAGE_MAX_REDIRECTS))
                    return fail("The page redirected too many times.");
                url = new URL(answer.location, url);
                continue;
            }
            if (answer.status < 200 || answer.status >= 300)
                return fail(`The page answered ${answer.status}.`);
            return { ok: true, url, headers: answer.headers, body: answer.body };
        }
    }
    catch {
        return signal.aborted ? fail("The page took too long to answer.") : fail("The page could not be reached.");
    }
}
