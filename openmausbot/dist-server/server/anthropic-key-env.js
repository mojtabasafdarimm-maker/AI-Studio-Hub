/** The workspace Anthropic key for one Claude instance: Claude (API key) always runs on it, and "every Claude bot"
 * (unset means on) adds every other Claude instance without taking it from Claude (API key). */
export function anthropicKeyEnv(anthropic, claudeApiInstance) {
    if (!anthropic?.key || (!claudeApiInstance && anthropic.everyClaudeBot === false))
        return {};
    return { ANTHROPIC_API_KEY: anthropic.key, ...(anthropic.url ? { ANTHROPIC_BASE_URL: anthropic.url } : {}) };
}
