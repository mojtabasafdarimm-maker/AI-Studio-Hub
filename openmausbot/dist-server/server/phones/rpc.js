import { phoneWriteSummary } from "./summary.js";
// The JSON-RPC entry the harness proxy reaches for the device kind: tools/list (filtered to what this bot may run on the
// owner's phones) and tools/call (validate → verdict → pick the phone → run as a phone job). OpenMausBot adds no card of
// its own: a send opens a sheet on the phone and goes only when the person taps Send there. The turn's capability must
// still be live before and after the call.
import { isPhoneToolName, isPhoneWrite } from "../../shared/phone-apps.js";
import { PHONE_INSTRUCTIONS, PHONE_NO_PHONE_TEXT } from "./instructions.js";
import { PHONE_TOOLS, phoneErrorResult, phoneOkResult, phoneToolCallProblem } from "./tools.js";
export const PHONE_INTERNAL_MCP_PATH = "/api/internal/device/mcp";
export async function phoneRpc(request, deps) {
    if (request?.method === "tools/list") {
        deps.assertActive();
        return { tools: PHONE_TOOLS.filter((tool) => deps.authorize(tool.name).ok), instructions: PHONE_INSTRUCTIONS };
    }
    if (request?.method !== "tools/call")
        throw Object.assign(new Error("unsupported device method"), { status: 400 });
    const params = (request.params && typeof request.params === "object" ? request.params : {});
    const args = params.arguments ?? {};
    const problem = phoneToolCallProblem(params.name, args);
    if (problem || !isPhoneToolName(params.name))
        return phoneErrorResult(problem ?? "Unknown phone tool.", { code: "invalid_input" });
    const name = params.name;
    const { phone: preferred, ...jobArgs } = args;
    deps.assertActive();
    const verdict = deps.authorize(name);
    if (!verdict.ok)
        return phoneErrorResult(verdict.text, { code: "refused" });
    const target = deps.phone(typeof preferred === "string" && preferred.trim() ? preferred : undefined, name);
    if (!target)
        return phoneErrorResult(PHONE_NO_PHONE_TEXT, { code: "no_phone" });
    if ("text" in target)
        return phoneErrorResult(target.text, { code: target.code });
    const outcome = await deps.run(target, name, jobArgs);
    deps.assertActive();
    if (!outcome.ok)
        return phoneErrorResult(outcome.error, outcome.code ? { code: outcome.code } : {});
    if (isPhoneWrite(name))
        deps.onWrite?.({ tool: name, phone: target.name, ...phoneWriteSummary(name, target.name) });
    return phoneOkResult(outcome.result, { name: target.name, platform: target.platform });
}
