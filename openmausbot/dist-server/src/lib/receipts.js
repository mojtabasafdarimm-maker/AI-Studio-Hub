export function isReceipt(message) {
    return message.kind === "digest" || message.kind === "compaction" || message.kind === "call";
}
export function lastNonReceipt(messages) {
    if (!messages)
        return undefined;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (!isReceipt(messages[i]))
            return messages[i];
    }
    return undefined;
}
