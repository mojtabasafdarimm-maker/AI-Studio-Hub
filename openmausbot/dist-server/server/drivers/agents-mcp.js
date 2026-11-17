// The "agents" MCP server's answers (JSON-RPC 2.0, no MCP SDK), every tool routed through the harness. `env` is what the
// harness sets for it (see agents-proxy.ts): the stdio proxy an engine starts and the HTTP endpoint an engine reaches
// both answer through it.
import { resolveAgentsCall } from "../../shared/agents-tool-names.js";
import { TOOL_BRIDGE_ENV, createToolBridge } from "./agents-bridge.js";
import { availableTools, catalogProfileFromEnv } from "./agents-catalog.js";
import { DEFER_TOOLS_ENV, withDeferMarks } from "./agents-claude-defer.js";
import { callTool, capResult, toolCallContextFromEnv } from "./agents-call.js";
import { sendToolReceipt } from "./agents-timing.js";
import { capToolListResult, toolLimitFromEnv } from "../tool-count-limit.js";
/** What the agents server lists for `env`, before any tool limit. */
export function agentsToolList(env) {
    const available = availableTools(catalogProfileFromEnv(env));
    const bridge = env[TOOL_BRIDGE_ENV] === "1" ? createToolBridge(available) : undefined;
    return { available, bridge, listed: bridge ? bridge.listed : env[DEFER_TOOLS_ENV] === "1" ? withDeferMarks(available) : available };
}
export function agentsMcp(env) {
    const { available, bridge, listed } = agentsToolList(env);
    const limit = toolLimitFromEnv(env);
    const context = toolCallContextFromEnv(env);
    const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
    const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
    const textResult = (id, text, isError = false) => ok(id, { content: [{ type: "text", text }], isError });
    return async (msg) => {
        const id = msg.id;
        const method = msg.method;
        if (!method)
            return undefined;
        const params = (msg.params ?? {});
        switch (method) {
            case "initialize":
                return ok(id, {
                    protocolVersion: params.protocolVersion ?? "2024-11-05",
                    capabilities: { tools: {} },
                    serverInfo: { name: "openmausbot-agents", version: "0.1.0" },
                });
            case "notifications/initialized":
            case "notifications/cancelled":
                return undefined;
            case "ping":
                return ok(id, {});
            case "tools/list":
                return ok(id, capToolListResult({ tools: listed }, limit, (line) => console.warn(`[agents] ${line}`)));
            case "tools/call": {
                const called = { name: params.name, arguments: (params.arguments ?? {}) };
                // Security: past the bridge a use_tool call is a direct call: same unknown-tool check, callTool and result bounds.
                const bridged = bridge ? await bridge.route(called.name, called.arguments) : undefined;
                if (bridged && "answer" in bridged)
                    return textResult(id, bridged.answer.text, bridged.answer.isError);
                const { name, arguments: args } = bridged ?? called;
                // An alias runs only where the tool it names is listed: never a way to a tool this turn was not given.
                const runs = resolveAgentsCall(name, args).name;
                if (!available.some((t) => t.name === runs)) {
                    // A name written into use_tool fails the call, not the protocol: the chat runtime ends a turn on a protocol error.
                    const unknown = `Unknown tool: ${name}`;
                    return bridged ? textResult(id, unknown, true) : rpcErr(id, -32602, unknown);
                }
                const startedAt = Date.now();
                try {
                    const { text, isError, passthrough } = await callTool(name, args, context);
                    await sendToolReceipt(context, name, args, startedAt, { ok: !isError, error: text });
                    if (passthrough)
                        return ok(id, passthrough);
                    return textResult(id, name === "tool_result_read" ? text : await capResult(text, context), isError);
                }
                catch (e) {
                    await sendToolReceipt(context, name, args, startedAt, { ok: false, error: e.message });
                    return textResult(id, await capResult(e.message, context), true);
                }
            }
            default:
                return id !== undefined ? rpcErr(id, -32601, `Method not found: ${method}`) : undefined;
        }
    };
}
