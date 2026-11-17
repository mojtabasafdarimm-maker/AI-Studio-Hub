import { redactSecretsInText } from "../../shared/redact.js";
import { noticeSummary } from "../chat-notices.js";
import { describeAction } from "./access.js";
const WRITES = new Set([
    "PHONE_CREATE_EVENT", "PHONE_UPDATE_EVENT", "PHONE_DELETE_EVENT", "PHONE_RESPOND_TO_INVITE",
    "PHONE_CREATE_REMINDER", "PHONE_UPDATE_REMINDER", "PHONE_COMPLETE_REMINDER", "PHONE_DELETE_REMINDER",
    "PHONE_CREATE_CONTACT", "PHONE_UPDATE_CONTACT", "PHONE_SET_ACCESSORY", "PHONE_RUN_SCENE", "PHONE_SEND_MESSAGE", "PHONE_SEND_WHATSAPP",
]);
export function phoneWriteSummary(name, phone) {
    const action = describeAction(name);
    if (!WRITES.has(name))
        return { summary: `${action} on ${phone}`.slice(0, 240) };
    return noticeSummary(`chat.notice.phone.write.${name}`, { phone: redactSecretsInText(phone).slice(0, Math.max(0, 240 - action.length - " on ".length)) });
}
