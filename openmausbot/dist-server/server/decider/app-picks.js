import { clean } from "../records-block.js";
import { deciderAccount, deciderEnabled } from "./index.js";
import { BOT_DECIDE_LIMITS } from "./relay.js";
export const APP_PICK_INSTRUCTIONS = "Which one app should this person connect next, so their `bots` can do more for them? Go by the `connected_apps` they already use and what the bots are for.";
export const APP_PICK_TIMEOUT_MS = 10_000;
const MAX_CONNECTED = 40;
const MAX_BOTS = 12;
export function appPickAvailable(cfg) {
    return deciderEnabled(cfg) && Boolean(deciderAccount(cfg, "botDecide"));
}
export function appPickRequest(input) {
    const candidates = input.candidates.filter((app) => BOT_DECIDE_LIMITS.id.test(app.slug)).slice(0, BOT_DECIDE_LIMITS.options);
    return {
        state: {
            connected_apps: input.connected.slice(0, MAX_CONNECTED).map((app) => clean(app, 80)),
            bots: input.bots.slice(0, MAX_BOTS).map((bot) => ({ name: clean(bot.name, 80), ...(bot.role?.trim() ? { role: clean(bot.role, 120) } : {}) })),
        },
        question: {
            instructions: APP_PICK_INSTRUCTIONS,
            options: Object.fromEntries(candidates.map((app) => [app.slug, clean(app.blurb ? `${app.label}: ${app.blurb}` : app.label, 200)])),
        },
    };
}
/** The candidates, most useful first; `{ ok: false }` for every failure, and the caller keeps the order it had. */
export async function pickApps(decider, input) {
    const { state, question } = appPickRequest(input);
    const offered = Object.keys(question.options);
    if (offered.length < 2)
        return { ok: false };
    const result = await decider.choose("botDecide", state, question, { timeoutMs: APP_PICK_TIMEOUT_MS });
    if (!result.ok || !offered.includes(result.answers.choice))
        return { ok: false };
    const { choice, probabilities } = result.answers;
    const chance = (slug) => probabilities[slug] ?? 0;
    return { ok: true, slugs: [choice, ...offered.filter((slug) => slug !== choice).sort((a, b) => chance(b) - chance(a))] };
}
