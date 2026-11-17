const MARKER = "error:";
/** The longest cause a row keeps. Clients wrap the row and show it whole, so
 * this only bounds a pathological message (a provider's HTML body, a stack
 * trace); a sentence a person acts on fits, its next action included. */
export const FAILED_TURN_MAX_CHARS = 600;
/** The activity row a failed turn is stored as. */
export function failedTurnTool(cause, flags = {}) {
    const words = cause.length > FAILED_TURN_MAX_CHARS ? `${cause.slice(0, FAILED_TURN_MAX_CHARS - 1)}…` : cause;
    return {
        name: `${MARKER} ${words}`,
        ok: false,
        ...(flags.setup ? { setup: true } : {}),
        ...(flags.terminal ? { terminal: true } : {}),
        ...(flags.claudeUpdate ? { claudeUpdate: true } : {}),
        ...(flags.place ? { place: flags.place } : {}),
        ...(flags.limitResetsAt ? { limitResetsAt: flags.limitResetsAt } : {}),
        ...(flags.text ? { nameCode: flags.text.key, ...(flags.text.params ? { nameParams: flags.text.params } : {}) } : {}),
        ...(flags.partial ? { partial: true } : {}),
    };
}
/** The cause a failed-turn row carries, without its marker; null for any
 * other activity row. */
export function failedTurnCause(name) {
    return name.startsWith(MARKER) ? name.slice(MARKER.length).trim() : null;
}
