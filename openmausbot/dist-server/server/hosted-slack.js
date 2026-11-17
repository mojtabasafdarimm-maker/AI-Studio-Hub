import { hostedWorkspaceConfiguration } from "./enterprise.js";
/** Identifiers only: opening the link never grants access to the service. */
export function hostedSlackManagement(botId, runtimeReady, env = process.env) {
    const hosted = hostedWorkspaceConfiguration(env);
    if (!runtimeReady || !hosted?.portalMembership)
        return { available: false };
    const management = new URL("/slack", hosted.admin);
    management.search = new URLSearchParams({ workspace: hosted.workspace, bot: botId }).toString();
    return { available: true, managementUrl: management.href };
}
