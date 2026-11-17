// The one short line a trace shows beside a tool: the query, the page, the action. Typed text, messages and file bodies are
// never kept, and every line passes the secret redaction before it is stored.
import { redactSecretsInText } from "../../shared/redact.js";
import { TOOL_NAMESPACE } from "../../shared/tool-surface.js";
export const DETAIL_MAX = 80;
export const ERROR_MAX = 120;
const clip = (text, max) => {
    const flat = redactSecretsInText(text.replace(/\s+/g, " ").trim());
    if (!flat)
        return undefined;
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
function fieldsOf(input) {
    if (input && typeof input === "object" && !Array.isArray(input))
        return input;
    if (typeof input !== "string" || !/^\s*\{/.test(input))
        return null;
    try {
        const parsed = JSON.parse(input);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
function pageOf(raw) {
    try {
        const url = new URL(raw);
        if (url.protocol !== "http:" && url.protocol !== "https:")
            return undefined;
        const path = url.pathname === "/" ? "" : url.pathname;
        return `${url.host.replace(/^www\./, "")}${path}`;
    }
    catch {
        return undefined;
    }
}
const QUERY_KEYS = ["query", "q", "search", "search_query", "pattern", "searchTerm"];
const PAGE_KEYS = ["url", "uri", "href", "link"];
const FILE_KEYS = ["file_path", "filePath", "path", "notebook_path", "file"];
const ACTION_KEYS = ["action", "operation", "method", "kind"];
/** A tool's detail from its call: a shell summary, a parsed preview, or nothing. Never the raw arguments. */
export function toolDetail(name, input, summary) {
    if (summary)
        return clip(summary, DETAIL_MAX);
    const fields = fieldsOf(input);
    if (!fields)
        return undefined;
    const text = (key) => typeof fields[key] === "string" ? fields[key] : undefined;
    for (const key of QUERY_KEYS)
        if (text(key))
            return clip(text(key), DETAIL_MAX);
    for (const key of PAGE_KEYS) {
        const page = text(key) && pageOf(text(key));
        if (page)
            return clip(page, DETAIL_MAX);
    }
    for (const key of FILE_KEYS) {
        const path = text(key);
        if (path)
            return clip(path.split(/[\\/]/).filter(Boolean).slice(-2).join("/"), DETAIL_MAX);
    }
    if (text("command"))
        return clip(text("command"), DETAIL_MAX);
    const bare = name.replace(TOOL_NAMESPACE, "");
    for (const key of ACTION_KEYS)
        if (text(key))
            return clip(text(key).replace(/[_-]+/g, " "), DETAIL_MAX);
    if (typeof fields.name === "string" && /^(?:use_tool|call_tool)$/.test(bare))
        return clip(fields.name, DETAIL_MAX);
    if (Array.isArray(fields.coordinate) && fields.coordinate.length === 2)
        return clip(`at ${fields.coordinate.join(", ")}`, DETAIL_MAX);
    return undefined;
}
/** A page title a browser tool reported, when its output states one. */
export function pageTitle(output) {
    if (typeof output !== "string")
        return undefined;
    const match = /(?:^|\n|"|\b)(?:page )?title["']?\s*[:=]\s*["']?([^"'\n]{1,120})/i.exec(output);
    return match ? clip(match[1], 60) : undefined;
}
export function errorLine(output) {
    if (typeof output !== "string")
        return undefined;
    const first = output.split("\n").find((line) => line.trim());
    return first ? clip(first, ERROR_MAX) : undefined;
}
