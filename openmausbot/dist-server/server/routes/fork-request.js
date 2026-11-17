export function forkMessageId(body) {
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "messageId") ||
        typeof body.messageId !== "string")
        return null;
    return body.messageId;
}
