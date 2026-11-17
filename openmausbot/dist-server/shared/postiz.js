// Postiz (postiz.com), the social media scheduler, through its own MCP server. OpenMausBot only calls Postiz's public
// MCP and OAuth endpoints: Postiz is AGPL-3.0 and none of its code is copied here.
/** The MCP server name bots see the Postiz tools under (`mcp__postiz__…` on Claude Code). */
export const POSTIZ_SERVER = "postiz";
/** Postiz Cloud's backend, as its published OAuth metadata names it (checked 2026-10-29). */
export const POSTIZ_CLOUD = "https://api.postiz.com";
/** Where a Postiz organisation API key comes from. */
export const POSTIZ_KEY_PAGE = "https://platform.postiz.com/settings";
export function isPostizStatus(value) {
    if (!value || typeof value !== "object")
        return false;
    const status = value;
    return typeof status.state === "string" && typeof status.address === "string" && typeof status.host === "string"
        && (status.how === null || status.how === "sign-in" || status.how === "key");
}
