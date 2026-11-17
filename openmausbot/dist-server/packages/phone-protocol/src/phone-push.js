/** Closed-app phone alerts, version 1: what a paired phone sends its computer or Cloud, what that server sends the push
 * relay in the hosted control plane (cloudflare/control-plane), and what the phone receives from Apple or Google.
 *
 * A push is content-free by construction: the alert's kind, a title built from the bot's and room's names, opaque ids
 * and the phone's own tag for the computer. Never message text, a reply, a file path or a secret. The phone fetches the
 * content from its computer when it opens. */
export const PHONE_PUSH_WIRE_VERSION = 1;
/** The phone's own route on its computer or Cloud: `PUT` registers or updates, `GET` reads back, `DELETE` removes. Keyed
 * by what authenticated the request (a paired session, or the device the companion vouched for), never by the body. */
export const PHONE_PUSH_ROUTE = "/api/push/device";
/** The relay's paths, under the control plane's origin. Each takes `Authorization: Bearer <omb_install_…>`. */
export const PHONE_PUSH_RELAY_PATHS = {
    register: "/v1/installations/self/push/register",
    unregister: "/v1/installations/self/push/unregister",
    send: "/v1/installations/self/push/send",
};
export const PUSH_PLATFORMS = ["apns", "fcm"];
/** An APNs device token as the phone hands it over: lowercase hex. */
export const APNS_TOKEN = /^[0-9a-f]{64,200}$/;
/** An FCM registration token. */
export const FCM_TOKEN = /^[A-Za-z0-9_:-]{64,4096}$/;
/** The phone's opaque tag for one saved computer, echoed in every push so a tap opens the right one. */
export const PAIRING_TAG = /^[A-Za-z0-9_-]{8,64}$/;
/** The notification identifier a push carries: at most 64 bytes, APNs' limit for `apns-collapse-id`. */
export const PUSH_COLLAPSE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
export const PUSH_ID = /^[\w-]{1,120}$/;
export const PUSH_NAME_MAX = 80;
export const PUSH_TITLE_MAX = 200;
/** The kinds a closed app is woken for: a bot waits on the person (approval, question, sign-in), or a reply is ready.
 * Everything else reaches the phone only while it is connected. */
export const PUSH_KINDS = ["approval", "question", "sign-in", "done"];
/** The relay's error codes a server acts on. Anything else is transient. */
export const PUSH_RELAY_ERRORS = {
    unknownDevice: "push_device_unknown",
    unregistered: "push_device_unregistered",
    unavailable: "push_unavailable",
};
/** `openmaus.<threadId>.<seq>`, the identifier the phone gives the notification the live stream would post for the
 * same frame, so a push and that notification replace each other. Undefined when it would not fit. */
export function phonePushCollapseId(threadId, seq) {
    const id = `openmaus.${threadId}.${seq}`;
    return Number.isSafeInteger(seq) && seq >= 0 && PUSH_COLLAPSE_ID.test(id) ? id : undefined;
}
export function isPushKind(kind) {
    return PUSH_KINDS.includes(kind);
}
export function validPushToken(platform, token) {
    return platform === "apns" ? APNS_TOKEN.test(token) : FCM_TOKEN.test(token);
}
/** The phone's Live Activity and ongoing-notification registration on its computer or Cloud: `PUT` replaces it whole,
 * `GET` reads it back, `DELETE` removes it. Keyed like `PHONE_PUSH_ROUTE`. */
export const PHONE_ACTIVITY_ROUTE = "/api/push/activity";
export const PHONE_ACTIVITY_RELAY_PATH = "/v1/installations/self/push/activity";
export const ACTIVITY_ASKS = ["approval", "question", "signIn", "other"];
