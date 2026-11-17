import { messageOf } from "./errors.js";
import { valueInWorld } from "./evaluate.js";
import { isSensitiveInput } from "./sensitive.js";
export const MAX_VISIBLE_TEXT_LENGTH = 20_000;
const MAX_LINES = 5_000;
const MAX_STYLE_CHECKS_PER_FRAME = 300;
const NAME_CHARS = 200;
const TEXT_CHARS = 300;
const VALUE_CHARS = 100;
export const MASKED_VALUE = "••••";
const INTERACTIVE = new Set([
    "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option", "menuitem",
    "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider", "spinbutton", "treeitem", "iframe",
]);
const VALUED = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);
const FLATTENED = new Set(["generic", "none", "presentation", "GenericContainer", "Section", "LabelText", "Div", "group-unnamed"]);
const SKIPPED = new Set(["InlineTextBox", "LineBreak", "ListMarker"]);
const STYLE_CANDIDATES = new Set(["generic", "none", "presentation", "GenericContainer", "Section", "LabelText", "img", "image", "listitem", "cell", "gridcell", "row", "paragraph", "StaticText", "heading", "figure", "article", "group"]);
const text = (value) => (value?.value === undefined || value.value === null ? "" : String(value.value));
const clean = (value, max) => {
    const collapsed = value.replace(/\s+/g, " ").trim();
    return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
};
function outputRole(role) {
    if (role === "StaticText")
        return "text";
    if (role === "Iframe" || role === "IframePresentational")
        return "iframe";
    return role.length > 1 && /^[A-Z][a-z]/.test(role) ? role[0].toLowerCase() + role.slice(1) : role;
}
const ownerKey = (session, backendNodeId) => `${session.id ?? ""}|${backendNodeId}`;
async function frameOwners(frames, records) {
    const owners = new Map();
    await Promise.all(records.filter((frame) => frame.id !== frames.mainFrameId).map(async (frame) => {
        // An out-of-process iframe's <iframe> element lives in the renderer that attached it; a same-process frame's in its own.
        const owning = frames.rootOf(frame.session) === frame.id ? frame.session.parent : frame.session;
        if (!owning)
            return;
        try {
            const { backendNodeId } = await owning.send("DOM.getFrameOwner", { frameId: frame.id });
            owners.set(ownerKey(owning, backendNodeId), frame);
        }
        catch { }
    }));
    return owners;
}
async function axTrees(records) {
    const trees = new Map();
    await Promise.all(records.map(async (frame) => {
        try {
            const { nodes } = await frame.session.send("Accessibility.getFullAXTree", { frameId: frame.id });
            trees.set(frame.id, nodes);
        }
        catch (error) {
            trees.set(frame.id, messageOf(error));
        }
    }));
    return trees;
}
function buildItems(frame, nodes, owners, trees, budget) {
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const root = nodes.find((node) => !node.parentId) ?? nodes[0];
    const walk = (node) => {
        if (!node || budget.left <= 0)
            return [];
        const role = text(node.role);
        if (SKIPPED.has(role))
            return [];
        const children = (node.childIds ?? []).flatMap((id) => walk(byId.get(id)));
        if (node.ignored || role === "RootWebArea" || role === "WebArea")
            return children;
        budget.left--;
        const item = {
            role,
            name: clean(text(node.name), NAME_CHARS),
            value: text(node.value),
            properties: new Map((node.properties ?? []).map((property) => [property.name, property.value?.value])),
            backendNodeId: node.backendDOMNodeId ?? null,
            frameId: frame.id,
            session: frame.session,
            children,
            pointer: false,
            sensitive: false,
        };
        const child = node.backendDOMNodeId === undefined ? undefined : owners.get(ownerKey(frame.session, node.backendDOMNodeId));
        if (child) {
            const tree = trees.get(child.id);
            if (Array.isArray(tree))
                item.children = buildItems(child, tree, owners, trees, budget);
            else
                item.unreadableFrame = tree ?? "not loaded";
        }
        return [item];
    };
    return walk(root);
}
const STYLE_READ = `function (...nodes) {
  return nodes.map((node) => {
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (!element) return [false, null];
    const cursor = getComputedStyle(element).cursor;
    const parent = element.parentElement || (element.getRootNode() && element.getRootNode().host) || null;
    const pointer = cursor === "pointer" && !(parent && getComputedStyle(parent).cursor === "pointer");
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return [pointer, [element.type || "text", element.autocomplete, element.name, element.id, element.placeholder, element.getAttribute("aria-label")]];
    }
    return [pointer, null];
  });
}`;
/** One isolated-world call per frame for the cursor and the input attributes that decide masking. */
async function readStyles(frames, items) {
    const byFrame = new Map();
    const visit = (item) => {
        const candidate = item.backendNodeId !== null && (STYLE_CANDIDATES.has(item.role) || (VALUED.has(item.role) && item.value !== ""));
        if (candidate) {
            const list = byFrame.get(item.frameId) ?? [];
            if (list.length < MAX_STYLE_CHECKS_PER_FRAME || VALUED.has(item.role))
                list.push(item);
            byFrame.set(item.frameId, list);
        }
        for (const child of item.children)
            visit(child);
    };
    for (const item of items)
        visit(item);
    await Promise.all([...byFrame].map(async ([frameId, list]) => {
        try {
            await frames.inWorld(frameId, async (session, contextId) => {
                const group = `omb-snapshot-${frameId}`;
                try {
                    const resolved = await Promise.all(list.map((item) => session.send("DOM.resolveNode", { backendNodeId: item.backendNodeId, executionContextId: contextId, objectGroup: group })
                        .then(({ object }) => object.objectId ?? null, () => null)));
                    const present = list.map((item, i) => ({ item, objectId: resolved[i] })).filter((entry) => entry.objectId !== null);
                    if (!present.length)
                        return;
                    const { result } = await session.send("Runtime.callFunctionOn", {
                        objectId: present[0].objectId,
                        functionDeclaration: STYLE_READ,
                        arguments: present.map((entry) => ({ objectId: entry.objectId })),
                        returnByValue: true,
                    });
                    (result.value ?? []).forEach(([pointer, input], i) => {
                        const item = present[i].item;
                        item.pointer = pointer && !INTERACTIVE.has(item.role);
                        if (input)
                            item.sensitive = isSensitiveInput(input[0] ?? "text", input.slice(1));
                    });
                }
                finally {
                    void session.send("Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => { });
                }
            });
        }
        catch { }
    }));
}
function states(item) {
    const parts = [];
    const checked = item.properties.get("checked");
    if (checked === "true" || checked === true)
        parts.push("[checked]");
    else if (checked === "mixed")
        parts.push("[checked=mixed]");
    if (item.properties.get("disabled") === true)
        parts.push("[disabled]");
    if (item.properties.get("expanded") === true)
        parts.push("[expanded]");
    const level = item.properties.get("level");
    if (typeof level === "number")
        parts.push(`[level=${level}]`);
    const pressed = item.properties.get("pressed");
    if (pressed === "true" || pressed === true)
        parts.push("[pressed]");
    else if (pressed === "mixed")
        parts.push("[pressed=mixed]");
    if (item.properties.get("selected") === true)
        parts.push("[selected]");
    return parts.join(" ");
}
function valuePart(item, options) {
    if (!VALUED.has(item.role) || item.value === "")
        return "";
    const masked = item.sensitive || /^[•●*]+$/.test(item.value) || options.maskValue?.(item.value) === true;
    return masked ? `[value=${MASKED_VALUE}]` : `[value=${JSON.stringify(clean(item.value, VALUE_CHARS))}]`;
}
function onlyText(item) {
    if (!item.children.length || !item.children.every((child) => child.role === "StaticText" && !child.children.length && !child.pointer))
        return null;
    return clean(item.children.map((child) => child.name).join(" "), TEXT_CHARS);
}
function render(item, depth, refs, options, lines) {
    if (lines.length >= MAX_LINES)
        return;
    const role = outputRole(item.role);
    const interactive = INTERACTIVE.has(role) || item.pointer;
    if (FLATTENED.has(item.role) && !item.name && !interactive) {
        for (const child of item.children)
            render(child, depth, refs, options, lines);
        return;
    }
    const indent = "  ".repeat(depth);
    if (item.role === "StaticText") {
        const content = clean(item.name, TEXT_CHARS);
        if (content)
            lines.push(`${indent}- text: ${content}`);
        return;
    }
    const ref = interactive && item.backendNodeId !== null ? refs.refFor({ frameId: item.frameId, session: item.session, backendNodeId: item.backendNodeId }) : null;
    const parts = [`${indent}- ${role}`];
    if (item.name)
        parts.push(JSON.stringify(item.name));
    const stateText = states(item);
    if (stateText)
        parts.push(stateText);
    if (ref)
        parts.push(`[ref=${ref}]`);
    const value = valuePart(item, options);
    if (value)
        parts.push(value);
    if (item.pointer)
        parts.push("[cursor=pointer]");
    const header = parts.join(" ");
    // A field's own text is its value, shown (or masked) above.
    if (VALUED.has(item.role)) {
        lines.push(header);
        return;
    }
    if (item.unreadableFrame !== undefined) {
        lines.push(`${header}:`, `${indent}  - (frame not readable: ${clean(item.unreadableFrame, 120)})`);
        return;
    }
    const url = role === "link" ? item.properties.get("url") : undefined;
    const inline = url === undefined ? onlyText(item) : null;
    if (inline !== null) {
        lines.push(inline === item.name || !inline ? header : `${header}: ${inline}`);
        return;
    }
    const at = lines.length;
    lines.push(header);
    if (typeof url === "string" && url)
        lines.push(`${indent}  - /url: ${clean(url, NAME_CHARS)}`);
    for (const child of item.children) {
        if (child.role === "StaticText" && clean(child.name, TEXT_CHARS) === item.name)
            continue;
        render(child, depth + 1, refs, options, lines);
    }
    if (lines.length > at + 1)
        lines[at] = `${header}:`;
}
/** The tab's accessibility tree across every frame, out-of-process iframes and closed shadow roots included. */
export async function takeSnapshot(frames, refs, options = {}) {
    const records = frames.all();
    const [trees, owners] = await Promise.all([axTrees(records), frameOwners(frames, records)]);
    const main = trees.get(frames.mainFrameId);
    const mainFrame = frames.main;
    if (!Array.isArray(main) || !mainFrame)
        throw new Error(`The page's accessibility tree could not be read: ${Array.isArray(main) ? "the tab closed" : main ?? "no main frame"}`);
    const budget = { left: MAX_LINES * 2 };
    const items = buildItems(mainFrame, main, owners, trees, budget);
    await readStyles(frames, items);
    const lines = [];
    for (const item of items)
        render(item, 0, refs, options, lines);
    const truncated = lines.length >= MAX_LINES || budget.left <= 0;
    if (truncated)
        lines.push(`- … (the snapshot stops at ${MAX_LINES} lines)`);
    return { tree: lines.join("\n"), refs: refs.size, frames: records.length, truncated };
}
export async function visibleText(frames, maxChars = MAX_VISIBLE_TEXT_LENGTH) {
    const text = await valueInWorld(frames, frames.mainFrameId, `(document.body ? document.body.innerText : "").slice(0, ${Math.max(0, Math.floor(maxChars))})`);
    return typeof text === "string" ? text : "";
}
