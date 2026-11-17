import { botOwner } from "../shared/bot-owner.js";
const GRANTS = ["composio", "connectorTools", "connectorScopes", "mcpServers"];
const audience = (bot) => JSON.stringify(bot.visibility ?? "everyone");
/** The connected apps a bot a Chief creates starts with: a copy of the Chief's own grants and levels, never more.
 * Security: only a bot with the Chief's owner and exactly the Chief's audience gets them, so nobody reaches an app
 * through it that they could not reach through the Chief; any other starts with connected apps and MCP servers off.
 * On a Team Cloud a grant names an app, never a connection: whose connection a turn uses stays the relay's call. */
export function appsFromCreator(creator, created) {
    if (botOwner(creator) !== botOwner(created) || audience(creator) !== audience(created)) {
        return { composio: false, connectorTools: {}, mcpServers: [] };
    }
    const grants = {};
    for (const key of GRANTS)
        if (creator[key] !== undefined)
            Object.assign(grants, { [key]: structuredClone(creator[key]) });
    // Absent would mean every tool once connected apps are turned on.
    if (grants.composio === false)
        grants.connectorTools ??= {};
    return grants;
}
