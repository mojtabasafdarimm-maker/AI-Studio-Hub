export const MAX_ELEMENTS = 1500;
const ROOT_ROLES = new Set(["AXWindow", "AXApplication"]);
const isRec = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
function pick(source, keys, types) {
    const out = {};
    for (const key of keys)
        if (typeof source[key] === types[key])
            out[key] = source[key];
    return out;
}
const ELEMENT_TYPES = { element_index: "number", element_token: "string", role: "string", label: "string", parent_index: "number", depth: "number" };
const APP_TYPES = { pid: "number", name: "string", bundle_id: "string", running: "boolean" };
const WINDOW_TYPES = { window_id: "number", pid: "number", title: "string", app_name: "string" };
const TOP_TYPES = { pid: "number", window_id: "number", bundle_id: "string", name: "string", app_name: "string", window_title: "string" };
function slimList(value, types, required, max = Infinity, mark) {
    if (!Array.isArray(value))
        return undefined;
    const items = [];
    for (const item of value) {
        if (items.length >= max)
            break;
        if (!isRec(item))
            continue;
        const slim = pick(item, Object.keys(types), types);
        mark?.(item, slim);
        if (required.every((key) => key in slim))
            items.push(slim);
    }
    return items;
}
const markValueRead = (raw, slim) => {
    if (typeof raw.value === "string")
        slim.value_read = true;
};
const COUNTS = ["element_count", "total_element_count", "returned_element_count", "filtered_element_count"];
const hasText = (value) => typeof value === "string" && value.trim() !== "";
const countFits = (count, returned) => count === undefined || count === null || (typeof count === "number" && count <= returned);
export function wholeTree(state) {
    const returned = Array.isArray(state.elements) ? state.elements.length : 0;
    return state.elements_complete === true && state.truncated !== true && !hasText(state.truncation_reason)
        && COUNTS.every((key) => countFits(state[key], returned));
}
export const treeDegraded = (state) => state.degraded === true || hasText(state.degraded_reason);
function slimStructured(raw) {
    const out = pick(raw, Object.keys(TOP_TYPES), TOP_TYPES);
    const elements = slimList(raw.elements, ELEMENT_TYPES, ["element_index", "role", "depth"], MAX_ELEMENTS, markValueRead);
    const apps = slimList(raw.apps, APP_TYPES, ["pid", "name"]);
    const windows = slimList(raw.windows, WINDOW_TYPES, ["window_id", "title"]);
    if (elements)
        out.elements = elements;
    if (elements && elements.length === raw.elements.length && wholeTree(raw) && !treeDegraded(raw))
        out.elements_complete = true;
    if (apps)
        out.apps = apps;
    if (windows)
        out.windows = windows;
    if (isRec(raw.refusal)) {
        const refusal = pick(raw.refusal, ["code", "message"], { code: "string", message: "string" });
        out.refusal = refusal;
    }
    return out;
}
export function slimResponse(frame) {
    if (!isRec(frame))
        return { isError: true, rpcError: true };
    if (frame.error !== undefined)
        return { isError: true, rpcError: true };
    const result = isRec(frame.result) ? frame.result : {};
    const slim = { isError: result.isError === true };
    if (isRec(result.structuredContent))
        slim.structured = slimStructured(result.structuredContent);
    return slim;
}
export function elementPath(elements, element) {
    const byIndex = new Map(elements.map((candidate) => [candidate.element_index, candidate]));
    const chain = [];
    const seen = new Set([element.element_index]);
    let node = element;
    while (node.parent_index !== undefined) {
        const parent = byIndex.get(node.parent_index);
        if (!parent || seen.has(parent.element_index))
            return null;
        seen.add(parent.element_index);
        if (!ROOT_ROLES.has(parent.role))
            chain.push(`${parent.role}:${parent.label ?? ""}`);
        node = parent;
    }
    return node.depth > 0 ? null : chain.reverse();
}
