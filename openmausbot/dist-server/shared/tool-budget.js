/** The most tools one Chat Completions request may carry: OpenAI-compatible endpoints refuse more than 128. */
export const CHAT_TOOL_LIMIT = 128;
/** What one server's tool count alone does to a chat-engine turn: past the limit it can only be searched, and from half of
 * it on it pushes other servers into the search. */
export function chatToolBudgetFit(tools, limit = CHAT_TOOL_LIMIT) {
    if (tools >= limit)
        return "exceeds";
    return tools * 2 >= limit ? "crowds" : "fits";
}
