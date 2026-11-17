// agent-browser keeps a session's cookies and storage in the running Chrome, in its kept profile, and in the restore file
// it autosaves (`<restore key>-<session>.json.enc`, cli/src/native/state.rs: AES-256-GCM under SHA-256 of the key text,
// 12-byte nonce first, 16-byte tag last); signing out clears all three. The key stays in this server process; no bot or page ever sees it.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserRestoreKey, browserSessionsDirectory, closeBrowserSession, inRunningBrowser, startBrowserSession } from "./browser-engine.js";
import { browserRuntimeEnv } from "./browser-runtime.js";
const EMPTY_STATE = { cookies: [], origins: [] };
// Everything an origin keeps but its cookies (deleted one by one) and its
// tabs' sessionStorage (cleared in the open pages).
const ORIGIN_STORAGE = "local_storage,indexeddb,websql,cache_storage,service_workers,file_systems";
function stateKey(key) {
    return createHash("sha256").update(key).digest();
}
export function decryptBrowserState(data, key) {
    if (data.length < 29)
        throw new Error("Saved browser state is too short.");
    const decipher = createDecipheriv("aes-256-gcm", stateKey(key), data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]).toString("utf8");
}
export function encryptBrowserState(text, key) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", stateKey(key), nonce);
    const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}
function isCookie(value) {
    const cookie = value;
    return typeof cookie?.name === "string" && typeof cookie.domain === "string" && typeof cookie.path === "string";
}
function isOrigin(value) {
    return typeof value?.origin === "string";
}
function hostOfCookie(cookie) {
    return cookie.domain.replace(/^\./u, "").toLowerCase();
}
function hostOfOrigin(origin) {
    try {
        return new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/gu, "") || null;
    }
    catch {
        return null;
    }
}
function hasStorage(origin) {
    return [origin.localStorage, origin.sessionStorage].some((entries) => Array.isArray(entries) && entries.length > 0);
}
/** No suffix list is needed: a browser never stores a cookie for `co.uk`. */
function siteOf(host, hosts) {
    if (/^[\d.]+$|:/u.test(host))
        return host;
    const labels = host.split(".");
    for (let count = 2; count < labels.length; count += 1) {
        const candidate = labels.slice(-count).join(".");
        if (hosts.has(candidate))
            return candidate;
    }
    return host;
}
function inSite(host, site) {
    return host === site || host.endsWith(`.${site}`);
}
export function signedInSites(cookies, origins) {
    const cookieHosts = cookies.filter(isCookie).map(hostOfCookie);
    const storageHosts = origins.filter(isOrigin).filter(hasStorage).flatMap((origin) => hostOfOrigin(origin.origin) ?? []);
    const hosts = new Set([...cookieHosts, ...storageHosts].filter(Boolean));
    const sites = new Map();
    const entry = (host) => {
        const site = siteOf(host, hosts);
        let found = sites.get(site);
        if (!found)
            sites.set(site, found = { site, cookies: 0, storage: 0 });
        return found;
    };
    for (const host of cookieHosts)
        if (host)
            entry(host).cookies += 1;
    for (const host of storageHosts)
        entry(host).storage += 1;
    return [...sites.values()].sort((a, b) => a.site.localeCompare(b.site));
}
function withoutSite(state, site) {
    return {
        ...state,
        cookies: state.cookies.filter((cookie) => !isCookie(cookie) || !inSite(hostOfCookie(cookie), site)),
        origins: state.origins.filter((origin) => {
            const host = isOrigin(origin) ? hostOfOrigin(origin.origin) : null;
            return !host || !inSite(host, site);
        }),
    };
}
function stateBases(session) {
    return [`${browserRestoreKey(session)}-${session}`, `${session}-${session}`];
}
function readState(path, key) {
    const raw = readFileSync(path);
    const value = JSON.parse(path.endsWith(".enc") ? decryptBrowserState(raw, key) : raw.toString("utf8"));
    const state = value;
    if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins))
        throw new Error("Not saved browser state.");
    return state;
}
function modified(path) {
    try {
        return statSync(path).mtimeMs;
    }
    catch {
        return 0;
    }
}
/** agent-browser restores the newest file under the session's restore key; an unreadable file restores nothing. */
function savedState(directory, session, key) {
    for (const base of stateBases(session)) {
        const path = [".json.enc", ".json"].map((suffix) => join(directory, base + suffix)).filter(existsSync)
            .sort((a, b) => modified(b) - modified(a))[0];
        if (!path)
            continue;
        try {
            return readState(path, key);
        }
        catch {
            return EMPTY_STATE;
        }
    }
    return EMPTY_STATE;
}
function writeState(path, state, key) {
    const text = JSON.stringify(state, null, 2);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, path.endsWith(".enc") ? encryptBrowserState(text, key) : text, { mode: 0o600 });
    try {
        renameSync(temporary, path);
    }
    catch (error) {
        try {
            unlinkSync(temporary);
        }
        catch { }
        throw error;
    }
}
/** Synchronous from read to rename, so no other cleanup interleaves; the `.previous` backups agent-browser leaves mid-save
 * hold the old logins and go too. */
