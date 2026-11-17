/**
 * Durable payload carried by a profile confirmation card (propose_profile).
 *
 * The fields a bot may propose for itself (`cwd` is the working folder its
 * tools run in; "" means its private workspace; `notifications` and
 * `speakReplies` are the alert and voice toggles). `before` is the snapshot
 * the user was shown; `expectedRevision` is a hash of the target's whole
 * profile at proposal time so a confirmation fails closed if anything moved.
 */
export const PROFILE_REQUEST_FIELDS = ["name", "title", "description", "soul", "cwd", "notifications", "speakReplies"];
