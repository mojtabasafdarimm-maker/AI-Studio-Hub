const FIELDS = ["value", "label", "title", "caption"];
const KEY = /^(?:brief|chat\.notice|server\.meetings)\.[\w.]{1,80}$/;
const STYLES = new Set(["clock", "bareClock", "longDate", "shortDate"]);
const MAX_PARAMS = 8;
const MAX_DEPTH = 3;
const MAX_STRING = 400;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function readParam(raw, depth) {
    if (typeof raw === "string")
        return raw.slice(0, MAX_STRING);
    if (typeof raw === "number")
        return Number.isFinite(raw) ? raw : undefined;
    if (!isRecord(raw))
        return undefined;
    if (typeof raw.at === "number" && Number.isFinite(raw.at) && STYLES.has(raw.style)) {
        return { at: raw.at, style: raw.style, ...(typeof raw.zone === "string" && raw.zone.length <= 64 ? { zone: raw.zone } : {}) };
    }
    return readText(raw, depth + 1);
}
function readText(raw, depth) {
    if (!isRecord(raw) || typeof raw.key !== "string" || !KEY.test(raw.key) || depth > MAX_DEPTH)
        return undefined;
    if (raw.params === undefined)
        return { key: raw.key };
    if (!isRecord(raw.params))
        return undefined;
    const entries = Object.entries(raw.params).slice(0, MAX_PARAMS).map(([name, value]) => [name, readParam(value, depth)]);
    if (entries.some(([name, value]) => value === undefined || !/^\w{1,32}$/.test(name)))
        return undefined;
    return { key: raw.key, params: Object.fromEntries(entries) };
}
/** A node's `i18n` as it may be kept: anything malformed is dropped, and the node keeps its English. */
export function readWidgetText(raw) {
    if (!isRecord(raw))
        return undefined;
    const fields = {};
    for (const field of FIELDS) {
        const text = readText(raw[field], 0);
        if (text)
            fields[field] = text;
    }
    return Object.keys(fields).length ? fields : undefined;
}