function rewriteSavedState(directory, session, key, site) {
    for (const base of stateBases(session)) {
        for (const suffix of [".json.enc", ".json"]) {
            const path = join(directory, base + suffix);
            if (existsSync(path)) {
                let state = EMPTY_STATE;
                if (site !== null) {
                    try {
                        state = withoutSite(readState(path, key), site);
                    }
                    catch {
                        continue;
                    }
                }
                writeState(path, state, key);
            }
            try {
                unlinkSync(`${path}.previous`);
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
        }
    }
}
export function connectCdp(url, timeoutMs = 10_000, listeners = {}) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        const pending = new Map();
        let next = 1;
        const failAll = (error) => { for (const call of pending.values())
            call.fail(error); pending.clear(); };
        const opening = setTimeout(() => { socket.close(); reject(new Error("The running browser did not answer.")); }, timeoutMs);
        socket.addEventListener("error", () => {
            clearTimeout(opening);
            reject(new Error("Could not reach the running browser."));
            failAll(new Error("The browser connection failed."));
        });
        socket.addEventListener("close", () => {
            failAll(new Error("The browser connection closed."));
            listeners.closed?.();
        });
        socket.addEventListener("message", (event) => {
            let message;
            try {
                message = JSON.parse(String(event.data));
            }
            catch {
                return;
            }
            if (message.id === undefined && typeof message.method === "string") {
                listeners.event?.({ method: message.method, params: message.params, sessionId: message.sessionId });
                return;
            }
            const call = typeof message.id === "number" ? pending.get(message.id) : undefined;
            if (!call)
                return;
            pending.delete(message.id);
            if (message.error)
                call.fail(new Error(message.error.message || "The browser refused a request."));
            else
                call.done(message.result ?? {});
        });
        socket.addEventListener("open", () => {
            clearTimeout(opening);
            resolve({
                send: (method, params = {}, sessionId) => new Promise((done, fail) => {
                    if (socket.readyState !== WebSocket.OPEN)
                        return fail(new Error("The browser connection closed."));
                    const id = next++;
                    const timer = setTimeout(() => { pending.delete(id); fail(new Error("The running browser did not answer.")); }, timeoutMs);
                    pending.set(id, {
                        done: (value) => { clearTimeout(timer); done(value); },
                        fail: (error) => { clearTimeout(timer); fail(error); },
                    });
                    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
                }),
                close: () => socket.close(),
            });
        });
    });
}
async function pages(cdp) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    return (targetInfos ?? []).flatMap((target) => target.type === "page" && typeof target.targetId === "string"
        ? [{ targetId: target.targetId, url: typeof target.url === "string" ? target.url : "" }] : []);
}
/** Cookies are read and deleted through a page, in the bot's own browser context. */
async function onPage(cdp, target, act) {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    if (typeof sessionId !== "string")
        throw new Error("Could not open the running browser's page.");
    try {
        return await act(sessionId);
    }
    finally {
        await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
}
function originOf(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
    }
    catch {
        return null;
    }
}
async function signOutLive(cdp, site, live) {
    const open = await pages(cdp);
    const first = open[0];
    if (!first)
        throw new Error("The running browser has no page open. Close it and try again.");
    const matches = (host) => host !== null && (site === null || inSite(host, site));
    const origins = new Set();
    await onPage(cdp, first, async (sessionId) => {
        const { cookies } = await cdp.send("Network.getAllCookies", {}, sessionId);
        const doomed = (cookies ?? []).filter(isCookie).filter((cookie) => matches(hostOfCookie(cookie)));
        for (const cookie of doomed)
            for (const scheme of ["https", "http"])
                origins.add(`${scheme}://${hostOfCookie(cookie)}`);
        if (site === null)
            await cdp.send("Network.clearBrowserCookies", {}, sessionId);
        else {
            for (const cookie of doomed) {
                await cdp.send("Network.deleteCookies", {
                    name: cookie.name, domain: cookie.domain, path: cookie.path,
                    ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
                }, sessionId);
            }
        }
        for (const origin of live.origins.filter(isOrigin))
            if (matches(hostOfOrigin(origin.origin)))
                origins.add(origin.origin);
        for (const page of open) {
            const origin = originOf(page.url);
            if (origin && matches(hostOfOrigin(origin)))
                origins.add(origin);
        }
        for (const origin of origins)
            await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: ORIGIN_STORAGE }, sessionId);
    });
    for (const page of open) {
        const origin = originOf(page.url);
        if (!origin || !matches(hostOfOrigin(origin)))
            continue;
        await onPage(cdp, page, (sessionId) => cdp.send("Runtime.evaluate", { expression: "try { sessionStorage.clear() } catch {}" }, sessionId));
    }
}
const sessionEnv = (target) => browserRuntimeEnv({ ...target.env, AGENT_BROWSER_SESSION: target.session });
const defaultEngine = (target, args) => inRunningBrowser(target.binaryPath, sessionEnv(target), args);
const defaultStart = (target) => startBrowserSession(target.binaryPath, sessionEnv(target));
const defaultStop = (target) => closeBrowserSession(target.binaryPath, sessionEnv(target));
function keptProfile(target) {
    const dir = target.env.AGENT_BROWSER_PROFILE;
    return !!dir && existsSync(dir);
}
async function runningState(target, deps) {
    const scratch = mkdtempSync(join(tmpdir(), "omb-browser-state-"));
    try {
        const path = join(scratch, "state.json");
        const answer = await (deps.engine ?? defaultEngine)(target, ["state", "save", path]);
        if (!answer)
            return null;
        const written = [`${path}.enc`, path].find(existsSync);
        if (!written)
            throw new Error("The browser did not save its sign-ins.");
        return readState(written, target.encryptionKey);
    }
    finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}
