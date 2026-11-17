// Every built-in tool a bot can be shown, by the switch that leaves it out. agents-tool-groups.test.ts holds every
// catalog tool to exactly one entry here, so a new tool is placed on purpose.
import { isToolGroup } from "../../shared/tool-groups.js";
import { HOSTING_TOOL_NAMES } from "./agents-hosting-tools.js";
import { IMAGE_TOOL_NAMES } from "./agents-image-tools.js";
import { MEETING_TOOL_NAMES } from "./agents-meeting-tools.js";
import { PAGE_TOOL_NAMES } from "./agents-pages-tools.js";
import { RESEARCH_TOOL_NAMES } from "./agents-research-tools.js";
/** Each group's tools on the agents server, and the whole MCP servers (turn integrations) it stands for. */
export const TOOL_GROUP_MEMBERS = {
    meetings: { tools: MEETING_TOOL_NAMES, servers: [] },
    data: { tools: new Set(), servers: ["data"] },
    pages: { tools: new Set(["show_html", ...PAGE_TOOL_NAMES, ...HOSTING_TOOL_NAMES]), servers: [] },
    images: { tools: IMAGE_TOOL_NAMES, servers: [] },
    email: { tools: new Set(), servers: ["email"] },
};
/** Groups with a bot switch of their own, kept where it was: Memory (`memoryEnabled`), Research (`xResearch`), and
 * Connected apps (`composio`) and the built-in browser (`browser`), which are whole servers. */
export const OWN_SWITCH_TOOLS = {
    memory: new Set(["memory_update", "memory_log"]),
    research: RESEARCH_TOOL_NAMES,
};
/** What every bot keeps: talking to the person and its team, its own setup, routines and waits, and its computer. */
export const CORE_TOOLS = new Set([
    "tool_result_read", "list_shared_computers", "shared_computer", "ask_for_computer", "list_room_targets", "coordinate_bots",
    "assignment_status", "list_bots", "usage_limits", "list_rooms", "select_computer", "reset_cloud_computer", "list_threads",
    "close_thread", "rename_thread", "start_thread", "burst", "list_models", "vm_exec", "attach_file", "show_widget", "create_options_card",
    "post_to_room", "post_to_thread", "create_bot", "list_team_setup", "list_team_library", "propose_team_setup",
    "propose_bot_deletion", "manage_room", "request_credential", "request_sign_in", "fill_login", "send_voice_note", "decide",
    "extract", "message_person", "report_bug", "retry_thread", "session_search", "trigger_info", "trigger", "delete_trigger",
    "wait_until", "list_waits", "cancel_wait", "propose_profile", "propose_model", "propose_team_memory", "skills_list",
    "skill_manage", "mcp_server", "app_settings", "list_unread_notifications", "mark_notifications_read",
]);
/** The agents tools the groups in `off` leave out. */
export function toolsOffNames(off) {
    return new Set(off.flatMap((group) => [...TOOL_GROUP_MEMBERS[group].tools]));
}
/** `tools` without the ones the groups in `off` leave out. */
export function withoutToolsOff(tools, off) {
    const names = toolsOffNames(off);
    return names.size ? tools.filter((tool) => !names.has(tool.name)) : tools;
}
/** Whether the groups in `off` leave out the whole MCP server `server`. */
export function serverTurnedOff(off, server) {
    return (off ?? []).filter(isToolGroup).some((group) => TOOL_GROUP_MEMBERS[group].servers.includes(server));
}
