import { noticeFailure, noticeSummary } from "../chat-notices.js";
const CARD_PREFIX = "elicitation:";
const text = (value) => (typeof value === "string" ? value.trim() : "");
/** `write` settles true once the frame reached the CLI's stdin, false when it could not be sent. */
export function claudeElicitations(write, emit) {
    const pending = new Set();
    // Answers still being written to the CLI; true once the card was withdrawn meanwhile.
    const sending = new Map();
    const reply = (id, response) => write({ type: "control_response", response: { subtype: "success", request_id: id, response } });
    const resolved = (id, behavior, source) => emit({ type: "request.resolved", requestId: CARD_PREFIX + id, behavior, source });
    return {
        /** Consumes an elicitation frame or its withdrawal; false for every other frame. */
        frame(o) {
            if (o?.type === "control_cancel_request") {
                if (typeof o.request_id !== "string")
                    return false;
                if (sending.has(o.request_id)) {
                    if (!sending.get(o.request_id))
                        resolved(o.request_id, "deny", "timeout");
                    sending.set(o.request_id, true);
                    return true;
                }
                if (!pending.delete(o.request_id))
                    return false;
                resolved(o.request_id, "deny", "timeout");
                return true;
            }
            if (o?.type !== "control_request" || o.request?.subtype !== "elicitation" || typeof o.request_id !== "string")
                return false;
            const id = o.request_id;
            const r = o.request;
            const serverName = text(r.mcp_server_name);
            const server = text(r.display_name) || serverName;
            const message = text(r.message);
            const properties = r.requested_schema?.properties;
            const required = r.requested_schema?.required;
            // A required name with no declared property still needs a value the card can't collect.
            const fields = new Set([
                ...(properties && typeof properties === "object" ? Object.keys(properties) : []),
                ...(Array.isArray(required) ? required.filter((name) => typeof name === "string") : []),
            ]).size;
            if (r.mode === "url" || fields > 0) {
                void reply(id, { action: "decline" });
                const url = text(r.url);
                const withUrl = /^https:\/\//i.test(url);
                const key = r.mode === "url"
                    ? `chat.notice.elicitationUrlDeclined${server ? "" : "Generic"}${withUrl ? "WithUrl" : ""}`
                    : `chat.notice.elicitationFormDeclined${server ? "" : "Generic"}${fields === 1 ? "One" : "Many"}${message ? "Message" : ""}`;
                emit({
                    type: "runtime.notice",
                    ...noticeFailure(key, {
                        ...(server ? { server } : {}),
                        ...(r.mode === "url" ? withUrl ? { url } : {} : {
                            ...(fields === 1 ? {} : { fields }),
                            ...(message ? { message } : {}),
                        }),
                    }),
                });
                return true;
            }
            pending.add(id);
            const summary = message
                ? server ? { summary: `${server}: ${message}` } : noticeSummary("chat.notice.elicitationMessageGeneric", { message })
                : server ? noticeSummary("chat.notice.elicitationContinue", { server }) : noticeSummary("chat.notice.elicitationContinueGeneric");
            emit({
                type: "request.opened",
                requestId: CARD_PREFIX + id,
                requestType: "permission",
                tool: serverName ? `mcp__${serverName}` : "mcp",
                ...summary,
                // The server asks, not a tool: Auto mode and remembered tool grants never answer it.
                requiresExplicitApproval: true,
            });
            return true;
        },
        /**
         * The person's answer to one of these cards: "sent" once the CLI has it, "failed" when it could not be
         * delivered (the card is withdrawn, never shown as approved), false when the card is not an open elicitation.
         */
        async answer(requestId, behavior) {
            const id = requestId.startsWith(CARD_PREFIX) ? requestId.slice(CARD_PREFIX.length) : "";
            if (!pending.delete(id))
                return false;
            sending.set(id, false);
            const delivered = await reply(id, behavior === "allow" ? { action: "accept", content: {} } : { action: "decline" });
            const cancelled = sending.get(id);
            sending.delete(id);
            // The card was withdrawn (CLI cancelled, session closed) while the answer was on its way: it never counts.
            if (cancelled)
                return "failed";
            if (!delivered) {
                resolved(id, "deny", "system");
                return "failed";
            }
            resolved(id, behavior === "allow" ? "allow" : "deny", "user");
            return "sent";
        },
        /** The CLI that asked is gone: every open card is withdrawn. */
        close() {
            for (const id of pending)
                resolved(id, "deny", "system");
            pending.clear();
            // Answers still on their way are withdrawn now too; answer() then reports them as failed.
            for (const [id, withdrawn] of sending) {
                if (withdrawn)
                    continue;
                resolved(id, "deny", "system");
                sending.set(id, true);
            }
        },
    };
}
