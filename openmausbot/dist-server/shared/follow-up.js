// A message a person sends while their bot works: steer it into the running turn, queue it for after that turn, or
// restart the turn with it. The composer resolves the choice; the server's direct-busy admission applies it.
export const FOLLOW_UPS = ["steer", "queue", "restart"];
export const DEFAULT_FOLLOW_UP = "steer";
/** undefined when absent, null when present but not a follow-up. */
export function parseFollowUp(value) {
    if (value === undefined || value === null)
        return undefined;
    return FOLLOW_UPS.find((followUp) => followUp === value) ?? null;
}
/** null: nothing is running, so it is an ordinary send. A turn that cannot take steering input always queues. */
export function resolveFollowUp(input) {
    if (!input.running)
        return null;
    if (!input.canSteer)
        return "queue";
    const preferred = input.preferred ?? DEFAULT_FOLLOW_UP;
    if (input.alternate)
        return preferred === "queue" ? "steer" : "queue";
    return preferred;
}
/** The send menu while a turn runs: what Enter does first, then the other one where the turn can be steered, then restart. */
export function followUpChoices(preferred, canSteer) {
    const first = resolveFollowUp({ running: true, alternate: false, preferred, canSteer });
    const other = resolveFollowUp({ running: true, alternate: true, preferred, canSteer });
    return [...new Set([first, other, "restart"])];
}
