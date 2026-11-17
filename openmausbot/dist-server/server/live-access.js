export const LIVE_AZURE_REFUSAL = "Live calls here go through Azure OpenAI, so only an admin or the owner of this server can start one. Ask an admin if you need a call.";
export const LIVE_CUSTOM_REFUSAL = "Live calls here go through a custom endpoint, so only an admin or the owner of this server can start one. Ask an admin if you need a call.";
export const LIVE_FISH_REFUSAL = "Live calls here go through Fish Audio, so only an admin or the owner of this server can start one. Ask an admin if you need a call.";
export const LIVE_GEMINI_REFUSAL = "Live calls here go through Gemini, so only an admin or the owner of this server can start one. Ask an admin if you need a call.";
export const LIVE_ELEVENLABS_REFUSAL = "Live calls here go through ElevenLabs, so only an admin or the owner of this server can start one. Ask an admin if you need a call.";
/** Null only for an admin or the single owner. A caller this does not recognise is refused. */
export function azureLiveCallRefusal(auth, place, refusal = LIVE_AZURE_REFUSAL) {
    if (!auth.scopes.includes("admin"))
        return refusal;
    if (auth.kind === "session")
        return auth.session.teamRole === "member" || auth.session.moveIn ? refusal : null;
    if (auth.kind === "loopback")
        return auth.trust === "service" || place.othersOnLoopback ? refusal : null;
    return refusal;
}
export function fishLiveCallRefusal(auth, place) {
    return azureLiveCallRefusal(auth, place, LIVE_FISH_REFUSAL);
}
export function geminiLiveCallRefusal(auth, place) {
    return azureLiveCallRefusal(auth, place, LIVE_GEMINI_REFUSAL);
}
export function elevenLabsLiveCallRefusal(auth, place) {
    return azureLiveCallRefusal(auth, place, LIVE_ELEVENLABS_REFUSAL);
}
/** The words for a session without the admin scope, which never reaches a Live route. Only the words: the request is refused either way. */
export function liveScopeRefusal(cfg, method, path) {
    if (method.toUpperCase() !== "POST" || path !== "/api/live/session")
        return null;
    const provider = cfg.live?.provider;
    return provider === "azure" ? LIVE_AZURE_REFUSAL : provider === "fish" ? LIVE_FISH_REFUSAL : provider === "gemini" ? LIVE_GEMINI_REFUSAL
        : provider === "elevenlabs" ? LIVE_ELEVENLABS_REFUSAL : provider === "custom" ? LIVE_CUSTOM_REFUSAL : null;
}
