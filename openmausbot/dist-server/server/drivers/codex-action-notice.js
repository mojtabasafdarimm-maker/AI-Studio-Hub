import { noticeFailure } from "../chat-notices.js";
export function codexActionFailure(message, mayHaveRun, text) {
    return mayHaveRun ? noticeFailure("chat.notice.codexActionMayHaveRun", { message }) : { message, ...(text ? { text } : {}) };
}
