// Wire shapes of the usage trace view, shared by the server's builder and the renderer.
import { TOOL_NAMESPACE, toolSurfaceKind } from "./tool-surface.js";
import { isConnectedAppsServer, OWN_APPS_SERVER } from "./own-apps.js";
export function traceRootId(threadId, turnId) {
    return `${encodeURIComponent(threadId)}~${encodeURIComponent(turnId)}`;
}
const SERVER_ICONS = { phone: "phone", data: "data", dweb: "web", browser: "browser", computer: "computer" };
const OWN_SERVERS = new Set(["agents", "ogb", "composio", OWN_APPS_SERVER, ...Object.keys(SERVER_ICONS)]);
const COMPOSIO_ACTION = /^([A-Z][A-Z0-9]+)_[A-Z0-9_]+$/;
const BUILT_IN_ICONS = [
    [/^(?:websearch|web_search|search_web|google_search|x_search|research)$/, "search"],
    [/^(?:webfetch|web_fetch|fetch|open_url|read_url|fetch_url)$/, "web"],
    [/^(?:bash|shell|terminal|run_command|execute|exec|vm_exec|computer_exec|run_shell_command|local_shell|killshell|bashoutput)$/, "terminal"],
    [/^(?:read|read_file|write|write_file|create_file|edit|multiedit|str_replace|apply_patch|notebookedit|delete|grep|glob|find|ls|list_files|attach_file|view|tool_result_read)$/, "files"],
    [/^(?:memory|remember|recall|memory_[a-z_]+|search_memory|save_memory|session_search|session_read)$/, "memory"],
    [/^(?:routine|routines|schedule|cron)(?:_[a-z_]+)?$|^[a-z_]*(?:routine|trigger)[a-z_]*$/, "routine"],
    [/^(?:publish_app|publish_page|unpublish_page|[a-z_]*page_publish[a-z_]*|pages?_[a-z_]+)$/, "page"],
    [/^(?:show_html|show_widget|render_widget|show_chart|show_table|show_card|widget|[a-z_]*_card)$/, "widget"],
    [/^(?:coordinate_bots|ask_bots?|delegate|task|agent|assignment_status|send_to_bot|select_computer|create_bot)$/, "bots"],
    [/^(?:(?:open|start|list|close|retry)_threads?|list_bots|list_rooms|list_room_targets|post_to_room|create_room|manage_room)$/, "bots"],
    [/^(?:phone|android|adb)(?:_[a-z_]+)?$/, "phone"],
    [/^(?:todowrite|update_plan|plan|think)$/, "plan"],
    [/^(?:generate_image|image_generation|imagegen|create_image)$/, "image"],
];
/** What a tool call should look like in a trace: an icon, and the app or MCP server it belongs to. */
export function traceToolLook(name) {
    const server = /^mcp__(.+?)__/.exec(name)?.[1];
    const bare = name.replace(TOOL_NAMESPACE, "");
    const composio = COMPOSIO_ACTION.exec(bare);
    if (composio && composio[1] !== "COMPOSIO")
        return { icon: "app", app: composio[1].toLowerCase() };
    if ((server && isConnectedAppsServer(server)) || composio)
        return { icon: "app" };
    const surface = toolSurfaceKind(name);
    if (surface)
        return { icon: surface };
    const lower = bare.toLowerCase();
    for (const [pattern, icon] of BUILT_IN_ICONS)
        if (pattern.test(lower))
            return { icon };
    if (server && SERVER_ICONS[server])
        return { icon: SERVER_ICONS[server] };
    if (server && !OWN_SERVERS.has(server))
        return { icon: "mcp", server };
    return { icon: "tool" };
}
