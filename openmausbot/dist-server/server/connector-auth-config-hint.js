import { withFailedCallHint } from "./connector-scope-hint.js";
const NO_MANAGED_AUTH = /does not manage auth for toolkit\s+([A-Za-z0-9_-]+)/i;
export function noManagedAuthToolkit(text) {
    return NO_MANAGED_AUTH.exec(text)?.[1]?.toLowerCase() ?? null;
}
/** Which of the person's auth configs connects `toolkit`, in words for the bot. */
export function authConfigUseLine(toolkit, choice) {
    const which = choice.named ? ", the one asked for" : choice.of > 1 ? `, the most recently created of their ${choice.of} enabled ones` : "";
    return `${toolkit} connects with the person's own Composio auth config ${choice.id}${which}.`;
}
const MANAGED_NOTE = (toolkit) => `OpenMausBot note: ${toolkit} has no Composio-managed sign-in, so it needs the person's own OAuth app, which `
    + "OpenMausBot's built-in connected apps cannot use. Tell the person: add their own Composio project key in "
    + `Settings → AI → Other services (the project that has their ${toolkit} auth config); OpenMausBot then picks that auth config up `
    + `on its own, and they connect ${toolkit} again. Do not retry this call.`;
function selfHostedNote(toolkit, ready) {
    if (ready instanceof Error)
        return `OpenMausBot note: ${ready.message} Tell the person this. Do not retry this call.`;
    if (ready.choice) {
        return `OpenMausBot note: ${toolkit} has no Composio-managed sign-in. ${authConfigUseLine(toolkit, ready.choice)} `
            + `Call COMPOSIO_MANAGE_CONNECTIONS with toolkits ["${toolkit}"] to show the person a card that connects it, then `
            + "end the turn. Do not retry this call before that.";
    }
    const unread = ready.readError ? ` OpenMausBot could not read their auth configs just now (Composio said: ${ready.readError}).` : "";
    return `OpenMausBot note: ${toolkit} has no Composio-managed sign-in, so it needs an auth config with the person's own `
        + `OAuth app in their Composio project, and there is no enabled one for ${toolkit}.${unread} Tell them to create one `
        + "(Auth Configs → Create in their Composio project, with their app's client ID and secret); OpenMausBot then uses "
        + `it on its own, and they connect ${toolkit} again. Do not retry this call.`;
}
/** Adds a plain note to a tool result that failed with Composio's no-managed-auth error. With the person's own project
 * (`ready`), the note follows readying that toolkit's auth config, so the next connection uses it. */
export async function withNoManagedAuthNote(bytes, contentType, toolkit, ready) {
    const probe = withFailedCallHint(bytes, contentType, NO_MANAGED_AUTH, () => "", []);
    if (probe === bytes)
        return bytes;
    const note = ready
        ? selfHostedNote(toolkit, await ready().catch((error) => error instanceof Error ? error : new Error(String(error))))
        : MANAGED_NOTE(toolkit);
    return withFailedCallHint(bytes, contentType, NO_MANAGED_AUTH, () => note, []);
}
