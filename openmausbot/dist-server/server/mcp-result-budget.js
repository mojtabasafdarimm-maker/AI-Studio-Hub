import { brokerRemoteMcp } from "./bot-box/broker-mcp.js";
import { parseStoredMcpServer } from "./mcp-registry.js";
export function customMcpResultBudgets(cfg, names) {
    const out = {};
    for (const name of names) {
        const raw = cfg.mcpServers?.[name];
        if (raw === undefined)
            continue;
        const parsed = parseStoredMcpServer(name, raw);
        if (parsed.ok && parsed.server.resultBudget !== undefined)
            out[name] = parsed.server.resultBudget;
    }
    return out;
}
/** Budgets ride beside the specs, so a server mounted ungated never carries a field its engine rejects. */
export function attachCustomMcp(integrations, custom, cfg, 
/** The turn, so a URL server's secret headers stay with the credential broker on a boxed Cloud home (server/bot-box). */
turn, 
/** The connected app a URL server's sign-in refusal points to instead, when this turn can use it. */
appFor) {
    if (!Object.keys(custom).length)
        return;
    integrations.custom = turn ? brokerRemoteMcp(custom, turn, undefined, appFor) : custom;
    const budgets = customMcpResultBudgets(cfg, Object.keys(custom));
    if (Object.keys(budgets).length)
        integrations.customResultBudgets = budgets;
}
