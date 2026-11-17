const HELPER_TOOL_ROUTES = { decide: "helpers/decide", extract: "helpers/extract" };
export const HELPER_TOOL_NAMES = new Set(Object.keys(HELPER_TOOL_ROUTES));
export async function callHelperTool(name, args, context) {
    const { ok, body } = await context.client.apiResponse(`/api/internal/${HELPER_TOOL_ROUTES[name]}`, { method: "POST", body: JSON.stringify(args) });
    return ok ? { text: String(body.text ?? "") } : { text: String(body.error ?? "The helper model did not answer. Try again shortly."), isError: true };
}
export const HELPER_TOOL_DEFINITIONS = [
    {
        name: "decide",
        description: "Ask a decision model typed questions about some state; it answers with probabilities and cannot act.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                state: { type: "string", description: "What to judge: text or JSON." },
                questions: {
                    type: "object",
                    description: 'Up to 8. id → {"type":"choice","instructions":"…","options":{"key":"meaning"}}, {"type":"yesno","instructions":"…"} or {"type":"score","instructions":"…","levels":["lowest",…]}',
                    additionalProperties: { type: "object" },
                },
            },
            required: ["state", "questions"],
        },
    },
    {
        name: "extract",
        description: "Read typed values out of text or an image; null where it does not say. Not for long sums or table totals.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                fields: {
                    type: "object",
                    description: 'Up to 30. name → {"type":"string|number|date|boolean|enum","description":"…","options":[…] for enum}',
                    additionalProperties: { type: "object" },
                },
                text: { type: "string" },
                file: { type: "string", description: "Or a .png, .jpg, .webp or text file in your working folder." },
            },
            required: ["fields"],
        },
    },
];
