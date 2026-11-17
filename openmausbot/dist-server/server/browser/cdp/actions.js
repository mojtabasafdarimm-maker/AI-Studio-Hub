// Actionability, the editable-field rule, select's value-then-label matching
// and the messages follow T3 Code's apps/server/src/preview/ServerBrowserPage.ts,
// Copyright 2026 T3 Tools Inc., used under the MIT License
// (third_party/t3-code/LICENSE).
import { DriverError, isGone, messageOf } from "./errors.js";
import { callOnNode, resolveInWorld, valueInWorld } from "./evaluate.js";
import { resolveElement } from "./selectors.js";
export const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
const POLL_MS = 100;
export const MAX_TYPED_KEYS = 500;
const DRAG_LEAD_PX = 12;
const isPoint = (target) => "x" in target && "y" in target;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function element(context, target) {
    return resolveElement(context.frames, context.refs, target);
}
function gone(handle) {
    if (handle.ref) {
        return new DriverError("stale-ref", `The element ${handle.ref} is no longer on the page. Take a fresh snapshot and use its ref.`, { staleRef: true, ref: handle.ref });
    }
    return new DriverError("not-found", "The element is no longer on the page.");
}
function refuseErrorPage(context) {
    const url = context.frames.main?.url ?? "";
    if (url.startsWith("chrome-error://")) {
        throw new DriverError("refused", "This tab shows the browser's own error or warning page. A person has to decide on it; navigate elsewhere to continue.");
    }
}
function center(quad) {
    return { x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4 };
}
function area(quad) {
    let sum = 0;
    for (let i = 0; i < 8; i += 2)
        sum += quad[i] * quad[(i + 3) % 8] - quad[(i + 2) % 8] * quad[i + 1];
    return Math.abs(sum) / 2;
}
async function quads(handle) {
    try {
        const { quads: found } = await handle.session.send("DOM.getContentQuads", { backendNodeId: handle.backendNodeId });
        return found.filter((quad) => area(quad) > 0.99);
    }
    catch (error) {
        if (/layout object|Could not compute content quads/i.test(messageOf(error)))
            return [];
        throw error;
    }
}
const sameQuads = (a, b) => a.length === b.length && a.every((quad, i) => quad.every((value, j) => Math.abs(value - b[i][j]) < 0.5));
const NEXT_FRAME = "new Promise((resolve) => { requestAnimationFrame(() => resolve(1)); setTimeout(() => resolve(0), 50); })";
const RECEIVES = `function (hit, wantEnabled) {
  const disabled = wantEnabled && (this.disabled === true || this.closest?.("fieldset[disabled]") != null || this.getAttribute?.("aria-disabled") === "true");
  if (disabled) return { disabled: true, covering: null };
  if (!hit) return { disabled: false, covering: null };
  for (let node = hit; node; node = node.parentNode || node.host) if (node === this) return { disabled: false, covering: null };
  const element = hit.nodeType === 1 ? hit : hit.parentElement;
  if (!element) return { disabled: false, covering: "another element" };
  const id = element.id ? "#" + element.id : "";
  const classes = typeof element.className === "string" && element.className.trim() ? "." + element.className.trim().split(/\\s+/).slice(0, 2).join(".") : "";
  const text = (element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40);
  return { disabled: false, covering: "<" + element.tagName.toLowerCase() + id + classes + ">" + (text ? " \\"" + text + "\\"" : "") };
}`;
async function receivesClick(context, handle, local, wantEnabled) {
    let hit = null;
    try {
        // DOM.getNodeForLocation takes document coordinates; the quads were in the viewport.
        const { cssLayoutViewport } = await handle.session.send("Page.getLayoutMetrics");
        hit = await handle.session.send("DOM.getNodeForLocation", {
            x: Math.round(local.x + cssLayoutViewport.pageX),
            y: Math.round(local.y + cssLayoutViewport.pageY),
            includeUserAgentShadowDOM: false,
            ignorePointerEventsNone: false,
        });
    }
    catch (error) {
        if (!/No node found at given location/i.test(messageOf(error)))
            throw error;
        return { disabled: false, covering: "nothing (the point is outside the page)" };
    }
    if (hit.backendNodeId === handle.backendNodeId && !wantEnabled)
        return { disabled: false, covering: null };
    const sameFrame = hit.frameId === handle.frameId;
    return context.frames.inWorld(handle.frameId, async (session, contextId) => {
        const objectId = await resolveInWorld(session, handle.backendNodeId, contextId);
        const hitId = sameFrame && hit.backendNodeId !== handle.backendNodeId ? await resolveInWorld(session, hit.backendNodeId, contextId).catch(() => null) : null;
        try {
            const { result, exceptionDetails } = await session.send("Runtime.callFunctionOn", {
                objectId,
                functionDeclaration: RECEIVES,
                arguments: [hitId ? { objectId: hitId } : { value: null }, { value: wantEnabled }],
                returnByValue: true,
            });
            if (exceptionDetails || !result.value)
                return { disabled: false, covering: null };
            // A hit in a frame this element hosts lands inside it.
            if (!sameFrame && hit.backendNodeId !== handle.backendNodeId) {
                const { node } = await handle.session.send("DOM.describeNode", { backendNodeId: handle.backendNodeId });
                if (!/^I?FRAME$/i.test(node.nodeName ?? ""))
                    return { disabled: result.value.disabled, covering: "an element in another frame" };
            }
            return result.value;
        }
        finally {
            void session.send("Runtime.releaseObject", { objectId }).catch(() => { });
            if (hitId)
                void session.send("Runtime.releaseObject", { objectId: hitId }).catch(() => { });
        }
    });
}
/** Scrolled into view, visible, still for a frame, enabled and the top element at its centre; waits until then. */
async function actionablePoint(context, handle, deadline, { hitTest = true, wantEnabled = true } = {}) {
    let problem = new DriverError("not-visible", "The element is not visible.");
    for (;;) {
        try {
            await handle.session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: handle.backendNodeId }).catch((error) => {
                if (isGone(error))
                    throw error;
            });
            const first = await quads(handle);
            if (first.length) {
                await valueInWorld(context.frames, handle.frameId, NEXT_FRAME, { awaitPromise: true });
                const second = await quads(handle);
                if (second.length && sameQuads(first, second)) {
                    const quad = second.reduce((best, candidate) => (area(candidate) > area(best) ? candidate : best));
                    const local = center(quad);
                    const offset = await context.frames.localRootOffset(handle.session);
                    const point = { x: local.x + offset.x, y: local.y + offset.y };
                    if (!hitTest)
                        return point;
                    const receives = await receivesClick(context, handle, local, wantEnabled);
                    if (receives.disabled)
                        problem = new DriverError("not-editable", "The element is disabled.");
                    else if (receives.covering)
                        problem = new DriverError("covered", `The element is covered by ${receives.covering}, which would get the click.`, { covering: receives.covering });
                    else
                        return point;
                }
                else {
                    problem = new DriverError("not-visible", second.length ? "The element is still moving." : "The element is not visible.");
                }
            }
            else {
                problem = new DriverError("not-visible", "The element is not visible.");
            }
        }
        catch (error) {
            if (isGone(error) || (error instanceof DriverError && error.code === "not-found"))
                throw gone(handle);
            throw error;
        }
        if (Date.now() >= deadline)
            throw problem;
        await sleep(POLL_MS);
    }
}
/** Resolves when the action finishes, or as soon as it opens a dialog (which blocks it until answered). */
async function untilDialog(context, action) {
    const dialog = context.dialogs.nextOpen();
    try {
        const outcome = await Promise.race([action.then(() => "done"), dialog.opened.then(() => "dialog")]);
        if (outcome === "dialog")
            action.catch(() => { });
        return outcome === "dialog";
    }
    finally {
        dialog.cancel();
    }
}
/** A point the bot passed, refused outside the viewport as it is now: a person's panel can resize it between two calls. */
async function inViewport(context, point) {
    const size = await valueInWorld(context.frames, context.frames.mainFrameId, "[innerWidth, innerHeight]").catch(() => null);
    if (size && (point.x >= size[0] || point.y >= size[1])) {
        throw new DriverError("refused", `${Math.round(point.x)},${Math.round(point.y)} is outside the page's viewport, which is ${size[0]}x${size[1]} CSS pixels now. Take a new screenshot and aim inside it.`);
    }
    return point;
}
/** Where to act: found, shown to people watching, then found again, since the page may have moved meanwhile. */
async function pointAfterShowing(context, at, deadline, phase, pointer, options = {}) {
    if ("x" in at) {
        await inViewport(context, at);
        await pointer?.(at, phase);
        return at;
    }
    const point = await actionablePoint(context, at, deadline, options);
    if (!pointer)
        return point;
    await pointer(point, phase);
    return actionablePoint(context, at, deadline, options);
}
export async function click(context, target, { button = "left", clickCount = 1, timeoutMs = DEFAULT_ACTION_TIMEOUT_MS, pointer } = {}) {
    await context.bringToFront();
    refuseErrorPage(context);
    const point = await pointAfterShowing(context, isPoint(target) ? target : await element(context, target), Date.now() + timeoutMs, "click", pointer);
    const dialog = await untilDialog(context, context.mouse.click(point.x, point.y, { button, clickCount }));
    return { x: point.x, y: point.y, dialog };
}
export async function hover(context, target, { timeoutMs = DEFAULT_ACTION_TIMEOUT_MS, pointer } = {}) {
    await context.bringToFront();
    const point = await pointAfterShowing(context, isPoint(target) ? target : await element(context, target), Date.now() + timeoutMs, "move", pointer, { wantEnabled: false });
    await context.mouse.move(point.x, point.y);
    return point;
}
const EDITABLE = `function () {
  const nonText = ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"];
  const valueTypes = ["date", "datetime-local", "month", "time", "week"];
  const isInput = this instanceof HTMLInputElement;
  const type = isInput ? (this.type || "text").toLowerCase() : "";
  const textControl = this instanceof HTMLTextAreaElement || (isInput && !nonText.includes(type));
  if (!(textControl || this.isContentEditable) || this.disabled || this.readOnly) return null;
  return { kind: isInput && valueTypes.includes(type) ? "value" : this.isContentEditable && !textControl ? "contenteditable" : "text" };
}`;
const FOCUSED = `function () {
  const root = this.getRootNode();
  const active = root.activeElement;
  return active != null && (active === this || this.contains(active));
}`;
const SET_VALUE = `function (value) {
  this.value = value;
  this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return this.value;
}`;
const notEditable = () => new DriverError("not-editable", "The target is not an enabled text field, so no text was typed.");
async function focusEditable(context, handle) {
    let editable;
    try {
        editable = await callOnNode(context.frames, handle, EDITABLE);
    }
    catch (error) {
        if (isGone(error) || (error instanceof DriverError && error.code === "not-found"))
            throw gone(handle);
        throw error;
    }
    if (!editable)
        throw notEditable();
    await handle.session.send("DOM.focus", { backendNodeId: handle.backendNodeId });
    if (!(await callOnNode(context.frames, handle, FOCUSED)))
        throw notEditable();
    return editable.kind;
}
/** Clears the field and inserts the text in one input event, as a paste would. */
export async function fill(context, target, text) {
    await context.bringToFront();
    refuseErrorPage(context);
    const handle = await element(context, target);
    const kind = await focusEditable(context, handle);
    // Date and time fields take no typed text: set them like a picker would (the events are untrusted).
    if (kind === "value") {
        await callOnNode(context.frames, handle, SET_VALUE, [text]);
        return;
    }
    await context.keyboard.press("ControlOrMeta+A");
    await context.keyboard.press("Backspace");
    if (text)
        await context.keyboard.insertText(text);
}
const FOCUSED_SOMEWHERE = `(() => {
  let active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  return active != null && active !== document.body && active !== document.documentElement;
})()`;
/** Key events per character into the target (or the focused field); past 500 characters the rest is inserted as text. */
export async function type(context, target, text) {
    await context.bringToFront();
    refuseErrorPage(context);
    if (target)
        await focusEditable(context, await element(context, target));
    else if (!(await valueInWorld(context.frames, context.frames.mainFrameId, FOCUSED_SOMEWHERE))) {
        throw new DriverError("not-editable", "Nothing is focused to type into. Pass the field's ref, or click it first.");
    }
    const chars = [...text];
    await context.keyboard.type(chars.slice(0, MAX_TYPED_KEYS).join(""));
    if (chars.length > MAX_TYPED_KEYS)
        await context.keyboard.insertText(chars.slice(MAX_TYPED_KEYS).join(""));
}
/** A key chord such as "Enter" or "ControlOrMeta+A"; returns early if it opens a dialog. */
export async function press(context, chord) {
    await context.bringToFront();
    return { dialog: await untilDialog(context, context.keyboard.press(chord)) };
}
const SELECT_INFO = `function () {
  if (!(this instanceof HTMLSelectElement)) return null;
  return { multiple: this.multiple, disabled: this.disabled, value: this.value, options: [...this.options].map((option) => ({ value: option.value, label: option.label.trim(), disabled: option.disabled })) };
}`;
const SELECT_VALUES = `function (values) {
  for (const option of this.options) option.selected = values.includes(option.value);
  this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return [...this.selectedOptions].map((option) => option.value);
}`;
/** Each entry matches an option by value first, then by its visible label. A single choice is typed, as a person would. */
export async function select(context, target, values) {
    await context.bringToFront();
    refuseErrorPage(context);
    const handle = await element(context, target);
    const info = await callOnNode(context.frames, handle, SELECT_INFO).catch((error) => {
        if (isGone(error) || (error instanceof DriverError && error.code === "not-found"))
            throw gone(handle);
        throw error;
    });
    if (!info)
        throw new DriverError("not-editable", "This element is not a <select>. Click a custom dropdown, then click its option.");
    if (info.disabled)
        throw new DriverError("not-editable", "This list is disabled.");
    const chosen = values.map((entry) => {
        const option = info.options.find((candidate) => candidate.value === entry) ?? info.options.find((candidate) => candidate.label === entry.trim());
        if (!option)
            throw new DriverError("not-found", `No option matches "${entry}". The options are: ${info.options.map((candidate) => candidate.label).slice(0, 30).join(", ")}.`);
        if (option.disabled)
            throw new DriverError("not-editable", `The option "${option.label}" is disabled.`);
        return option;
    });
    if (!info.multiple && chosen.length !== 1)
        throw new DriverError("refused", "This list takes exactly one option.");
    if (!info.multiple) {
        const option = chosen[0];
        if (info.value === option.value)
            return { selected: [option.value] };
        const label = option.label.toLowerCase();
        const typeable = label.length > 0 && info.options.filter((candidate) => candidate.label.toLowerCase().startsWith(label)).length === 1;
        if (typeable) {
            await handle.session.send("DOM.focus", { backendNodeId: handle.backendNodeId });
            await context.keyboard.type(option.label);
            const after = await callOnNode(context.frames, handle, SELECT_INFO);
            if (after?.value === option.value)
                return { selected: [option.value] };
        }
    }
    // Several choices, or a label typing cannot reach: set from the isolated world (the input and change events are untrusted).
    return { selected: await callOnNode(context.frames, handle, SELECT_VALUES, [chosen.map((option) => option.value)]) };
}
const CHECK_STATE = `function () {
  const role = (this.getAttribute && this.getAttribute("role")) || "";
  if (this instanceof HTMLInputElement && (this.type === "checkbox" || this.type === "radio")) return { kind: this.type, checked: this.indeterminate ? "mixed" : this.checked };
  if (["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(role)) {
    const value = this.getAttribute("aria-checked");
    return { kind: role.includes("radio") ? "radio" : "checkbox", checked: value === "mixed" ? "mixed" : value === "true" };
  }
  return null;
}`;
/** Clicks only when the state differs, then confirms the page took it. */
export async function check(context, target, checked = true, options = {}) {
    const handle = await element(context, target);
    const state = await callOnNode(context.frames, handle, CHECK_STATE);
    if (!state)
        throw new DriverError("not-editable", "This element is not a checkbox, radio button or switch.");
    if (state.checked === checked)
        return { checked, changed: false };
    if (!checked && state.kind === "radio")
        throw new DriverError("refused", "A radio button cannot be unchecked; choose another option instead.");
    const ref = handle.ref ?? context.refs.refFor(handle);
    await click(context, { ref }, options);
    const after = await callOnNode(context.frames, handle, CHECK_STATE);
    if (after?.checked !== checked)
        throw new DriverError("execution", `Clicking did not ${checked ? "check" : "uncheck"} the element.`);
    return { checked, changed: true };
}
const DRAG_PROBE = `(() => {
  globalThis.__ombDragStarted = false;
  addEventListener("dragstart", () => { globalThis.__ombDragStarted = true; }, { capture: true, once: true });
  return true;
})()`;
/** An HTML5 drag-and-drop when the source starts one (Input.setInterceptDrags), otherwise a pressed-mouse move. */
export async function drag(context, from, to, { timeoutMs = DEFAULT_ACTION_TIMEOUT_MS, pointer } = {}) {
    await context.bringToFront();
    refuseErrorPage(context);
    const deadline = Date.now() + timeoutMs;
    const source = isPoint(from) ? null : await element(context, from);
    const start = await pointAfterShowing(context, source ?? from, deadline, "move", pointer);
    const end = isPoint(to) ? await inViewport(context, to) : await actionablePoint(context, await element(context, to), deadline, { hitTest: false });
    const sourceFrame = source?.frameId ?? context.frames.mainFrameId;
    const session = context.session;
    const intercepted = { data: null };
    const off = session.on("Input.dragIntercepted", (params) => {
        intercepted.data = params.data;
    });
    await session.send("Input.setInterceptDrags", { enabled: true });
    try {
        await valueInWorld(context.frames, sourceFrame, DRAG_PROBE);
        await context.mouse.move(start.x, start.y);
        await context.mouse.down();
        // Past Chrome's drag threshold, toward the target.
        const distance = Math.hypot(end.x - start.x, end.y - start.y);
        const lead = distance > 0 ? Math.min(distance, Math.max(DRAG_LEAD_PX, distance / 10)) / distance : 0;
        await context.mouse.move(start.x + (distance > 0 ? (end.x - start.x) * lead : DRAG_LEAD_PX), start.y + (end.y - start.y) * lead, { steps: 2 });
        const started = await valueInWorld(context.frames, sourceFrame, "globalThis.__ombDragStarted === true").catch(() => false);
        if (started) {
            for (const until = Date.now() + 2_000; !intercepted.data && Date.now() < until;)
                await sleep(10);
        }
        const data = intercepted.data;
        if (data) {
            await session.send("Input.setInterceptDrags", { enabled: false });
            for (const type of ["dragEnter", "dragOver", "drop"]) {
                await session.send("Input.dispatchDragEvent", { type, x: end.x, y: end.y, data, modifiers: context.keyboard.modifiers });
            }
            await context.mouse.move(end.x, end.y);
            await context.mouse.up();
            return { from: start, to: end, dropped: "html5" };
        }
        await context.mouse.move(end.x, end.y, { steps: 8 });
        await context.mouse.up();
        return { from: start, to: end, dropped: "mouse" };
    }
    finally {
        off();
        await session.send("Input.setInterceptDrags", { enabled: false }).catch(() => { });
    }
}
const VIEWPORT_CENTER = "({ x: innerWidth / 2, y: innerHeight / 2 })";
/** A mouse wheel over the target, or over the middle of the viewport. */
export async function scroll(context, target, deltaX, deltaY, { timeoutMs = DEFAULT_ACTION_TIMEOUT_MS } = {}) {
    await context.bringToFront();
    const point = target === null
        ? await valueInWorld(context.frames, context.frames.mainFrameId, VIEWPORT_CENTER)
        : isPoint(target) ? await inViewport(context, target) : await actionablePoint(context, await element(context, target), Date.now() + timeoutMs, { hitTest: false });
    await context.mouse.move(point.x, point.y);
    await context.mouse.wheel(deltaX, deltaY);
    await valueInWorld(context.frames, context.frames.mainFrameId, NEXT_FRAME, { awaitPromise: true }).catch(() => { });
    return point;
}
