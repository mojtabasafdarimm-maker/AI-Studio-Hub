import { backgroundTextSlots } from "./job-slots.js";
import { titleFromLlm } from "./store.js";
import { threadTitlePrompt } from "./thread-title.js";
export function llmThreadTitlesEnabled(cfg) {
    return cfg.features?.llmThreadTitles === true;
}
export const THREAD_TITLE_TIMEOUT_MS = 10_000;
/** A person sees the title soon, so the call waits ahead of background upkeep for a free slot. Past its 10 s the answer
 * is null at once, but the slot is held until the engine call has really ended: its process still counts until then. */
export async function generateThreadTitle(provider, text, source = "first-message", slots = backgroundTextSlots) {
    const prompt = threadTitlePrompt(text, source);
    return new Promise((answer) => {
        void slots.run(async () => {
            const expiry = new AbortController();
            const timer = setTimeout(() => {
                expiry.abort();
                answer(null);
            }, THREAD_TITLE_TIMEOUT_MS);
            try {
                answer(titleFromLlm(await provider.generateText(prompt, { signal: expiry.signal })));
            }
            catch {
                answer(null);
            }
            finally {
                clearTimeout(timer);
            }
        }, { interactive: true }).catch(() => answer(null));
    });
}
