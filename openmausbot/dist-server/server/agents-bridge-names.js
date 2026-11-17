// The name a call made through the agents tool bridge is read as. Imports no engine driver.
import { AGENTS_TOOL_ALIASES } from "../shared/agents-tool-names.js";
import { WATCHER_OPTIONS_CARD_BOT_ID } from "../shared/options-card.js";
import { bridgedCallTitle } from "./drivers/agents-bridge.js";
import { availableTools } from "./drivers/agents-catalog.js";
/** Every catalog tool's name, whoever may call it, and every alias a call may still use. */
export const CATALOG_TOOL_NAMES = new Set([...availableTools({
        skillAuthoring: true, sharedComputers: true, voiceNotes: true, xResearch: true, research: true, team: true,
        computerSelection: true, cloudHome: false, chief: true, mausbot: true, botId: WATCHER_OPTIONS_CARD_BOT_ID,
    }).map((tool) => tool.name), ...Object.keys(AGENTS_TOOL_ALIASES)]);
/** A call's name with a bridged call read as the tool it ran. With `serverNamed`, only a title that names
 * the agents server is read: a bare `use_tool` on an engine that omits the server (Codex) could be any server's. */
export function bridgedCallName(title, input, options = {}) {
    return bridgedCallTitle(title, input, (name) => CATALOG_TOOL_NAMES.has(name), options.serverNamed !== true);
}
