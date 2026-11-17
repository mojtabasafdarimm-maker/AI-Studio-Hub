import { runtimeErrorText } from "../runtime-notice-error.js";
import { noticeFailure } from "../../chat-notices.js";
import { engineFailure, stopFailure } from "../engine-errors.js";
export function acpStopFailure(result, provider) {
    const message = typeof result?.error === "string" && result.error ? result.error
        : typeof result?.message === "string" && result.message ? result.message : undefined;
    if (message)
        return engineFailure(provider, message) ?? { message };
    const failure = stopFailure(result?.stopReason, provider) ?? noticeFailure("chat.notice.acpNoReason", { provider });
    return engineFailure(provider, failure.message) ?? failure;
}
/** DeepSeek Harness (dsh) words for an MCP server that failed to connect or sync its tools while the
 * session started. The whole error must be that failure (after an optional JSON-RPC message and before
 * an optional request context), so an earlier MCP failure quoted in other diagnostics keeps its text. */
const MCP_START_FAILED = /^(?:[^:\n]*: )?mcp-client\(([^)\n]+)\): initial connection or tool synchronization failed(?: \([^)\n]*\))?$/;
function mcpStartFailure(message, provider) {
    const server = MCP_START_FAILED.exec(message)?.[1];
    if (!server)
        return null;
    return server === "composio" ? noticeFailure("chat.notice.acpMcpAppsFailed", { provider }) : noticeFailure("chat.notice.acpMcpServerFailed", { server, provider });
}
/** A failure the agent reported as an ordinary reply, already in the words the person reads. */
export class AcpReportedFailure extends Error {
    facts;
    acpUsageLimit;
    constructor(facts, usageLimit) {
        super(facts.message);
        this.facts = facts;
        this.acpUsageLimit = usageLimit;
    }
}
export function acpRuntimeFailure(error, provider, account) {
    if (account?.message !== undefined)
        return { message: account.message, text: account.text };
    if (error instanceof AcpReportedFailure)
        return error.facts;
    const message = error instanceof Error ? error.message : String(error);
    // Account wording, when given, wins over the MCP rewrite.
    const mcp = account?.text ? null : mcpStartFailure(message, provider);
    if (mcp)
        return mcp;
    const failure = engineFailure(provider, message) ?? { message };
    const text = account?.text ?? runtimeErrorText(error) ?? failure.text;
    return text ? { ...failure, text } : failure;
}
