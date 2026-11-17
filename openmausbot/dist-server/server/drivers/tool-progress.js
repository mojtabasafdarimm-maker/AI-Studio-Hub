// Each engine's own report of a tool call in progress, read into the status line's turn.progress. Claude Code streams a
// call's input as it is generated (stream-json with --include-partial-messages); Codex streams an apply_patch as
// item/fileChange/patchUpdated; ACP agents describe a call in tool_call and tool_call_update. Engines that report none
// of these leave the chat on its elapsed timer.
import { progressFile } from "../../shared/turn-progress.js";
const CLAUDE_TOOLS = {
    Write: "write",
    Edit: "edit",
    MultiEdit: "edit",
    NotebookEdit: "edit",
    Bash: "command",
    WebSearch: "web",
    WebFetch: "fetch",
    Read: "read",
    Grep: "search",
    Glob: "search",
    LS: "search",
};
/** Only the start of a call's input is searched for its path: Write and Edit name the file first. */
const HEAD_MAX = 4096;
const PATH_FIELD = /"(?:file_path|notebook_path|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const claudeDrafts = new WeakMap();
function report(activity, tool, fields) {
    return { type: "turn.progress", activity, ...(activity === "tool" ? { tool: tool.slice(0, 80) } : {}), ...fields };
}
function claudeReport(draft) {
    return report(CLAUDE_TOOLS[draft.name] ?? "tool", draft.name, { itemId: draft.id, bytes: draft.bytes, ...(draft.file ? { file: draft.file } : {}) });
}
/** One Claude stream event: a tool_use block opening, or more of its input JSON. `owner` keys the open blocks (one CLI
 * session); a new message starts them over. */
export function claudeToolDraft(owner, event) {
    const ev = event;
    if (!ev || typeof ev !== "object")
        return null;
    if (ev.type === "message_start") {
        claudeDrafts.delete(owner);
        return null;
    }
    if (typeof ev.index !== "number")
        return null;
    let open = claudeDrafts.get(owner);
    if (ev.type === "content_block_start") {
        const block = ev.content_block;
        if (block?.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string")
            return null;
        if (!open)
            claudeDrafts.set(owner, (open = new Map()));
        const draft = { id: block.id, name: block.name, bytes: 0, head: "" };
        open.set(ev.index, draft);
        return claudeReport(draft);
    }
    const draft = open?.get(ev.index);
    if (!draft)
        return null;
    if (ev.type === "content_block_stop") {
        open.delete(ev.index);
        return null;
    }
    const json = ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta" ? ev.delta.partial_json : undefined;
    if (typeof json !== "string" || !json)
        return null;
    draft.bytes += Buffer.byteLength(json);
    if (draft.file === undefined && draft.head.length < HEAD_MAX) {
        draft.head += json;
        const match = PATH_FIELD.exec(draft.head);
        if (match) {
            try {
                draft.file = progressFile(JSON.parse(`"${match[1]}"`)) ?? "";
            }
            catch {
                draft.file = "";
            }
            draft.head = "";
        }
    }
    return claudeReport(draft);
}
/** Codex's item/fileChange/patchUpdated: the patch so far, file by file. Every file new is a write; anything else an edit. */
export function codexPatchProgress(params) {
    const p = params;
    const changes = Array.isArray(p?.changes) ? p.changes : [];
    if (!changes.length)
        return null;
    const bytes = changes.reduce((sum, change) => sum + (typeof change?.diff === "string" ? Buffer.byteLength(change.diff) : 0), 0);
    const activity = changes.every((change) => change?.kind?.type === "add") ? "write" : "edit";
    const file = progressFile(changes[0]?.path);
    return report(activity, "edit", { bytes, ...(file ? { file } : {}), ...(typeof p?.itemId === "string" ? { itemId: p.itemId } : {}) });
}
/** Codex's item/commandExecution/outputDelta: the next chunk a running command printed. */
export function codexCommandOutput(params) {
    const p = params;
    if (typeof p?.itemId !== "string" || !p.itemId || typeof p.delta !== "string" || !p.delta)
        return null;
    return { type: "item.output", itemType: "tool", itemId: p.itemId, text: p.delta };
}
const ACP_KINDS = {
    edit: "edit",
    delete: "edit",
    move: "edit",
    execute: "command",
    search: "search",
    read: "read",
    fetch: "fetch",
    other: "tool",
};
/** An ACP tool_call or tool_call_update still running. A call with a diff reports the new text's size; a diff with no
 * old text is a new file. An update that names no kind and carries no diff says nothing new. */
export function acpToolProgress(update) {
    const u = update;
    if (u?.sessionUpdate !== "tool_call" && u?.sessionUpdate !== "tool_call_update")
        return null;
    if (u.status === "completed" || u.status === "failed")
        return null;
    const diffs = (Array.isArray(u.content) ? u.content : []).filter((part) => part?.type === "diff");
    const kind = typeof u.kind === "string" ? ACP_KINDS[u.kind] : undefined;
    if (!kind && !diffs.length)
        return null;
    const activity = diffs.length
        ? diffs.every((diff) => typeof diff.oldText !== "string" || !diff.oldText) ? "write" : "edit"
        : kind;
    const locations = Array.isArray(u.locations) ? u.locations : [];
    const file = progressFile(diffs[0]?.path ?? locations[0]?.path);
    const bytes = diffs.reduce((sum, diff) => sum + (typeof diff.newText === "string" ? Buffer.byteLength(diff.newText) : 0), 0);
    return report(activity, typeof u.title === "string" ? u.title : "tool", {
        ...(diffs.length ? { bytes } : {}),
        ...(file ? { file } : {}),
        ...(typeof u.toolCallId === "string" && u.toolCallId ? { itemId: u.toolCallId } : {}),
    });
}
/** An ACP call still running with text in its content: ACP replaces a call's whole content on each update. */
export function acpToolOutput(update) {
    const u = update;
    if (u?.sessionUpdate !== "tool_call" && u?.sessionUpdate !== "tool_call_update")
        return null;
    if (u.status === "completed" || u.status === "failed" || typeof u.toolCallId !== "string" || !u.toolCallId)
        return null;
    const text = (Array.isArray(u.content) ? u.content : [])
        .flatMap((part) => (part?.type === "content" && part.content?.type === "text" && typeof part.content.text === "string" ? [part.content.text] : []))
        .join("\n");
    return text ? { type: "item.output", itemType: "tool", itemId: u.toolCallId, text, whole: true } : null;
}
