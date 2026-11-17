import * as actions from "./actions.js";
import { sessionKindOf } from "./connection.js";
import { AuthChallenges } from "./auth.js";
import { Dialogs } from "./dialogs.js";
import { DriverError, parseNetError } from "./errors.js";
import { evaluate, valueInWorld } from "./evaluate.js";
import { FileChoosers, setInputFiles } from "./files.js";
import { FrameTree } from "./frames.js";
import { PageHealth } from "./health.js";
import { Mouse } from "./input.js";
import { Navigations } from "./navigations.js";
import { Keyboard } from "./keyboard.js";
import { RefTable } from "./refs.js";
import { captureScreenshot } from "./screencast.js";
import { SecretGuard } from "./secrets.js";
import { resolveElement } from "./selectors.js";
import { takeSnapshot, visibleText } from "./snapshot.js";
import { releaseSession, setUpDocumentSession, setUpWorkerSession } from "./targets.js";
import { Lifecycle, waitFor } from "./wait.js";
import { extensionPage } from "../extensions.js";
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 15_000;
/** Agent navigation goes to web pages, blank pages and inline documents only. */
export function navigable(url) {
    return /^https?:\/\//i.test(url) || url === "about:blank" || /^data:/i.test(url);
}
/** One tab, driven without the Runtime domain. */
export class CdpPage {
    targetId;
    session;
    openerId;
    frames;
    refs;
    keyboard;
    mouse;
    dialogs = new Dialogs();
    auth = new AuthChallenges();
    fileChoosers = new FileChoosers();
    health;
    lifecycle;
    navigations;
    secrets = new SecretGuard();
    /** Resolves once the tab is configured and running. */
    ready;
    #host;
    #url;
    #title;
    #crashed = false;
    #devicePixelRatio = null;
    #documentStatus = null;
    #emulated = null;
    constructor(host, session, info) {
        this.#host = host;
        this.session = session;
        this.targetId = info.targetId;
        this.openerId = info.openerId ?? null;
        this.#url = info.url;
        this.#title = info.title;
        this.frames = new FrameTree(session, info.targetId);
        this.refs = new RefTable(host.refCounter);
        this.keyboard = new Keyboard(session, { mac: host.mac });
        this.mouse = new Mouse(session, this.keyboard);
        this.health = new PageHealth(() => this.url());
        this.lifecycle = new Lifecycle(session, info.targetId);
        this.navigations = new Navigations(session, this.frames, this.lifecycle);
        this.dialogs.watch(session);
        if (host.setup.handleAuth)
            this.auth.watch(session);
        this.fileChoosers.watch(session);
        this.health.watch(session);
        this.frames.onChange((change) => {
            if (change.kind === "navigated" && change.frameId === this.frames.mainFrameId) {
                this.refs.invalidateAll();
                this.fileChoosers.forget();
            }
            else {
                this.refs.invalidateFrames(change.affected);
            }
        });
        this.dialogs.onClose(() => this.refs.invalidateAll());
        session.on("Target.attachedToTarget", (params) => this.#child(params));
        session.on("Network.responseReceived", (params) => {
            const response = params.response;
            if (params.type === "Document" && params.frameId === this.targetId && typeof params.loaderId === "string" && typeof response?.status === "number") {
                this.#documentStatus = { loaderId: params.loaderId, status: response.status };
            }
        });
        this.ready = setUpDocumentSession(session, host.setup, { isPage: true }).then(() => this.#adoptDocument());
    }
    async #adoptDocument() {
        if (this.frames.main?.loaderId !== null)
            return;
        try {
            const { frameTree } = await this.session.send("Page.getFrameTree");
            if (this.frames.main?.loaderId !== null)
                return;
            this.frames.adopt(frameTree);
            const loaderId = frameTree.frame.loaderId;
            if (!loaderId || this.lifecycle.loaderId !== null)
                return;
            const state = await valueInWorld(this.frames, this.frames.mainFrameId, "document.readyState").catch(() => "loading");
            this.lifecycle.adopt(loaderId, state === "complete");
        }
        catch { }
    }
    get closed() {
        return this.session.detached;
    }
    get crashed() {
        return this.#crashed;
    }
    url() {
        return this.frames.main?.url || this.#url;
    }
    title() {
        return this.#title;
    }
    updateInfo(info) {
        this.#url = info.url;
        this.#title = info.title;
    }
    markCrashed() {
        this.#crashed = true;
    }
    #child(params) {
        const info = params.targetInfo;
        const child = typeof params.sessionId === "string" ? this.session.connection.session(params.sessionId) : undefined;
        if (!info || !child)
            return;
        if (info.type === "iframe") {
            this.frames.watch(child, info.targetId);
            this.health.watch(child);
            this.fileChoosers.watch(child);
            this.dialogs.watch(child);
            child.on("Target.attachedToTarget", (nested) => this.#child(nested));
            child.onDetach(() => {
                this.refs.invalidateSession(child);
                this.fileChoosers.forget(child);
            });
            void setUpDocumentSession(child, this.#host.setup, { isPage: false }).catch(() => { });
        }
        else if (sessionKindOf(info.type) === "worker") {
            setUpWorkerSession(child, this.#host.setup.identity);
        }
        else {
            releaseSession(child);
        }
    }
    #usable() {
        if (this.closed)
            throw new DriverError("closed", "This tab is closed.");
        if (this.#crashed)
            throw new DriverError("closed", "This tab's page crashed. Reload it or open it again.");
    }
    #noDialog() {
        const dialog = this.dialogs.pending;
        if (dialog) {
            throw new DriverError("dialog-pending", `A ${dialog.type} dialog is open on this tab: "${dialog.message.slice(0, 200)}". Answer it first.`, { dialog });
        }
    }
    #ready() {
        this.#usable();
        this.#noDialog();
    }
    bringToFront() {
        return this.#host.bringToFront(this);
    }
    async navigate(url, { readiness = "load", timeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS, personExtension = false } = {}) {
        if (!navigable(url) && !(personExtension && extensionPage(url)))
            throw new DriverError("refused", `Only http(s), about:blank and data: addresses open here, not ${url.slice(0, 80)}.`);
        this.#usable();
        await this.bringToFront();
        return this.dialogs.acceptingBeforeUnload(async () => {
            const sameDocument = this.session.waitFor("Page.navigatedWithinDocument", { match: (params) => params.frameId === this.targetId, timeoutMs });
            sameDocument.catch(() => { });
            const navigating = this.session.send("Page.navigate", { url }, { timeoutMs });
            navigating.catch(() => { });
            let stopAsking = () => { };
            const asked = new Promise((resolve) => {
                stopAsking = this.auth.onChange((challenge) => { if (challenge)
                    resolve(challenge); });
            });
            const first = await Promise.race([navigating, asked]).finally(() => stopAsking());
            if ("origin" in first)
                return { url, status: 401, signInPrompt: { origin: first.origin, realm: first.realm } };
            const result = first;
            if (result.isDownload) {
                throw new DriverError("navigation", `${url} is a file this browser cannot show, so it was downloaded instead. The tab's downloads list it.`, { download: true });
            }
            if (result.errorText) {
                const { description } = parseNetError(result.errorText);
                throw new DriverError("navigation", `Navigation to ${url} failed: ${description}`, { netError: description });
            }
            if (!result.loaderId)
                await sameDocument;
            else if (readiness !== "none")
                await this.lifecycle.waitFor(readiness, { loaderId: result.loaderId, timeoutMs });
            const status = result.loaderId && this.#documentStatus?.loaderId === result.loaderId ? this.#documentStatus.status : null;
            return { url: this.url(), status };
        });
    }
    /** Runs `start` and waits for the main frame to commit a new document (and reach `readiness`) or move within this one. */
    async #settle(start, readiness, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        const nextDocument = this.lifecycle.nextDocument(timeoutMs);
        const sameDocument = this.session.waitFor("Page.navigatedWithinDocument", { match: (params) => params.frameId === this.targetId, timeoutMs });
        nextDocument.catch(() => { });
        sameDocument.catch(() => { });
        await this.dialogs.acceptingBeforeUnload(async () => {
            await start();
            const loaderId = await Promise.race([nextDocument, sameDocument.then(() => null)]);
            if (loaderId && readiness !== "none")
                await this.lifecycle.waitFor(readiness, { loaderId, timeoutMs: Math.max(1, deadline - Date.now()) });
        });
        return { url: this.url(), status: null };
    }
    async #history(delta, { readiness = "load", timeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS }) {
        this.#ready();
        await this.bringToFront();
        const { currentIndex, entries } = await this.session.send("Page.getNavigationHistory");
        const entry = entries[currentIndex + delta];
        if (!entry)
            throw new DriverError("refused", delta < 0 ? "There is no earlier page in this tab's history." : "There is no later page in this tab's history.");
        return this.#settle(() => this.session.send("Page.navigateToHistoryEntry", { entryId: entry.id }), readiness, timeoutMs);
    }
    back(options = {}) {
        return this.#history(-1, options);
    }
    forward(options = {}) {
        return this.#history(1, options);
    }
    async reload({ readiness = "load", timeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS } = {}) {
        if (this.closed)
            throw new DriverError("closed", "This tab is closed.");
        this.#noDialog();
        await this.bringToFront();
        const result = await this.#settle(() => this.session.send("Page.reload", {}), readiness, timeoutMs);
        this.#crashed = false;
        return result;
    }
    /** The size the page is laid out at apart from its window's, and how many times larger it is drawn; null when it fills its window. */
    get emulated() {
        return this.#emulated;
    }
    /** Lays the page out at `size` whatever its window's size, drawn `zoom` times larger, as DevTools' device mode does; null ends that. */
    async emulateSize(size, zoom = 1) {
        if (!size) {
            this.#emulated = null;
            await this.session.send("Emulation.clearDeviceMetricsOverride");
            return;
        }
        const ratio = await this.devicePixelRatio().catch(() => 1);
        await this.session.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: ratio * zoom, mobile: false });
        this.#emulated = { width: size.width, height: size.height, zoom };
    }
    async devicePixelRatio() {
        if (this.#devicePixelRatio === null) {
            const ratio = await valueInWorld(this.frames, this.frames.mainFrameId, "devicePixelRatio");
            this.#devicePixelRatio = typeof ratio === "number" && ratio > 0 ? ratio : 1;
        }
        return this.#devicePixelRatio;
    }
    async snapshot({ includeImage = false, maskValue } = {}) {
        this.#ready();
        if (includeImage)
            await this.secrets.refuseWhilePresent(this.frames);
        const mask = (value) => this.secrets.holds(value) || maskValue?.(value) === true;
        const snapshot = await takeSnapshot(this.frames, this.refs, { maskValue: mask });
        const image = includeImage ? await this.screenshot() : undefined;
        return { url: this.url(), title: this.#title, ...snapshot, ...(image ? { image } : {}) };
    }
    async visibleText(maxChars) {
        this.#ready();
        return visibleText(this.frames, maxChars);
    }
    async screenshot(options = {}) {
        this.#ready();
        await this.secrets.refuseWhilePresent(this.frames);
        let clip = options.clip;
        if (options.target) {
            const handle = await resolveElement(this.frames, this.refs, options.target);
            await handle.session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: handle.backendNodeId }).catch(() => { });
            const { model } = await handle.session.send("DOM.getBoxModel", { backendNodeId: handle.backendNodeId });
            const offset = await this.frames.localRootOffset(handle.session);
            const xs = [model.border[0], model.border[2], model.border[4], model.border[6]];
            const ys = [model.border[1], model.border[3], model.border[5], model.border[7]];
            const metrics = await this.session.send("Page.getLayoutMetrics");
            clip = {
                x: Math.min(...xs) + offset.x + metrics.cssVisualViewport.pageX,
                y: Math.min(...ys) + offset.y + metrics.cssVisualViewport.pageY,
                width: Math.max(1, Math.max(...xs) - Math.min(...xs)),
                height: Math.max(1, Math.max(...ys) - Math.min(...ys)),
            };
        }
        return captureScreenshot(this.session, (await this.devicePixelRatio()) * (this.#emulated?.zoom ?? 1), { ...options, ...(clip ? { clip } : {}) });
    }
    async evaluate(expression, options = {}) {
        this.#ready();
        await this.secrets.refuseWhilePresent(this.frames);
        return evaluate(this.frames, expression, options);
    }
    async waitFor(conditions) {
        this.#usable();
        return waitFor(this, conditions);
    }
    async click(target, options = {}) {
        this.#ready();
        return actions.click(this, target, options);
    }
    async hover(target, options = {}) {
        this.#ready();
        return actions.hover(this, target, options);
    }
    async fill(target, text) {
        this.#ready();
        return actions.fill(this, target, text);
    }
    /** A saved secret: typed with Input.insertText only, and screenshots and evaluation stay refused while it is on the page. */
    async fillSecret(target, secret) {
        this.#ready();
        this.secrets.arm(this.frames, [secret]);
        await actions.fill(this, target, secret);
    }
    async type(target, text) {
        this.#ready();
        return actions.type(this, target, text);
    }
    async press(chord) {
        this.#ready();
        return actions.press(this, chord);
    }
    async select(target, values) {
        this.#ready();
        return actions.select(this, target, values);
    }
    async check(target, checked = true, options = {}) {
        this.#ready();
        return actions.check(this, target, checked, options);
    }
    async drag(from, to, options = {}) {
        this.#ready();
        return actions.drag(this, from, to, options);
    }
    async scroll(target, deltaX, deltaY, options = {}) {
        this.#ready();
        return actions.scroll(this, target, deltaX, deltaY, options);
    }
    /** Files for a named file input, or else for the picker the page opened. */
    async upload(paths, target) {
        this.#ready();
        if (target)
            await setInputFiles(this.frames, await resolveElement(this.frames, this.refs, target), paths);
        else
            await this.fileChoosers.answer(paths);
    }
    async answerDialog(answer) {
        this.#usable();
        return this.dialogs.answer(answer);
    }
    takeHealth() {
        return this.health.take(this.frames.all());
    }
    /** What a copy or cut key press just put on the page's clipboard, from any frame. */
    async takeCopiedText() {
        const copies = await Promise.all(this.frames.all().map((frame) => valueInWorld(this.frames, frame.id, "typeof __ombTakeCopy === 'function' ? __ombTakeCopy() : ''").catch(() => "")));
        return copies.find((text) => typeof text === "string" && text.length > 0) ?? "";
    }
    /** A takeover revokes every ref, even when the document stays the same. */
    invalidateRefs() {
        this.refs.invalidateAll();
    }
    /** Lets go of every key and button, so whoever acts next starts clean. */
    async releaseInput() {
        await this.keyboard.releaseAll();
        await this.mouse.releaseAll();
    }
    close() {
        return this.#host.closePage(this);
    }
}
