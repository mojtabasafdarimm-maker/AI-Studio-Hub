// About me, the profile every bot reads: facts bots learn into it, and lines a person asks a bot to forget.
import { appendAboutMe, commitLearned, planLearned } from "./profile-learned.js";
const LEARNED_PREFIX = /^\s*-\s*\d{4}-\d{2}-\d{2} · learned by [^·\n]* · /;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;
/** A learned line is judged by its fact, never by the bot that learned it. */
export function withoutMentionedLines(aboutMe, mentions) {
    const removed = [];
    const kept = aboutMe.split("\n").filter((line) => {
        const fact = line.replace(LEARNED_PREFIX, "").replace(BULLET, "").trim();
        if (!fact || !mentions(fact))
            return true;
        removed.push(fact);
        return false;
    });
    return { text: kept.join("\n"), removed };
}
export function createAboutMe(deps) {
    const learnPlan = (from, texts) => {
        let facts = [];
        const plan = (current) => {
            facts = planLearned(from, texts, current, deps.today());
            const next = appendAboutMe(current, facts.map((fact) => fact.line));
            return facts.length && next !== null ? { next, count: facts.length } : null;
        };
        return { plan, facts: () => facts };
    };
    return {
        learn(from, texts) {
            const { plan, facts } = learnPlan(from, texts);
            if (deps.person)
                return deps.person(from.botId, plan);
            const planned = plan(deps.read());
            if (!planned)
                return 0;
            deps.write(planned.next);
            commitLearned(facts());
            deps.changed();
            return planned.count;
        },
        /** The facts removed from the About me of the person whose conversation `layer` is. */
        forget(layer, mentions) {
            let removed = [];
            const plan = (current) => {
                const kept = withoutMentionedLines(current, mentions);
                removed = kept.removed;
                return kept.removed.length ? { next: kept.text, count: kept.removed.length } : null;
            };
            if (deps.person) {
                deps.person(layer, plan);
                return removed;
            }
            const planned = plan(deps.read());
            if (!planned)
                return [];
            deps.write(planned.next);
            deps.changed();
            return removed;
        },
    };
}
