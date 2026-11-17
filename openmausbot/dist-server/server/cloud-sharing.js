// A Cloud home only its owner ever used has nobody to confine: every routine and conversation runs at its bot's own
// level. Any trace of a second person makes it shared, for good; only what came in from outside (a webhook) stays
// confined either way.
import { createHash } from "node:crypto";
/** The writer of a routine a bot made or changed from a conversation that a webhook drove. Never a person. */
export const CLOUD_OUTSIDE_KEY = `p_${createHash("sha256").update("cloud-outside").digest("base64url").slice(0, 22)}`;
/** The starter of a conversation nobody's session opened. Never a person. */
export const CLOUD_NOBODY_KEY = `p_${createHash("sha256").update("cloud-nobody").digest("base64url").slice(0, 22)}`;
/** Fails toward shared: a record nobody can read, or any key that is neither the owner's nor proven theirs. */
export function cloudShared(evidence) {
    const { adopted, proven, revoked, sharedSince, unreadable } = evidence.ownership;
    if (unreadable || sharedSince !== undefined || revoked.size > 0)
        return true;
    const someoneElse = (key) => !evidence.ownersOrNone(key) && !proven.has(key);
    return [...adopted].some(someoneElse) || [...evidence.recorded].some(someoneElse) || [...(evidence.seen ?? [])].some(someoneElse);
}
/** A webhook drove this conversation: its record, its run, a payload posted into it, or a conversation that handed it the work. */
export function outsideDriven(threadId, records) {
    const driven = (id) => records.marked(id) || records.webhookRun(id) || records.webhookPosted(id);
    return driven(threadId) || [...records.handedFrom(threadId)].some(driven);
}
