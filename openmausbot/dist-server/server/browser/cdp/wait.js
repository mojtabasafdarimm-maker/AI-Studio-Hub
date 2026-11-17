// Polling every 100 ms until every condition holds, and the timeout message,
// follow T3 Code's apps/server/src/preview/ServerBrowserPage.ts (waitFor),
// Copyright 2026 T3 Tools Inc., used under the MIT License
// (third_party/t3-code/LICENSE).
import { DriverError } from "./errors.js";
import { callOnNode, valueInWorld } from "./evaluate.js";
import { parseRef } from "./refs.js";
import { countSelector } from "./selectors.js";
export const MAX_WAIT_MS = 60_000;
export const DEFAULT_WAIT_MS = 15_000;
const POLL_MS = 100;
const EVENT_FOR = { load: "load", domcontentloaded: "DOMContentLoaded", networkidle: "networkIdle" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The main frame's current document and the lifecycle events it has reached. */
export class Lifecycle {
    #mainFrameId;
    #listeners = new Set();
    #loaderId = null;
    #reached = new Set();
    constructor(session, mainFrameId) {
        this.#mainFrameId = mainFrameId;
        session.on("Page.lifecycleEvent", (params) => this.#event(params));
        session.on("Page.frameNavigated", (params) => {
            const frame = params.frame;
            if (frame?.id !== this.#mainFrameId || !frame.loaderId)
                return;
            if (frame.loaderId !== this.#loaderId)
                this.#reset(frame.loaderId);
            // A page restored from the back-forward cache fires no lifecycle events: it loaded long ago.
            if (params.type === "BackForwardCacheRestore")
                for (const name of Object.values(EVENT_FOR))
                    this.#reached.add(name);
            this.#notify();
        });
    }
    get loaderId() {
        return this.#loaderId;
    }
    reached(state, loaderId = this.#loaderId) {
        return loaderId !== null && loaderId === this.#loaderId && this.#reached.has(EVENT_FOR[state]);
    }
    /** Waits for `state` in the document `loaderId` (by default whichever document is current). */
    waitFor(state, { loaderId, timeoutMs }) {
        const done = () => this.reached(state, loaderId ?? this.#loaderId);
        if (done())
            return Promise.resolve();
        return new Promise((resolve, reject) => {
            const listener = () => {
                if (!done())
                    return;
                this.#listeners.delete(listener);
                clearTimeout(timer);
                resolve();
            };
            this.#listeners.add(listener);
            const timer = setTimeout(() => {
                this.#listeners.delete(listener);
                reject(new DriverError("timeout", `The page did not reach ${state} within ${timeoutMs} ms; it may still be loading.`));
            }, timeoutMs);
        });
    }
    /** The id of the next document the main frame commits. */
    nextDocument(timeoutMs) {
        const before = this.#loaderId;
        return new Promise((resolve, reject) => {
            const listener = () => {
                if (this.#loaderId === null || this.#loaderId === before)
                    return;
                this.#listeners.delete(listener);
                clearTimeout(timer);
                resolve(this.#loaderId);
            };
            this.#listeners.add(listener);
            const timer = setTimeout(() => {
                this.#listeners.delete(listener);
                reject(new DriverError("timeout", `The page did not start loading within ${timeoutMs} ms.`));
            }, timeoutMs);
        });
    }
    /** A document that was already loaded when the driver attached: its lifecycle events went by unseen. */
    adopt(loaderId, loaded) {
        if (this.#loaderId !== null)
            return;
        this.#reset(loaderId);
        if (loaded)
            for (const name of ["DOMContentLoaded", "load"])
                this.#reached.add(name);
        this.#notify();
    }
    #event(params) {
        if (params.frameId !== this.#mainFrameId)
            return;
        const loaderId = String(params.loaderId ?? "");
        const name = String(params.name ?? "");
        if (name === "init" || this.#loaderId === null)
            this.#reset(loaderId);
        if (loaderId !== this.#loaderId)
            return;
        this.#reached.add(name);
        this.#notify();
    }
    #reset(loaderId) {
        this.#loaderId = loaderId;
        this.#reached = new Set();
    }
    #notify() {
        for (const listener of this.#listeners)
            listener();
    }
}
const CONNECTED = "function () { return this.isConnected && (!this.checkVisibility || this.checkVisibility()); }";
async function elementPresent(context, target) {
    const ref = target.ref ?? (target.selector !== undefined ? parseRef(target.selector) : null);
    if (ref) {
        try {
            return await callOnNode(context.frames, context.refs.resolve(ref), CONNECTED);
        }
        catch (error) {
            if (error instanceof DriverError && error.code === "stale-ref")
                throw error;
            return false;
        }
    }
    if (target.selector === undefined)
        throw new DriverError("invalid-selector", "Name the element with a ref or a selector.");
    try {
        return (await countSelector(context.frames, target.selector)) > 0;
    }
    catch (error) {
        if (error instanceof DriverError && error.code === "invalid-selector")
            throw error;
        return false;
    }
}
/** Every condition at once, checked every 100 ms; a navigation in between counts as not yet. */
export async function waitFor(context, conditions) {
    const timeoutMs = Math.min(Math.max(0, conditions.timeoutMs ?? DEFAULT_WAIT_MS), MAX_WAIT_MS);
    const started = Date.now();
    const checks = [];
    const { text, target, urlIncludes, load } = conditions;
    if (text !== undefined) {
        checks.push(() => valueInWorld(context.frames, context.frames.mainFrameId, `(document.body ? document.body.innerText : "").includes(${JSON.stringify(text)})`).then((found) => found === true, () => false));
    }
    if (target !== undefined) {
        const wantGone = conditions.gone === true;
        checks.push(async () => (await elementPresent(context, target)) !== wantGone);
    }
    if (urlIncludes !== undefined)
        checks.push(async () => context.url().includes(urlIncludes));
    if (load !== undefined)
        checks.push(async () => context.lifecycle.reached(load));
    if (conditions.ms !== undefined) {
        const ms = Math.min(Math.max(0, conditions.ms), MAX_WAIT_MS);
        if (ms > timeoutMs && checks.length)
            throw new DriverError("refused", `The wait of ${ms} ms is longer than its ${timeoutMs} ms timeout.`);
        await sleep(ms);
    }
    if (!checks.length)
        return;
    for (;;) {
        const results = await Promise.all(checks.map((check) => check()));
        if (results.every(Boolean))
            return;
        if (Date.now() - started >= timeoutMs)
            throw new DriverError("timeout", `Waited ${timeoutMs}ms without every condition holding.`);
        await sleep(POLL_MS);
    }
}
