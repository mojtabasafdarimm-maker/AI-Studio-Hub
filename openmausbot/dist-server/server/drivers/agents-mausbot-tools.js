import { agentToolAnnotations } from "../agent-tool-policy.js";
export const MAUSBOT_TOOL_NAMES = new Set(["list_unread_notifications", "mark_notifications_read"]);
export async function callMausBotTool(name, args, context) {
    const { ok, body } = name === "list_unread_notifications"
        ? await context.client.apiResponse("/api/internal/notifications")
        : await context.client.apiResponse("/api/internal/notifications/read", { method: "POST", body: JSON.stringify({ ids: args.ids }) });
    return ok ? { text: String(body.text ?? "") } : { text: String(body.error ?? "That could not be done."), isError: true };
}
export const MAUSBOT_TOOL_DEFINITIONS = [
    {
        name: "list_unread_notifications",
        description: "The person's unread notifications, newest first, when they ask what they missed or to tidy them up.",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    {
        name: "mark_notifications_read",
        description: "Mark finished-work notifications read, by id from list_unread_notifications. Anything that needs the person stays unread.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: { ids: { type: "array", maxItems: 40, items: { type: "string" } } },
            required: ["ids"],
        },
    },
].map((tool) => {
    const annotations = agentToolAnnotations(tool.name);
    return annotations ? { ...tool, annotations } : tool;
});
