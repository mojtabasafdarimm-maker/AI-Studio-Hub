import { userErrorFields } from "./user-errors.js";
const START_FAILURE = {
    "serverError.computer.desktopOnly": "chat.notice.computerDesktopOnly",
    "serverError.computer.permissionsThenRestart": "chat.notice.computerPermissionsThenRestart",
    "serverError.computer.notReadyDetail": "chat.notice.computerNotReadyDetail",
    "serverError.computer.notReadyMacPermission": "chat.notice.computerNotReadyMacPermission",
    "serverError.computer.systemUnsupported": "chat.notice.computerSystemUnsupported",
    "serverError.computer.aiUnsupported": "chat.notice.computerAiUnsupported",
    "serverError.engine.signedOut": "chat.notice.engineSignedOut",
};
export function startFailureText(error) {
    const fields = userErrorFields(error);
    if (!fields.errorKey || !Object.hasOwn(START_FAILURE, fields.errorKey))
        return undefined;
    return { key: START_FAILURE[fields.errorKey], ...(fields.errorParams ? { params: fields.errorParams } : {}) };
}
