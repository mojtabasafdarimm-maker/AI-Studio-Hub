import { noticeFailure } from "../chat-notices.js";
export class RuntimeNoticeError extends Error {
    text;
    constructor(message, key, params) {
        super(message);
        this.text = noticeFailure(key, params).text;
    }
}
export function runtimeErrorText(error) {
    return error instanceof RuntimeNoticeError ? error.text : undefined;
}
