// Vocabulary for "phone apps as bot tools": the apps a paired phone may allow,
// per-bot grants, and the PHONE_* tool names served by the `device` MCP server.
import { isReadOnlyAction } from "./connector-scopes.js";
export const PHONE_CAPABILITIES = ["calendar", "reminders", "contacts", "location", "home", "messages"];
export const PHONE_SLUG = "phone";
export const PHONE_MCP_SERVER = "device";
export const PHONE_PLATFORMS = ["ios", "android"];
export const PHONE_TOOL_NAMES = [
    "PHONE_LIST_EVENTS", "PHONE_GET_EVENT", "PHONE_FIND_FREE_TIME", "PHONE_CREATE_EVENT", "PHONE_UPDATE_EVENT", "PHONE_DELETE_EVENT", "PHONE_RESPOND_TO_INVITE",
    "PHONE_LIST_REMINDERS", "PHONE_CREATE_REMINDER", "PHONE_UPDATE_REMINDER", "PHONE_COMPLETE_REMINDER", "PHONE_DELETE_REMINDER",
    "PHONE_SEARCH_CONTACTS", "PHONE_GET_CONTACT", "PHONE_CREATE_CONTACT", "PHONE_UPDATE_CONTACT",
    "PHONE_GET_LOCATION", "PHONE_FIND_PLACES_NEARBY",
    "PHONE_LIST_HOME", "PHONE_SET_ACCESSORY", "PHONE_RUN_SCENE",
    "PHONE_SEND_MESSAGE", "PHONE_SEND_WHATSAPP",
];
const TOOL_CAPABILITY = {
    PHONE_LIST_EVENTS: "calendar", PHONE_GET_EVENT: "calendar", PHONE_FIND_FREE_TIME: "calendar", PHONE_CREATE_EVENT: "calendar",
    PHONE_UPDATE_EVENT: "calendar", PHONE_DELETE_EVENT: "calendar", PHONE_RESPOND_TO_INVITE: "calendar",
    PHONE_LIST_REMINDERS: "reminders", PHONE_CREATE_REMINDER: "reminders", PHONE_UPDATE_REMINDER: "reminders",
    PHONE_COMPLETE_REMINDER: "reminders", PHONE_DELETE_REMINDER: "reminders",
    PHONE_SEARCH_CONTACTS: "contacts", PHONE_GET_CONTACT: "contacts", PHONE_CREATE_CONTACT: "contacts", PHONE_UPDATE_CONTACT: "contacts",
    PHONE_GET_LOCATION: "location", PHONE_FIND_PLACES_NEARBY: "location",
    PHONE_LIST_HOME: "home", PHONE_SET_ACCESSORY: "home", PHONE_RUN_SCENE: "home",
    PHONE_SEND_MESSAGE: "messages", PHONE_SEND_WHATSAPP: "messages",
};
export function isPhoneToolName(name) {
    return typeof name === "string" && Object.hasOwn(TOOL_CAPABILITY, name);
}
export function phoneToolCapability(name) {
    return TOOL_CAPABILITY[name];
}
/** GET/LIST/SEARCH/FIND read; everything else writes (isReadOnlyAction(name, "phone")). */
export function isPhoneWrite(name) {
    return !isReadOnlyAction(name, PHONE_SLUG);
}
export function phoneToolSends(name) {
    return name.startsWith("PHONE_SEND_");
}
/** Unknown key or value → null; `{}` is valid (everything off). */
export function normalizePhoneApps(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return null;
    const out = {};
    for (const [key, grant] of Object.entries(value)) {
        if (!PHONE_CAPABILITIES.includes(key))
            return null;
        if (grant !== "read" && grant !== "write")
            return null;
        out[key] = grant;
    }
    return out;
}
export const ALL_PHONE_APPS = Object.fromEntries(PHONE_CAPABILITIES.map((c) => [c, "write"]));
