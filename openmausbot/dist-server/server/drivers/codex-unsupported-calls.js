// A tool call codex could not route never reaches an MCP server and never becomes an app-server item: codex answers the
// model with "unsupported call: <tool>" and the turn carries on without it. That happens when a provider returns an
// MCP tool's function_call without the `namespace` codex sent it under (seen with non-OpenAI models behind an
// OpenAI-compatible gateway). The only trace is the thread's rollout file, so the turn reads what it appended there.
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { noticeFailure } from "../chat-notices.js";
/** A turn reads at most this much of what it appended, from its start. */
export const ROLLOUT_SCAN_MAX_BYTES = 16 * 1024 * 1024;
const UNSUPPORTED = /^unsupported call: ([\w.:-]{1,200})/;
const MARKER = "unsupported call: ";
const NEWLINE = 0x0a;
export function rolloutMark(path) {
    if (typeof path !== "string" || !path)
        return null;
    try {
        return { path, offset: statSync(path).size };
    }
    catch {
        return null;
    }
}
const outputText = (output) => typeof output === "string" ? output
    : Array.isArray(output) ? output.map((part) => typeof part?.text === "string" ? part.text : "").join("")
        : output && typeof output === "object" && typeof output.content === "string" ? output.content : "";
function refusedTool(line) {
    let record;
    try {
        record = JSON.parse(line);
    }
    catch {
        return undefined;
    }
    if (record.type !== "response_item" || record.payload?.type !== "function_call_output")
        return undefined;
    return UNSUPPORTED.exec(outputText(record.payload.output))?.[1];
}
/** The tools codex refused in these rollout lines, each once, in the order it refused them. Only the lines that carry
 * codex's refusal are decoded, so a long turn costs a byte search. */
export function unsupportedCallsIn(text) {
    const bytes = typeof text === "string" ? Buffer.from(text, "utf8") : text;
    const tools = new Set();
    for (let at = bytes.indexOf(MARKER); at !== -1;) {
        const start = bytes.lastIndexOf(NEWLINE, at) + 1;
        const newline = bytes.indexOf(NEWLINE, at);
        const end = newline === -1 ? bytes.length : newline;
        const tool = refusedTool(bytes.subarray(start, end).toString("utf8"));
        if (tool)
            tools.add(tool);
        if (newline === -1)
            break;
        at = bytes.indexOf(MARKER, end);
    }
    return [...tools];
}
/** The tools codex refused since `mark`; none when the file cannot be read. */
export function unsupportedCallsSince(mark, maxBytes = ROLLOUT_SCAN_MAX_BYTES) {
    if (!mark)
        return [];
    let fd;
    try {
        fd = openSync(mark.path, "r");
        const end = fstatSync(fd).size;
        // A file that shrank was replaced (compaction or a rebuild): read it from the top.
        const from = end < mark.offset ? 0 : mark.offset;
        const length = Math.min(end - from, maxBytes);
        if (length <= 0)
            return [];
        const bytes = Buffer.alloc(length);
        const read = readSync(fd, bytes, 0, length, from);
        return unsupportedCallsIn(bytes.subarray(0, read));
    }
    catch {
        return [];
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
export function unsupportedCallsFailure(tools) {
    const key = tools.length > 6 ? "chat.notice.codexUnsupportedMore" : tools.length === 1 ? "chat.notice.codexUnsupportedOne" : "chat.notice.codexUnsupportedMany";
    return noticeFailure(key, { tools: tools.slice(0, 6).join(", "), ...(tools.length > 6 ? { count: String(tools.length - 6) } : {}) });
}
export function unsupportedCallsNotice(tools) {
    return unsupportedCallsFailure(tools).message;
}
/** Logs and tells the thread about every call codex refused since `mark`, so a dropped namespace is never silent. */
export function reportUnsupportedCalls(mark, notice) {
    const tools = unsupportedCallsSince(mark);
    if (!tools.length)
        return;
    console.warn(`[codex] unsupported tool call (provider dropped the MCP namespace): ${tools.join(", ")}`);
    const failure = unsupportedCallsFailure(tools);
    notice(failure.message, failure.text);
}
