// People watching and driving a bot's browser. Every viewer gets its own CDP session on the tab in front, with its own
// screencast sized to it, and the page fills the panel: in fill mode it takes the shape of the latest viewer's panel at
// a desktop's width, 1280x800 with nobody watching. Frames come at the screen's real device scale, so they stay sharp.
//
// Adapted from pingdotgg/t3code@00cdceb1 apps/server/src/preview/ServerBrowser.ts (attachViewer,
// dispatchViewerInput, releaseViewerInput, applySetting, withScreencastsPaused), MIT License, Copyright (c) 2026 T3
// Tools Inc. (full text in third_party/t3-code/LICENSE); modified: the CDP driver instead of Playwright, a real window
// resize instead of an emulated viewport, one control for the whole profile, a watching viewer may size the page, and
// input held by a viewer that leaves is released at once.
import { randomUUID } from "node:crypto";
import { callOnNode } from "../cdp/evaluate.js";
import { editingCommands, keyDescription, US_KEYBOARD } from "../cdp/keyboard.js";
import { personUrl } from "../dispatch.js";
import { extensionInput } from "../extensions.js";
import { ACCEPT_OF, chooseOption, cursorAt, editableAt, selectAt } from "./popups.js";
import { ViewerHold } from "./hold.js";
import { fitsScreen, MIN_WINDOW_WIDTH, requestedSize, VIEWPORT_PRESETS, viewportFor, ZOOM_LIMITS, zoomedLayout } from "./viewport.js";
/** Chromium keeps three frames unacknowledged, so acking 100 ms after arrival caps a viewer near 30 fps. */
export const ACK_PACE_MS = { hi: 100, lo: 200 };
export const SETTLE_MS = 200;
/** Only scrolling sends reduced frames; an animation stays sharp. */
const MOTION_FRAMES = 4;
const MOTION_WINDOW_MS = 300;
const MOTION_QUALITY = 50;
/** The largest frame a viewer may ask for, in device pixels. */
export const FRAME_CAP_LIMITS = { maxWidth: 7680, maxHeight: 4320 };
const AGENT_CURSOR_MOVE_MS = 160;
const AGENT_CURSOR_CLICK_LEAD_MS = 40;
const TEXT_LIMIT = 10_000;
const HELD_LIMIT = 64;
const CURSOR_EVERY_MS = 120;
const num = (value, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const record = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : null);
const modifiersOf = (message) => {
    const value = num(message.modifiers);
    return Number.isInteger(value) && value >= 0 && value < 16 ? value : 0;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const appliedKey = (size, zoom) => `${size.width}x${size.height}@${zoom}`;
export class Viewer {
    id = randomUUID();
    options;
    #hub;
    #push;
    requested = null;
    tab = null;
    #session = null;
    #binding = Promise.resolve();
    #params = Promise.resolve();
    #scale = 1;
    #framesInFlight = 0;
    #mayHaveDropped = false;
    #motion = false;
    #recent = [];
    #settle = null;
    #frameSeen = false;
    #paused = 0;
    #hidden = false;
    scrolledAt = 0;
    pressedKeys = new Map();
    pressedButtons = new Map();
    /** The <select> this viewer's press opened, drawn by the viewer: its press and release never reach the page. */
    select = null;
    swallowed = new Set();
    cursor = "default";
    cursorAt = 0;
    closed = false;
    constructor(hub, options, push) {
        this.#hub = hub;
        this.#push = push;
        this.options = {
            owner: options.owner,
            person: options.person ?? options.owner,
            canOperate: options.canOperate,
            maxWidth: Math.max(1, Math.round(options.maxWidth)),
            maxHeight: Math.max(1, Math.round(options.maxHeight)),
            quality: Math.min(100, Math.max(1, Math.round(options.quality ?? 70))),
            pace: options.pace ?? "hi",
            authPrompts: options.authPrompts === true,
            pagePopups: options.pagePopups === true,
            pointer: options.pointer !== false,
        };
    }
    push(output) {
        if (this.closed) {
            if (output.type === "frame")
                output.ack();
            return;
        }
        try {
            this.#push(output);
        }
        catch { }
    }
    get session() {
        return this.#session;
    }
    /** Follows the tab in front: a new session and screencast for it, the old ones let go. */
    bind(tab) {
        this.#binding = this.#binding.then(() => this.#bind(tab), () => this.#bind(tab));
        return this.#binding;
    }
    async #bind(tab) {
        if (this.closed || this.tab === tab && this.#session && !this.#session.detached)
            return;
        await this.#unbind();
        this.tab = tab;
        const browser = this.#hub.host.browser();
        if (!tab || !browser || tab.page.closed)
            return;
        let session;
        try {
            session = await browser.attachSession(tab.page);
        }
        catch {
            return;
        }
        if (this.closed || this.tab !== tab) {
            await browser.detachSession(session);
            return;
        }
        this.#session = session;
        this.#frameSeen = false;
        session.on("Page.screencastFrame", (params) => this.#frame(session, params));
        if (this.#hidden)
            return;
        await this.#start(1);
        // An idle page does not repaint for a new screencast, so the viewer starts from a still unless a live frame beat it.
        if (!this.#frameSeen)
            await this.pushStill();
    }
    async #unbind() {
        const session = this.#session;
        this.#session = null;
        if (this.#settle)
            clearTimeout(this.#settle);
        this.#settle = null;
        this.#motion = false;
        this.#recent = [];
        if (!session || session.detached)
            return;
        await session.send("Page.stopScreencast").catch(() => { });
        await this.#hub.host.browser()?.detachSession(session);
    }
#start(scale) {
 this.#scale=scale;const session=this.#session;
 const run=async()=>{
  for(let attempt=0;attempt<2;attempt++){
   if(!session||session!==this.#session||session.detached||this.#paused>0||this.#hidden||this.closed)return;
   await session.send('Page.stopScreencast').catch(()=>{});
   try{await session.send('Page.startScreencast',{format:'jpeg',quality:scale<1?Math.min(this.options.quality,50):this.options.quality,maxWidth:Math.max(1,Math.round(this.options.maxWidth*scale)),maxHeight:Math.max(1,Math.round(this.options.maxHeight*scale))});return;}
   catch(error){console.warn('[browser-stream] Screencast start failed', {attempt:attempt+1,error:error?.name||'Error'});}
  }
  // Callers capture a still after binding or resizing; do not recursively capture from the parameter queue.
  console.error('[browser-stream] Screencast start recovery failed; retaining still-image fallback');
 };
 this.#params=this.#params.then(run,run);return this.#params;
}
    /** Stops the screencast while a scaled capture renders: it would show up in it. */
    pause() {
        this.#paused++;
        const session = this.#session;
        this.#params = this.#params.then(() => session?.send("Page.stopScreencast").then(() => undefined, () => undefined));
        return this.#params;
    }
    resume() {
        this.#paused = Math.max(0, this.#paused - 1);
        return this.#paused === 0 ? this.#start(this.#scale) : Promise.resolve();
    }
    /** Another viewer holds the browser: this one sees no frames until it is released. */
    async hide(hidden) {
        if (hidden === this.#hidden)
            return;
        this.#hidden = hidden;
        if (hidden) {
            const session = this.#session;
            this.#params = this.#params.then(() => session?.send("Page.stopScreencast").then(() => undefined, () => undefined));
            await this.#params;
            return;
        }
        await this.#start(1);
        await this.pushStill();
    }
    #frame(session, params) {
        if (session !== this.#session) {
            void session.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => { });
            return;
        }
        this.#frameSeen = true;
        if (this.#framesInFlight > 0)
            this.#mayHaveDropped = true;
        this.#framesInFlight++;
        const arrivedAt = Date.now();
        this.#recent.push(arrivedAt);
        while (this.#recent[0] < arrivedAt - MOTION_WINDOW_MS)
            this.#recent.shift();
        if (!this.#motion && this.#recent.length >= MOTION_FRAMES && arrivedAt - this.scrolledAt < MOTION_WINDOW_MS) {
            this.#motion = true;
            void this.#start(0.5);
        }
        else if (this.#motion && arrivedAt - this.scrolledAt > SETTLE_MS) {
            // The page keeps animating after the scroll; its own frames are sharp again.
            this.#motion = false;
            this.#recent = [];
            void this.#start(1);
        }
        this.#armSettle();
        let acked = false;
        const ack = () => {
            if (acked)
                return;
            acked = true;
            setTimeout(() => {
                this.#framesInFlight = Math.max(0, this.#framesInFlight - 1);
                void session.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => { });
            }, Math.max(0, arrivedAt + ACK_PACE_MS[this.options.pace] - Date.now()));
        };
        this.push({ type: "frame", data: Buffer.from(String(params.data ?? ""), "base64"), metadata: params.metadata, still: false, ack });
    }
    /** The page changed under the screencast (its size or zoom): Chromium may not repaint for it, so a still follows once frames stop. */
    refreshSoon() {
        if (this.closed || !this.#session)
            return;
        this.#mayHaveDropped = true;
        this.#armSettle();
    }
    #armSettle() {
        if (this.#settle)
            clearTimeout(this.#settle);
        this.#settle = setTimeout(() => {
            this.#settle = null;
            if (!this.#motion && !this.#mayHaveDropped)
                return;
            this.#mayHaveDropped = false;
            if (this.#motion) {
                this.#motion = false;
                this.#recent = [];
                void this.#start(1);
            }
            void this.pushStill();
        }, SETTLE_MS);
    }
    /** The viewer can show larger frames now: its screencast restarts at the new cap, in place, and a still shows the page at it. */
    async setFrameCap(width, height) {
        const maxWidth = Math.min(Math.round(num(width)), FRAME_CAP_LIMITS.maxWidth);
        const maxHeight = Math.min(Math.round(num(height)), FRAME_CAP_LIMITS.maxHeight);
        if (!(maxWidth >= 1 && maxHeight >= 1) || (maxWidth === this.options.maxWidth && maxHeight === this.options.maxHeight))
            return;
        this.options.maxWidth = maxWidth;
        this.options.maxHeight = maxHeight;
        await this.#start(this.#scale);
        await this.pushStill();
    }
    /** A picture of the page as it is now, at this viewer's size; a scaled one pauses every viewer of the tab. */
    async pushStill() {
        const tab = this.tab;
        const session = this.#session;
        if (!tab || !session || session.detached || this.#hidden || this.closed)
            return;
        try {
            const metrics = await session.send("Page.getLayoutMetrics");
            const view = metrics.cssVisualViewport;
            const ratio = (await tab.page.devicePixelRatio()) * (tab.page.emulated?.zoom ?? 1);
            const scale = Math.min(1, this.options.maxWidth / Math.max(1, view.clientWidth * ratio), this.options.maxHeight / Math.max(1, view.clientHeight * ratio));
            // A scaled capture on any session but the one that emulates a zoom resets the page's device scale factor (Chrome 155).
            const capture = () => (scale < 1 ? tab.page.session : session).send("Page.captureScreenshot", {
                format: "jpeg",
                quality: this.options.quality,
                ...(scale < 1 ? { clip: { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale } } : {}),
            });
            const { data } = scale < 1 ? await this.#hub.paused(tab, capture) : await capture();
            if (this.closed || session !== this.#session)
                return;
            this.push({
                type: "frame",
                data: Buffer.from(data, "base64"),
                metadata: { deviceWidth: view.clientWidth, deviceHeight: view.clientHeight, offsetTop: 0, pageScaleFactor: view.scale ?? 1, scrollOffsetX: view.pageX, scrollOffsetY: view.pageY, timestamp: Date.now() / 1000 },
                still: true,
                ack: () => { },
            });
        }
        catch(error) {
            console.warn('[browser-stream] Still capture failed; retrying without clip', {error:error?.name||'Error'});
            if(this.closed||session!==this.#session||session.detached||this.#hidden)return;
            try {
                const captureSession=tab.page.session??session;
                const {data}=await this.#hub.paused(tab,()=>captureSession.send('Page.captureScreenshot',{format:'jpeg',quality:this.options.quality}));
                if(this.closed||session!==this.#session||this.#hidden)return;
                const size=this.#hub.viewport();
                this.push({type:'frame',data:Buffer.from(data,'base64'),metadata:{deviceWidth:size.width,deviceHeight:size.height,offsetTop:0,pageScaleFactor:1,scrollOffsetX:0,scrollOffsetY:0,timestamp:Date.now()/1000},still:true,ack:()=>{}});
            }catch(retryError){console.error('[browser-stream] Still capture recovery failed',{error:retryError?.name||'Error'});}
        }
    }
    /** keyUp and mouseUp for everything this viewer still holds, on the session it pressed them on. */
    async releaseInput() {
        const session = this.#session;
        let clean = true;
        for (const { key, code } of this.pressedKeys.values()) {
            if (!session || session.detached) {
                clean = false;
                break;
            }
            await session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code }).catch(() => { clean = false; });
        }
        this.pressedKeys.clear();
        for (const [button, point] of this.pressedButtons) {
            if (!session || session.detached) {
                clean = false;
                break;
            }
            await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", button, ...point, buttons: 0, clickCount: 1 }).catch(() => { clean = false; });
        }
        this.pressedButtons.clear();
        return clean;
    }
    /** One message from the viewer. Input runs only while this viewer controls the browser; anything else is dropped. */
    async input(raw) {
        if (this.closed || !this.options.canOperate)
            return;
        const message = record(raw);
        if (!message)
            return;
        try {
            await this.#hub.input(this, message);
        }
        catch {
            this.#hub.broadcastControl();
        }
    }
    /** The tabs as they are now, as agent-browser's stream sent them after every change of the page. */
    pushTabs() {
        this.#hub.pushTabs(this);
    }
    /** Who holds the browser, as this viewer's control message tells it. */
    controlState() { return this.#hub.controlFor(this); }
    /** Everything a viewer that just started listening needs: who controls, the size, the tabs, and a picture. */
    async refresh() {
        this.push(this.#hub.statusFor());
        this.push(this.#hub.controlFor(this));
        this.#hub.pushTabs(this);
        await this.pushStill();
    }
    async close({ dropped = false } = {}) {
        if (this.closed)
            return;
        await this.#hub.detach(this, { dropped });
    }
    async teardown() {
        this.closed = true;
        await this.#unbind();
    }
}
/** A profile's viewers: their sizes, their screencasts, and what they may do. */
export class ViewerHub {
    host;
    viewers = new Set();
    setting = { mode: "fill" };
    zoom = 1;
    #order = 0;
    #chooser = null;
    #authOffered = null;
    #offering = Promise.resolve();
    #loading = new WeakMap();
    #pointerSequence = 0;
    #capturing = new Map();
    #applied = null;
    /** The page size and zoom last applied, which viewers map their input with. */
    #shown = null;
    #emulated = false;
    #applying = Promise.resolve();
    #hold;
    constructor(host) {
        this.host = host;
        this.#hold = new ViewerHold(host, this.viewers, () => this.broadcastControl());
    }
    handBack() { return this.#hold.handBack(); }
    get size() {
        return this.viewers.size;
    }
    /** Someone watching could answer a site's HTTP sign-in. */
    answersAuth() {
        return [...this.viewers].some((viewer) => viewer.options.canOperate && viewer.options.authPrompts);
    }
    /** The page size now: the setting's, or in fill mode the size the latest viewer still watching asked for, within the screen. */
    viewport() {
        const latest = [...this.viewers].map((viewer) => viewer.requested).filter((size) => size !== null).sort((a, b) => b.order - a.order)[0] ?? null;
        return viewportFor(this.setting, latest ? { width: latest.width, height: latest.height } : null, this.host.pageLimit());
    }
    /** Resizes the real window; a zoom, or a page narrower than any Chrome window or larger than the screen, is emulated, as DevTools' device mode does. */
    applyViewport() {
        this.#applying = this.#applying.then(() => this.#apply(), () => this.#apply());
        return this.#applying;
    }
    async #apply() {
        const browser = this.host.browser();
        if (!browser)
            return;
        const size = this.viewport();
        const zoom = this.zoom;
        const emulated = size.width < MIN_WINDOW_WIDTH || zoom !== 1 || !fitsScreen(size, this.host.pageLimit());
        const key = appliedKey(size, zoom);
        const active = this.host.active();
        if (this.#applied === key && browser.viewport?.width === Math.max(size.width, MIN_WINDOW_WIDTH))
            return;
        this.#applied = key;
        // The window is fitted by measuring the page, which an emulated size would misreport.
        if (this.#emulated) {
            for (const tab of this.host.tabs())
                await tab.page.emulateSize(null).catch(() => { });
            this.#emulated = false;
        }
        const fitted = await browser.setViewport({ width: Math.max(size.width, MIN_WINDOW_WIDTH), height: size.height }).catch(() => null);
        const layout = zoomedLayout(size, zoom);
        if (emulated) {
            for (const tab of this.host.tabs())
                await tab.page.emulateSize(layout, zoom).catch(() => { });
            this.#emulated = true;
        }
        // Chrome's first tab carries a bar the others lack, so a window held to its screen can give it a shorter page.
        this.#shown = { ...(emulated || !fitted ? layout : fitted), zoom };
        if (active)
            this.broadcast({ type: "viewport", ...this.#shown, setting: this.setting });
        this.broadcastStatus();
        for (const viewer of this.viewers)
            viewer.refreshSoon();
    }
    /** A zoom, or a page narrower than any window, is emulated tab by tab, so a tab that opens takes the one applied. */
    #emulateTabs() {
        const emulate = async () => {
            const shown = this.#shown;
            if (!this.#emulated || !shown)
                return;
            for (const tab of this.host.tabs())
                await tab.page.emulateSize(shown, shown.zoom).catch(() => { });
            this.broadcast({ type: "viewport", ...shown, setting: this.setting });
            for (const viewer of this.viewers)
                viewer.refreshSoon();
        };
        this.#applying = this.#applying.then(emulate, emulate);
        return this.#applying;
    }
    /** A size or zoom a viewer asks for waits for the action running on the tab in front: a bot's click aims at the page as it was laid out. */
    #resizeForViewers() {
        const tab = this.host.active();
        if (!tab || this.#applied === appliedKey(this.viewport(), this.zoom))
            return this.applyViewport();
        return Promise.resolve().then(() => tab.control.system(() => this.applyViewport())).catch(() => this.applyViewport());
    }
    /** A tab came to the front or opened: its window takes the current size. */
    async fit() {
        this.#applied = null;
        await this.applyViewport();
    }
    async attach(options, push) {
        const viewer = new Viewer(this, options, push);
        const size = options.size ? requestedSize(options.size.width, options.size.height) : null;
        if (size && options.canOperate && this.host.control.owner === null)
            viewer.requested = { ...size, order: ++this.#order };
        this.viewers.add(viewer);
        this.host.used();
        this.#hold.opened(viewer);
        try {
            viewer.push({ type: "starting" });
            await this.host.running();
            if (viewer.closed)
                return viewer;
            await this.#hold.carryOn(viewer);
            await viewer.hide(this.#hold.hides(viewer));
            void this.#resizeForViewers().catch(() => undefined);
            viewer.push(this.controlFor(viewer));
            viewer.push({ type: "viewport", ...(this.#shown ?? { ...zoomedLayout(this.viewport(), this.zoom), zoom: this.zoom }), setting: this.setting });
            this.pushTabs(viewer);
            viewer.push(this.statusFor());
            await viewer.bind(this.host.active());
            const active = this.host.active();
            if (active)
                this.navChanged(active);
            return viewer;
        }
        catch (error) {
            await this.detach(viewer);
            throw error;
        }
    }
    async detach(viewer, { dropped = false } = {}) {
        if (!this.viewers.has(viewer))
            return;
        this.viewers.delete(viewer);
        await this.#hold.left(viewer, dropped);
        await viewer.teardown();
        this.broadcastControl();
        if (viewer.requested)
            void this.#resizeForViewers().catch(() => undefined);
    }
    broadcast(output, { holderOnly = false } = {}) {
        for (const viewer of this.viewers) {
            if (holderOnly && !this.#hold.drives(viewer))
                continue;
            if (!holderOnly && this.#hold.hides(viewer) && (output.type === "tabs" || output.type === "url" || output.type === "nav" || output.type === "pointer"))
                continue;
            viewer.push(output);
        }
    }
    controlFor(viewer) {
        const control = this.host.control;
        const owner = control.owner;
        const owned = this.#hold.owns(viewer);
        const controlling = this.#hold.controls(viewer);
        // Security: a dialog's text can be a code meant for the person holding the browser.
        const dialog = owner === null || owned ? this.host.active()?.page.dialogs.pending ?? null : null;
        return {
            type: "control",
            canOperate: viewer.options.canOperate,
            // "you" means this viewer's input runs now: while a takeover waits for the bot's work, the bot still has it.
            controller: controlling ? "you" : owned ? "agent" : owner !== null ? "another-viewer" : control.agents > 0 ? "agent" : "unclaimed",
            held: owner !== null,
            owned,
            controlling,
            stale: control.stale,
            generation: this.host.active()?.control.generation ?? 0,
            dialog: dialog ? { type: dialog.type, message: dialog.message, defaultValue: dialog.defaultPrompt } : null,
        };
    }
    broadcastControl() {
        for (const viewer of this.viewers) {
            void viewer.hide(this.#hold.hides(viewer));
            viewer.push(this.controlFor(viewer));
        }
        void this.offerFileChooser();
        this.offerAuthPrompt();
    }
    /** The newest HTTP sign-in a tab waits on goes to the person holding the browser, named by tab and challenge, so their answer reaches that one only. */
    offerAuthPrompt() {
        const holder = this.#hold.driver?.options.authPrompts ? this.#hold.driver : undefined;
        const asking = holder ? newestChallenge(this.host.tabs()) : null;
        const offered = this.#authOffered;
        if (offered && offered.viewer === holder && offered.id === asking?.challenge.id)
            return;
        if (offered)
            offered.viewer.push({ type: "authPromptClosed", id: offered.id });
        this.#authOffered = holder && asking ? { viewer: holder, id: asking.challenge.id } : null;
        if (holder && asking)
            holder.push({ type: "authPrompt", tabId: asking.tab.id, id: asking.challenge.id, origin: asking.challenge.origin, realm: asking.challenge.realm });
    }
    /** The page's open file picker goes to the person holding the browser, under an id that changes whenever they do. */
    offerFileChooser() {
        this.#offering = this.#offering.then(() => this.#offer(), () => this.#offer());
        return this.#offering;
    }
    async #offer() {
        const holder = this.#hold.driver;
        const tab = this.host.active();
        const open = tab?.page.fileChoosers.open ?? null;
        const offered = this.#chooser;
        if (offered && offered.viewer === holder && offered.tab === tab && offered.open === open)
            return;
        if (offered) {
            this.#chooser = null;
            offered.viewer.push({ type: "fileChooserClosed", id: offered.id });
        }
        if (!holder || !tab || !open)
            return;
        const accept = await callOnNode(tab.page.frames, open, ACCEPT_OF).catch(() => "");
        // Whatever changed meanwhile queued its own offer.
        if (tab.page.fileChoosers.open !== open || this.#hold.driver !== holder || this.#chooser)
            return;
        const chooser = { id: randomUUID(), tab, viewer: holder, open };
        this.#chooser = chooser;
        holder.push({ type: "fileChooser", id: chooser.id, multiple: open.multiple, accept: typeof accept === "string" ? accept : "" });
    }
    /** Whether the page's open picker was offered to `owner` as `id`. */
    fileChooserOffered(owner, id) {
        const chooser = this.#chooser;
        return chooser !== null && chooser.id === id && chooser.viewer.options.owner === owner && chooser.tab.page.fileChoosers.open === chooser.open;
    }
    /** The holder's files for the picker it was offered; false when that picker is no longer open, or is not theirs. */
    async answerFileChooser(owner, id, paths) {
        const chooser = this.#chooser;
        if (!chooser || !this.fileChooserOffered(owner, id))
            return false;
        this.#hold.used();
        await this.host.control.human(chooser.viewer.options.person, chooser.tab, () => chooser.tab.page.fileChoosers.answer(paths, { waitMs: 0 }));
        return true;
    }
    tabsMessage() {
        const active = this.host.active();
        return { type: "tabs", tabs: this.host.tabs().slice(0, 100).map((tab) => ({ tabId: tab.id, title: tab.page.title().slice(0, 512), url: tab.page.url(), active: tab === active })) };
    }
    pushTabs(viewer) {
        if (this.#hold.hides(viewer))
            return;
        viewer.push(this.tabsMessage());
        const active = this.host.active();
        if (active)
            viewer.push({ type: "url", url: active.page.url() });
    }
    statusFor() {
        const browser = this.host.browser();
        const size = browser?.viewport ?? this.viewport();
        return { type: "status", connected: browser !== null && browser.connected, screencasting: this.viewers.size > 0, viewportWidth: size.width, viewportHeight: size.height };
    }
    broadcastStatus() {
        this.broadcast(this.statusFor());
    }
    /** The tab in front, or the tabs, changed. A zoom, or a page narrower than any window, is emulated on every tab, new ones too. */
    tabsChanged() {
        const active = this.host.active();
        this.broadcast(this.tabsMessage());
        if (active)
            this.broadcast({ type: "url", url: active.page.url() });
        for (const viewer of this.viewers)
            void viewer.bind(active);
        if (this.#emulated)
            void this.#emulateTabs().catch(() => undefined);
        if (active)
            this.navChanged(active);
        void this.offerFileChooser();
        this.offerAuthPrompt();
    }
    loading(tab, loading) {
        this.#loading.set(tab, loading);
        this.navChanged(tab);
    }
    /** The address bar of the tab in front: where it is, whether it loads, and where its history goes. */
    navChanged(tab) {
        if (tab !== this.host.active() || !this.viewers.size)
            return;
        void tab.page.session.send("Page.getNavigationHistory").then((history) => {
            if (tab !== this.host.active())
                return;
            this.broadcast({
                type: "nav", tabId: tab.id, url: tab.page.url(), loading: this.#loading.get(tab) === true,
                canGoBack: history.currentIndex > 0, canGoForward: history.currentIndex < history.entries.length - 1,
            });
        }, () => undefined);
    }
    titlesChanged() {
        this.broadcast(this.tabsMessage());
    }
    urlChanged(tab) {
        if (tab !== this.host.active())
            return;
        this.broadcast({ type: "url", url: tab.page.url() });
        this.broadcast(this.tabsMessage());
        this.navChanged(tab);
    }
    started() {
        this.#applied = null;
        this.broadcast({ type: "awake" });
        void this.applyViewport().then(() => this.tabsChanged()).catch(() => undefined);
    }
    stopped(reason) {
        this.#applied = null;
        for (const viewer of this.viewers) {
            void viewer.bind(null);
            viewer.push(reason === "asleep" ? { type: "asleep" } : { type: "gone", reason });
        }
    }
    downloaded(download) {
        if (download.state !== "completed")
            return;
        this.broadcast({ type: "download", id: download.id, fileName: download.fileName, sizeBytes: download.receivedBytes }, { holderOnly: true });
    }
    popup(tab) {
        this.broadcast({ type: "popup", tabId: tab.id }, { holderOnly: true });
    }
    /** The agent's pointer glides to where it acts and pulses before a press, for people watching the tab who can see it. */
    pointer(tab) {
        const drawing = () => [...this.viewers].filter((viewer) => viewer.tab === tab && viewer.options.pointer);
        if (drawing().length === 0)
            return undefined;
        return async ({ x, y }, phase) => {
            const show = (next) => {
                const sequence = ++this.#pointerSequence;
                for (const viewer of drawing())
                    viewer.push({ type: "pointer", phase: next, x, y, sequence });
            };
            show("move");
            await sleep(AGENT_CURSOR_MOVE_MS);
            if (phase !== "click")
                return;
            show("click");
            await sleep(AGENT_CURSOR_CLICK_LEAD_MS);
        };
    }
    /**
     * Scaled captures repaint every screencast of the tab, so those pause until it is done. Chrome draws one by changing
     * the page's emulation and then restoring what it found when it began (155), which would undo a zoom or a narrow page
     * applied meanwhile: captures and size changes take turns.
     */
    paused(tab, work) {
        const turn = this.#applying.then(() => this.#pausing(tab, work), () => this.#pausing(tab, work));
        this.#applying = turn.then(() => undefined, () => undefined);
        return turn;
    }
    async #pausing(tab, work) {
        const watching = [...this.viewers].filter((viewer) => viewer.tab === tab);
        this.#capturing.set(tab, (this.#capturing.get(tab) ?? 0) + 1);
        await Promise.all(watching.map((viewer) => viewer.pause()));
        try {
            return await work();
        }
        finally {
            this.#capturing.set(tab, (this.#capturing.get(tab) ?? 1) - 1);
            await Promise.all(watching.map((viewer) => viewer.resume()));
        }
    }
    async input(viewer, message) {
        const control = this.host.control;
        if (message.type !== "resize" && message.type !== "frameCap")
            this.host.used();
        switch (message.type) {
            case "wake":
                await this.host.running().catch(() => viewer.push({ type: "asleep" }));
                return;
            case "takeControl": {
                const taking = this.host.take(viewer.options.person);
                this.broadcastControl();
                await taking.then(() => this.#hold.took(viewer)).finally(() => this.broadcastControl());
                return;
            }
            case "releaseControl": {
                const releasing = this.#hold.release(viewer);
                this.broadcastControl();
                await releasing.finally(() => this.broadcastControl());
                return;
            }
            case "resize": {
                const size = requestedSize(message.width, message.height);
                if (!size || (control.owner !== null && !this.#hold.drives(viewer)))
                    return;
                viewer.requested = { ...size, order: ++this.#order };
                if (this.setting.mode === "fill")
                    await this.#resizeForViewers();
                return;
            }
            case "viewport": {
                if (!this.#hold.controls(viewer))
                    return;
                const setting = parseSetting(message.setting);
                if (!setting)
                    return;
                this.setting = setting;
                await this.#resizeForViewers();
                return;
            }
            case "zoom": {
                const factor = num(message.factor, 0);
                if (!this.#hold.controls(viewer) || !(factor > 0))
                    return;
                this.zoom = Math.round(Math.min(ZOOM_LIMITS.max, Math.max(ZOOM_LIMITS.min, factor)) * 100) / 100;
                await this.#resizeForViewers();
                return;
            }
            case "frameCap":
                await viewer.setFrameCap(message.maxWidth, message.maxHeight);
                return;
        }
        const tab = this.host.active();
        if (!tab || !this.#hold.controls(viewer)) {
            this.broadcastControl();
            return;
        }
        this.#hold.used();
        switch (message.type) {
            case "dialog":
                if (typeof message.accept === "boolean")
                    await tab.page.answerDialog({ accept: message.accept, ...(typeof message.promptText === "string" ? { promptText: message.promptText.slice(0, 4_000) } : {}) });
                this.broadcastControl();
                return;
            case "authAnswer": {
                // Security: what the person typed goes only to the challenge they were shown, and only while it is still open.
                const asking = typeof message.tabId === "string" ? this.host.tab(message.tabId) : undefined;
                if (!asking || asking.page.auth.pending?.id !== message.id) {
                    this.#authOffered = null;
                    this.offerAuthPrompt();
                    return;
                }
                if (typeof message.username === "string" && typeof message.password === "string")
                    await asking.page.auth.answer({ username: message.username.slice(0, 1_024), password: message.password.slice(0, 1_024) });
                else
                    await asking.page.auth.answer(null);
                return;
            }
            case "tabSelect": {
                const next = typeof message.tabId === "string" ? this.host.tab(message.tabId) : undefined;
                if (next)
                    await control.human(viewer.options.person, next, () => this.host.showTab(next));
                return;
            }
            case "tabNew":
                await this.host.openTab(typeof message.url === "string" ? message.url : null, viewer.options.person);
                return;
            case "tabClose": {
                const closing = typeof message.tabId === "string" ? this.host.tab(message.tabId) : undefined;
                if (closing)
                    await this.host.closeTab(closing);
                return;
            }
            case "selectChoose": {
                const select = viewer.select;
                viewer.select = null;
                const index = num(message.index, -1);
                if (!select || select.id !== message.id || select.tab !== tab || !Number.isInteger(index) || index < 0)
                    return;
                await control.human(viewer.options.person, tab, () => chooseOption(tab.page, select.id, index));
                return;
            }
        }
        await control.human(viewer.options.person, tab, () => this.#dispatch(viewer, tab, message));
    }
    /** A press on a dropdown list: the viewer draws its options, since no frame shows Chrome's own popup. */
    async #openSelect(viewer, tab, x, y) {
        const id = randomUUID();
        const popup = await selectAt(tab.page, x, y, id).catch(() => null);
        if (!popup)
            return false;
        viewer.select = { id, tab };
        viewer.push({ type: "selectPopup", id, ...popup });
        return true;
    }
    async #cursor(viewer, tab, x, y) {
        const now = Date.now();
        if (now - viewer.cursorAt < CURSOR_EVERY_MS)
            return;
        viewer.cursorAt = now;
        const shape = await cursorAt(tab.page, x, y).catch(() => null);
        if (shape === null || shape === viewer.cursor || viewer.tab !== tab)
            return;
        viewer.cursor = shape;
        viewer.push({ type: "cursor", shape });
    }
    async #dispatch(viewer, tab, message) {
        const session = viewer.session;
        if (!session || session.detached || viewer.tab !== tab)
            return;
        const modifiers = modifiersOf(message);
        switch (message.type) {
            case "mouse": {
                const action = message.action;
                const type = action === "down" ? "mousePressed" : action === "up" ? "mouseReleased" : "mouseMoved";
                const button = ["none", "left", "middle", "right"].find((candidate) => candidate === message.button) ?? "none";
                const x = num(message.x);
                const y = num(message.y);
                if (type === "mousePressed" && button !== "none" && viewer.pressedButtons.size >= HELD_LIMIT)
                    return;
                if (type === "mouseReleased" && viewer.swallowed.delete(button))
                    return;
                if (type === "mousePressed" && button === "left" && viewer.options.pagePopups && num(message.clickCount, 1) <= 1 && await this.#openSelect(viewer, tab, x, y)) {
                    viewer.swallowed.add(button);
                    return;
                }
                if (type === "mouseMoved" && button === "none" && viewer.options.pagePopups)
                    void this.#cursor(viewer, tab, x, y);
                await session.send("Input.dispatchMouseEvent", {
                    type, x, y, button,
                    buttons: num(message.buttons, [...viewer.pressedButtons.keys()].reduce((bits, held) => bits | (held === "left" ? 1 : held === "right" ? 2 : 4), 0)),
                    clickCount: num(message.clickCount, type === "mouseMoved" ? 0 : 1),
                    modifiers,
                });
                if (button !== "none") {
                    if (action === "down")
                        viewer.pressedButtons.set(button, { x, y });
                    else if (action === "up")
                        viewer.pressedButtons.delete(button);
                }
                return;
            }
            case "wheel":
                viewer.scrolledAt = Date.now();
                await session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: num(message.x), y: num(message.y), deltaX: num(message.deltaX), deltaY: num(message.deltaY), modifiers });
                return;
            case "key": {
                const key = typeof message.key === "string" ? message.key.slice(0, 64) : "";
                const code = typeof message.code === "string" ? message.code.slice(0, 64) : "";
                if (!key && !code)
                    return;
                if (message.action === "up") {
                    await session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
                    viewer.pressedKeys.delete(code || key);
                    return;
                }
                if (viewer.pressedKeys.size >= HELD_LIMIT && !viewer.pressedKeys.has(code || key))
                    return;
                const named = US_KEYBOARD[code] ?? US_KEYBOARD[key];
                const layout = named ? keyDescription(US_KEYBOARD[code] ? code : key, modifiers) : null;
                const text = typeof message.text === "string" ? message.text.slice(0, 16) : layout?.text || undefined;
                const commands = editingCommands(key, modifiers, this.host.browser()?.mac ?? process.platform === "darwin");
                const copying = commands[0] === "copy" || commands[0] === "cut";
                if (copying)
                    await tab.page.takeCopiedText();
                await session.send("Input.dispatchKeyEvent", {
                    type: text ? "keyDown" : "rawKeyDown",
                    key, code, modifiers,
                    ...(text ? { text, unmodifiedText: text } : {}),
                    ...(commands.length ? { commands } : {}),
                    windowsVirtualKeyCode: num(message.keyCode, layout?.keyCode ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0)),
                });
                viewer.pressedKeys.set(code || key, { key, code });
                if (copying) {
                    const copied = await tab.page.takeCopiedText();
                    if (copied)
                        viewer.push({ type: "clipboard", text: copied });
                }
                return;
            }
            case "text":
                if (typeof message.text === "string" && message.text.length > 0)
                    await session.send("Input.insertText", { text: message.text.slice(0, TEXT_LIMIT) });
                return;
            case "navigate": {
                const url = typeof message.url === "string" ? personUrl(message.url) : null;
                if (url)
                    await tab.page.navigate(url, { readiness: "none", timeoutMs: 15_000 });
                return;
            }
            case "extensions":
            case "openExtension": return extensionInput(message, this.host.extensions(), viewer, tab.page);
            case "history":
                await (num(message.delta) < 0 ? tab.page.back({ readiness: "none" }) : tab.page.forward({ readiness: "none" }));
                return;
            case "reload":
                if (message.ignoreCache === true)
                    await tab.page.session.send("Page.reload", { ignoreCache: true });
                else
                    await tab.page.reload({ readiness: "none" });
                return;
            case "probe": {
                const x = num(message.x);
                const y = num(message.y);
                viewer.push({ type: "probe", x, y, editable: await editableAt(tab.page, x, y).catch(() => false) });
                return;
            }
        }
    }
}
const newestChallenge = (tabs) => tabs.reduce((newest, tab) => {
    const challenge = tab.page.auth.pending;
    return challenge && (!newest || challenge.since >= newest.challenge.since) ? { tab, challenge } : newest;
}, null);
function parseSetting(value) {
    const setting = record(value);
    if (!setting)
        return null;
    if (setting.mode === "fill")
        return { mode: "fill" };
    if (setting.mode === "preset" && typeof setting.preset === "string" && setting.preset in VIEWPORT_PRESETS) {
        return { mode: "preset", preset: setting.preset, ...(setting.landscape === true ? { landscape: true } : {}) };
    }
    if (setting.mode === "fixed") {
        const size = requestedSize(setting.width, setting.height);
        return size ? { mode: "fixed", ...size } : null;
    }
    return null;
}
