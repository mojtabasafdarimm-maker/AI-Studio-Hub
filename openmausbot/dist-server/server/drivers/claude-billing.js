/** What a Claude instance's turns bill: `claude -p` runs on an ANTHROPIC_API_KEY in its environment ahead of any login,
 * billed per token (2.1.303), as it does on the CLI's own API-key sign-in. Amazon Bedrock bills the AWS account per token. */
export function claudeBilling(env, account) {
    if (env.CLAUDE_CODE_USE_BEDROCK === "1")
        return { billing: "metered" };
    return env.ANTHROPIC_API_KEY || account?.method === "api-key"
        ? { account: { ...account, method: "api-key" }, billing: "metered" }
        : { billing: "subscription" };
}
const calls = new WeakMap();
const count = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
/** One model call's usage from its stream: `message_start` opens it, and each `message_delta` carries the running totals,
 * a field it leaves null keeping its start value (stream-json with --include-partial-messages, 2.1.303). The assistant
 * frames repeat the start's figures, so only the delta reports the call's whole output. */
export function claudeCallUsage(session, event) {
    if (event.type === "message_start") {
        const usage = event.message?.usage && typeof event.message.usage === "object" ? event.message.usage : {};
        calls.set(session, { ...(typeof event.message?.id === "string" ? { id: event.message.id } : {}),
            usage: Object.fromEntries(Object.entries(usage).filter(([, value]) => typeof value === "number")) });
        return null;
    }
    const call = calls.get(session);
    if (event.type !== "message_delta" || !call || !event.usage || typeof event.usage !== "object")
        return null;
    for (const [key, value] of Object.entries(event.usage))
        if (typeof value === "number")
            call.usage[key] = value;
    const { input_tokens: fresh, cache_read_input_tokens: read, cache_creation_input_tokens: written, output_tokens: output } = call.usage;
    if (!count(fresh) && !count(read) && !count(written))
        return null;
    return {
        type: "thread.token-usage.updated", ...(call.id ? { itemId: call.id } : {}),
        input: count(fresh) + count(read), output: count(output), ...(typeof read === "number" ? { cachedInput: read } : {}),
        contextTokens: count(fresh) + count(read) + count(written),
    };
}
