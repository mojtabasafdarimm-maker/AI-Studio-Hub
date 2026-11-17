import { statedInConversation } from "./memory-capture.js";
import { redactSecretsInText } from "./redact.js";
const LOCATION = /https?:\/\/[^\s<>[\]()]+|(?:~\/|(?<![\p{L}\p{N}])\/[\p{L}_.]|[A-Za-z]:\\)[^\s<>[\](),;]*/gu;
const NUMBER = /\p{N}+(?:[.,:/-]\p{N}+)*%?/gu;
const matches = (text, pattern) => [...text.matchAll(pattern)].map((m) => m[0].toLowerCase().replace(/[.,:;!?'"]+$/u, ""));
export function checkDreamFacts(text, from, evidence, chats) {
    if (!evidence || evidence.length !== from.length || redactSecretsInText(text) !== text)
        return false;
    for (let i = 0; i < from.length; i++) {
        const quote = evidence[i];
        if (!quote?.trim())
            return false;
        const stated = chats[from[i] - 1]?.lines.some((line) => line.by === "person" && line.text.includes(quote)
            && statedInConversation({ text, kind: "fact", aboutUser: false, evidence: quote }, [{ person: line.text, bot: "" }], true));
        if (!stated)
            return false;
    }
    const source = evidence.join("\n");
    return [NUMBER, LOCATION].every((pattern) => matches(text, pattern).every((value) => matches(source, pattern).includes(value)));
}
