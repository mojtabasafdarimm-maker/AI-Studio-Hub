export function isSkillSwitchAction(action) {
    return action === "enable" || action === "disable" || action === "delete";
}
export function skillSwitchVerb(action) {
    return action === "enable" ? "turn on" : action === "disable" ? "turn off" : "delete";
}
/** The hash a current client may echo after it displayed the complete
 * proposal. Old cards deliberately return undefined and remain deny-only. */
export function reviewedSkillSha256(request) {
    if (!request.preview || !request.sha256 || !/^[a-f0-9]{64}$/i.test(request.sha256))
        return undefined;
    return request.sha256;
}
/** Map the server-authored affirmative labels explicitly and fail closed for
 * anything else. This keeps new Update/Apply wording working without turning
 * an unknown or corrupted card answer into approval. */
export function skillRequestBehavior(answer) {
    const normalized = answer.trim().toLowerCase();
    return ["enable", "turn on", "turn off", "delete", "update", "apply", "allow", "allow once", "confirm", "yes"].includes(normalized)
        ? "allow"
        : "deny";
}
