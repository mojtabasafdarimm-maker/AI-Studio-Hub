// The lines the server writes for a person to read (a bot's line, a status row, a card, a notification) come from the
// app's language packs, under "server.", in the language of the person they are for (host/person-languages.ts). This
// module reads English; server-line-packs.ts adds every other language when the server starts. The packaged server
// bundles only the "server." keys (scripts/server-locale-plugin.mjs). Text only a model reads stays English and never
// comes from here. A guard beside the packs (server-lines.test.ts) fails on an English line written straight into one.
import en from "../src/locales/en.json" with { type: "json" };
import { byLanguage } from "./language.js";
const ENGLISH = en;
const packs = { en: ENGLISH };
/** The other languages' packs, by code ("de", "pt-br", "zh-tw"); server-line-packs.ts adds them once, at start. */
export function addServerLinePacks(more) {
    Object.assign(packs, more, { en: ENGLISH });
}
/** The line in `language` (a language tag; undefined reads as English), with each `{name}` filled from `params`. A key
 * the language has no words for yet reads in English, as the app's own screens do. */
export function serverLine(language, key, params) {
    const template = byLanguage(packs, language)[key] ?? ENGLISH[key] ?? key;
    return params ? template.replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(params, name) ? String(params[name]) : match)) : template;
}
const escaped = (text) => text.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&");
const matchers = new Map();
/** A line's template as a pattern: its words as written, any text where a `{name}` goes. */
function matcherOf(template) {
    let matcher = matchers.get(template);
    if (!matcher) {
        matcher = new RegExp(["^", template.split(/\{\w+\}/).map(escaped).join("[\\s\\S]+"), "$"].join(""));
        matchers.set(template, matcher);
    }
    return matcher;
}
/** Whether `text` is this line in any language the server has, whatever its `{names}` were filled with: code that reads
 * a line back (a monitor skipping its own notes) matches every language, never the English alone. */
export function isServerLine(key, text) {
    return Object.values(packs).some((pack) => {
        const template = pack[key];
        return template !== undefined && matcherOf(template).test(text);
    });
}
let languageOf = () => undefined;
/** Where the server learns which language a conversation's lines are written in: its person's, else the place's
 * (server/index.ts sets this at start). Before that, and in tests that set none, English. */
export function setConversationLanguage(resolver) {
    languageOf = resolver;
}
/** The language a line in this conversation is written in, for code with no person or language of its own at hand. */
export const conversationLanguage = (threadId) => languageOf(threadId);
