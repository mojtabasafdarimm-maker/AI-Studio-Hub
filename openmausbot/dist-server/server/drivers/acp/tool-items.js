import { extractMcpImages } from "../../mcp-tool-images.js";
import { toolDetailPreview } from "../../tool-summary.js";
/**
 * The events that end a finished tool item: its completion, then any images its result carries. An item already in
 * `ended` gets none, and an item that ends here joins it: ACP v1 lets an update name a tool call that already finished.
 */
export function acpToolEndEvents(update, itemId, ended) {
    if (itemId !== undefined) {
        if (ended.has(itemId))
            return [];
        ended.add(itemId);
    }
    return [
        { type: "item.completed", itemType: "tool", itemId, ok: update.status !== "failed", output: toolDetailPreview(update.rawOutput ?? update.content) },
        ...extractMcpImages(update.content ?? update.rawOutput).map((img) => ({ type: "item.completed", itemType: "assistant_image", data: img.data, fromTool: true })),
    ];
}
