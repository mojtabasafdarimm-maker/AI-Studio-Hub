// What a bot hears when a call is refused for length: which field, the limit, that nothing happened, and how to send it
// again. Without the last part a bot retries the same words or gives up.
export const tooLongRefusal = (field, max, how) => `${field} is over its ${String(max)}-character limit, so nothing was done. ${how}`;
const COORDINATE_FIELDS = {
    message: "Send only what the teammate needs to start, and save the long detail to a file in this folder and name its path, then call coordinate_bots again.",
    done_when: "Say in a sentence or two what finished looks like, then call coordinate_bots again.",
    title: "Use a shorter title, then call coordinate_bots again.",
    reason: "Say why in one short line, then call coordinate_bots again.",
};
/** What to say when length is the only thing wrong with a coordinate_bots call; undefined when anything else is too, so the
 * general words cover it all and the bot isn't sent back to fix one field of two. */
export function coordinateTooLong(issues) {
    const refusals = issues.map((issue) => {
        const field = String(issue.path[0]);
        const how = COORDINATE_FIELDS[field];
        return issue.code === "too_big" && how && issue.maximum !== undefined ? tooLongRefusal(field, issue.maximum, how) : undefined;
    });
    return refusals.length && refusals.every(Boolean) ? refusals.join(" ") : undefined;
}