function directoryOf(target) {
    return browserSessionsDirectory(browserRuntimeEnv({ ...target.env, AGENT_BROWSER_SESSION: target.session }));
}
// One listing or sign-out at a time per session, so two clicks cannot interleave live deletes and file rewrites.
const queues = new Map();
function serially(session, work) {
    const previous = queues.get(session) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.catch(() => undefined);
    queues.set(session, settled);
    void settled.then(() => { if (queues.get(session) === settled)
        queues.delete(session); });
    return run;
}
export function listSignedInSites(target, deps = {}) {
    return serially(target.session, () => visit(target, deps, null, false));
}
/** The running browser first, then the saved state, so the next launch restores neither. */
export function signOutOfSites(target, site, deps = {}) {
    return serially(target.session, () => visit(target, deps, site, true));
}
async function visit(target, deps, site, signOut) {
    const directory = directoryOf(target);
    const listed = (sites) => site === null || sites.some((entry) => entry.site === site);
    const stopped = () => {
        const before = savedState(directory, target.session, target.encryptionKey);
        const sites = signedInSites(before.cookies, before.origins);
        if (!signOut || !listed(sites))
            return { running: false, sites };
        rewriteSavedState(directory, target.session, target.encryptionKey, site);
        const after = savedState(directory, target.session, target.encryptionKey);
        return { running: false, sites: signedInSites(after.cookies, after.origins) };
    };
    let live = await runningState(target, deps);
    const starting = !live && signOut && keptProfile(target);
    if (starting) {
        if (!await (deps.start ?? defaultStart)(target))
            throw new Error("The browser could not start to sign out. Try again.");
        live = await runningState(target, deps);
    }
    try {
        if (!live)
            return stopped();
        const result = await signOutLiveState(target, deps, site, signOut, live, stopped);
        return starting ? { ...result, running: false } : result;
    }
    finally {
        if (starting)
            await (deps.stop ?? defaultStop)(target).catch(() => false);
    }
}
async function signOutLiveState(target, deps, site, signOut, live, stopped) {
    const directory = directoryOf(target);
    const listed = (sites) => site === null || sites.some((entry) => entry.site === site);
    const sites = signedInSites(live.cookies, live.origins);
    if (!signOut || !listed(sites))
        return { running: true, sites };
    const answer = await (deps.engine ?? defaultEngine)(target, ["get", "cdp-url"]);
    if (!answer)
        return stopped();
    const url = answer.cdpUrl;
    // Only the engine's own Chrome on this machine is ever addressed.
    if (typeof url !== "string" || !/^wss?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\//u.test(url)) {
        throw new Error("The running browser did not give its DevTools address. Close it and try again.");
    }
    const cdp = await (deps.connect ?? connectCdp)(url);
    try {
        await signOutLive(cdp, site, live);
    }
    finally {
        cdp.close();
    }
    rewriteSavedState(directory, target.session, target.encryptionKey, site);
    const after = await runningState(target, deps) ?? EMPTY_STATE;
    return { running: true, sites: signedInSites(after.cookies, after.origins) };
}
