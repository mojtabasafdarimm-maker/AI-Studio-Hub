export const USAGE_LIMITS_TOOL = "usage_limits";
export async function callUsageLimitsTool(context) {
    const { ok, body } = await context.client.apiResponse("/api/internal/engine-limits");
    return ok ? { text: String(body.text ?? "") } : { text: String(body.error ?? "Usage limits could not be read. Try again shortly."), isError: true };
}
export const USAGE_LIMITS_TOOL_DEFINITION = {
    name: USAGE_LIMITS_TOOL,
    description: "Each AI account's usage limits: percent used, reset time, when checked. status: ok, unknown (no data now; see why) or unsupported.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
};
