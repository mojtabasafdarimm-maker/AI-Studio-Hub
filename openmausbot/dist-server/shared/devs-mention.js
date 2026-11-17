// @devs: a person's message that tags it is a bug report for the MausBot team. The renderer draws the tag and the
// server sends one report per message that tags it, both by these rules, the same as for a bot's tag.
import { isMentionBoundary, isMentionNameContinuation } from "./mention-boundary.js";
import { proseOnly } from "./person-mention.js";
export const DEVS_TAG = "devs";
const startsWithName = (rest, name) => rest.slice(0, name.length).toLowerCase() === name.toLowerCase() && !isMentionNameContinuation(rest.slice(name.length));
/** The tag's length when `rest` (the text after an at-sign) starts with it. A bot or department named devs, or with a
 * longer name that starts with it, is tagged instead. */
export function devsTagAt(rest, botNames = []) {
    if (!startsWithName(rest, DEVS_TAG))
        return undefined;
    const bot = botNames.some((name) => name.trim().length >= DEVS_TAG.length && startsWithName(rest, name));
    return bot ? undefined : DEVS_TAG.length;
}
/** Each @devs tag in prose, never inside code. */
export function devsMentionRanges(text, botNames = []) {
    const prose = proseOnly(text);
    const ranges = [];
    let at = -1;
    while ((at = prose.indexOf("@", at + 1)) !== -1) {
        if (!isMentionBoundary(prose, at))
            continue;
        const length = devsTagAt(prose.slice(at + 1), botNames);
        if (length === undefined)
            continue;
        ranges.push({ start: at, end: at + length + 1 });
        at += length;
    }
    return ranges;
}
export const tagsDevs = (text, botNames = []) => devsMentionRanges(text, botNames).length > 0;
/** The person's own words: the text without its @devs tags, whitespace tidied. */
export function withoutDevsTags(text, botNames = []) {
    let out = "";
    let from = 0;
    for (const range of devsMentionRanges(text, botNames)) {
        out += text.slice(from, range.start);
        from = range.end;
    }
    return (out + text.slice(from)).replace(/[ \t]+/g, " ").replace(/^[\s,:;.-]+/, "").trim();
}
