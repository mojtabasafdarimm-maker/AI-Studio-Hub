import { setTimeout as delay } from "node:timers/promises";
import { elementPath, treeDegraded, wholeTree } from "./driver-wire.js";
import { KEY_TOOLS, holdsTypedText } from "./rules.js";
const APP = { required: { pid: "number", name: "string" }, optional: { bundle_id: "string", running: "boolean" } };
const WINDOW = { required: { window_id: "number", pid: "number", title: "string" }, optional: {}, id: "window_id" };
const ELEMENT = {
    required: { element_index: "number", role: "string", depth: "number" },
    optional: { element_token: "string", label: "string", parent_index: "number" },
    id: "element_index",
};
const NONE = { ok: false, reason: "none" };
const AMBIGUOUS = { ok: false, reason: "ambiguous" };
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
function readEntry(item, shape) {
    if (!isRecord(item))
        return null;
    const entry = {};
    for (const [key, kind] of Object.entries(shape.required)) {
        if (typeof item[key] !== kind)
            return null;
        entry[key] = item[key];
    }
    for (const [key, kind] of Object.entries(shape.optional)) {
        const value = item[key];
        if (value === undefined || value === null)
            continue;
        if (typeof value !== kind)
            return null;
        entry[key] = value;
    }
    return entry;
}
// Safety invariant: one unreadable entry or one repeated id makes the whole list unreadable.
// Skipping either could hide the second match that makes a target ambiguous.
function readList(value, shape) {
    if (!Array.isArray(value))
        return null;
    const entries = [];
    const ids = new Set();
    for (const item of value) {
        const entry = readEntry(item, shape);
        if (entry === null)
            return null;
        if (shape.id !== undefined) {
            if (ids.has(entry[shape.id]))
                return null;
            ids.add(entry[shape.id]);
        }
        entries.push(entry);
    }
    return entries;
}
function only(candidates) {
    const [first, ...rest] = candidates;
    if (first === undefined)
        return NONE;
    return rest.length ? AMBIGUOUS : { ok: true, value: first };
}
export function matchApp(apps, app) {
    const list = readList(apps, APP);
    const sameApp = app.bundleId ? (live) => live.bundle_id === app.bundleId : app.name ? (live) => live.name === app.name : null;
    if (!list || !sameApp)
        return NONE;
    return only(list.filter((live) => live.pid > 0 && live.running !== false && sameApp(live)).map((live) => live.pid));
}
export function matchWindow(windows, pid, window) {
    const list = readList(windows, WINDOW);
    if (!list)
        return NONE;
    return only(list.filter((live) => live.pid === pid && live.title === window.title).map((live) => live.window_id));
}
const samePath = (path, saved) => path.length === saved.length && path.every((part, index) => part === saved[index]);
export function matchElement(elements, element) {
    const list = readList(elements, ELEMENT);
    if (!list)
        return NONE;
    const candidates = list
        .filter((live) => live.role === element.role && live.label === element.label)
        .map((live) => ({ live, path: elementPath(list, live) }))
        .filter(({ path }) => path === null || samePath(path, element.path));
    const match = only(candidates);
    if (!match.ok)
        return match;
    return match.value.path === null ? NONE : { ok: true, value: match.value.live };
}
function heldValue(elements, index) {
    const live = Array.isArray(elements) ? elements.find((item) => isRecord(item) && item.element_index === index) : undefined;
    return isRecord(live) && typeof live.value === "string" ? live.value : undefined;
}
const appName = (app) => app.name || app.bundleId || "the app";
const fail = (error) => ({ ok: false, error });
const missing = (error) => ({ ok: false, error, missing: true });
export const RETRY_MS = 3_000;
export const POLL_MS = 250;
const REAL_TIME = { now: Date.now, sleep: (ms, signal) => delay(ms, undefined, { signal }).catch(() => { }) };
export async function resolveStepSoon(step, caller, signal, patience = REAL_TIME) {
    const deadline = patience.now() + RETRY_MS;
    for (;;) {
        const target = await resolveStep(step, caller, signal);
        if (target.ok || !target.missing || signal.aborted || patience.now() + POLL_MS > deadline)
            return target;
        await patience.sleep(POLL_MS, signal);
    }
}
export async function resolveStep(step, caller, signal) {
    const { app, window, element } = step;
    if (step.tool === "launch_app")
        return { ok: true, args: step.args };
    if (!app)
        return fail("the saved step does not name its app");
    if ((element || KEY_TOOLS.has(step.tool)) && !window)
        return fail("the saved step does not name its window");
    const name = appName(app);
    const apps = await caller.call("list_apps", {}, signal);
    if (!apps.ok)
        return apps;
    const pid = matchApp(apps.structured.apps, app);
    if (!pid.ok)
        return pid.reason === "none" ? missing(`${name} is not running`) : fail(`more than one ${name} app is running`);
    const args = { ...step.args, pid: pid.value };
    if (!window)
        return { ok: true, args };
    const windows = await caller.call("list_windows", { pid: pid.value, on_screen_only: false }, signal);
    if (!windows.ok)
        return windows;
    const windowId = matchWindow(windows.structured.windows, pid.value, window);
    if (!windowId.ok)
        return windowId.reason === "none" ? missing(`no window titled "${window.title}"`) : fail(`more than one window titled "${window.title}"`);
    args.window_id = windowId.value;
    if (!element)
        return { ok: true, args };
    const state = await caller.call("get_window_state", { pid: pid.value, window_id: windowId.value, include_screenshot: false }, signal);
    if (!state.ok)
        return state;
    const tree = state.structured;
    if (tree.pid !== pid.value || tree.window_id !== windowId.value)
        return fail("the computer answered for a different window");
    if (treeDegraded(tree))
        return fail(`${window.title} could not be read reliably`);
    if (!wholeTree(tree))
        return fail(`only part of ${window.title} could be read`);
    const found = matchElement(tree.elements, element);
    const target = `"${element.label}" (${element.role}) in ${window.title}`;
    if (!found.ok)
        return found.reason === "none" ? missing(`no ${target}`) : fail(`more than one ${target}`);
    const { element_token: token, element_index: index } = found.value;
    // cua-driver 0.41 acts on an element only through its element_token; an index is no longer an address it accepts.
    if (token === undefined)
        return fail(`${target} has no element token to act on`);
    // Safety invariant: set_value replaces what a field holds, and a repeat never replaces someone's text.
    if (step.tool === "set_value" && holdsTypedText(element.role)) {
        const held = heldValue(tree.elements, index);
        if (held === undefined)
            return fail(`could not read what ${target} holds`);
        if (held !== "" && held !== step.args.value)
            return fail(`${target} already holds other text`);
    }
    return { ok: true, args: { ...args, element_token: token } };
}
