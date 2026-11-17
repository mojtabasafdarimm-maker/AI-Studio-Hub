import { conversationLanguage, serverLine } from "../server-lines.js";
export const PERSON_FIRST_MS = 60_000;
/** How soon a turn that was waiting on the person or a computer when its time came is looked at again. */
const RECHECK_MS = 10_000;
/** "45 s", "9 min". */
export function ranFor(ms) {
    return ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`;
}
export function stoppedLine(ms, language) {
    return ms < 90_000
        ? serverLine(language, "server.personFirst.stoppedSeconds", { seconds: Math.max(1, Math.round(ms / 1000)) })
        : serverLine(language, "server.personFirst.stoppedMinutes", { minutes: Math.round(ms / 60_000) });
}
/** What the model is told after the person's words, in the turn that answers them. */
export function stoppedNote(label, ms) {
    return `[OpenMausBot: your step ${JSON.stringify(label)} had run for ${ranFor(ms)} with this message unread, so it was stopped for you to answer first. Answer this now. If that step still matters, do not wait inside a command again: check it once, then use wait_until or a one-time trigger to check back.]`;
}
function toolLabel(event) {
    const title = (event.title ?? "tool").trim() || "tool";
    const summary = event.summary?.replace(/\s+/g, " ").trim();
    return summary ? `${title}: ${summary}` : title;
}
export function createPersonFirst(deps) {
    const firstMs = Math.max(500, deps.firstMs ?? PERSON_FIRST_MS);
    const now = deps.now ?? Date.now;
    const schedule = deps.schedule ?? ((run, ms) => {
        const timer = setTimeout(run, ms);
        timer.unref?.();
        return () => clearTimeout(timer);
    });
    const watches = new Map();
    const watchOf = (threadId) => {
        let watch = watches.get(threadId);
        if (!watch)
            watches.set(threadId, (watch = { tools: new Map(), waits: [], read: false, cancel: null, acted: false }));
        return watch;
    };
    const disarm = (watch) => {
        watch.cancel?.();
        watch.cancel = null;
    };
    const forget = (threadId) => {
        const watch = watches.get(threadId);
        if (watch)
            disarm(watch);
        watches.delete(threadId);
    };
    const act = (threadId, watch, tool) => {
        watch.acted = true;
        const ran = now() - tool.at;
        const waits = watch.waits.splice(0);
        const noted = waits.findLast((wait) => wait.requeue);
        for (const wait of waits)
            wait.requeue?.(wait === noted ? stoppedNote(tool.label, ran) : undefined);
        void Promise.resolve().then(() => deps.stop(threadId, stoppedLine(ran, conversationLanguage(threadId)))).catch(() => { });
    };
    /** Acts once the oldest running tool call has held a waiting message for `firstMs`, else looks again then. */
    const check = (threadId) => {
        const watch = watches.get(threadId);
        if (!watch)
            return;
        disarm(watch);
        if (watch.acted || watch.waits.length === 0)
            return;
        let oldest = null;
        for (const tool of watch.tools.values())
            if (!oldest || tool.at < oldest.at)
                oldest = tool;
        if (!oldest)
            return;
        const due = oldest.at + firstMs - now();
        if (due > 0) {
            watch.cancel = schedule(() => check(threadId), due);
            return;
        }
        if (deps.waiting(threadId)) {
            watch.cancel = schedule(() => check(threadId), RECHECK_MS);
            return;
        }
        act(threadId, watch, oldest);
    };
    const answered = (threadId) => {
        const watch = watches.get(threadId);
        if (!watch || !watch.read || watch.waits.length === 0)
            return;
        watch.waits = [];
        disarm(watch);
    };
    return {
        /** The person's own message is waiting on this thread's running turn. */
        wait(threadId, wait) {
            const watch = watchOf(threadId);
            watch.waits.push(wait);
            watch.read = false;
            check(threadId);
        },
        onEvent(event) {
            const { threadId } = event;
            switch (event.type) {
                case "turn.started":
                case "turn.completed":
                    forget(threadId);
                    return;
                case "item.started":
                    if (event.itemType !== "tool" || !event.itemId)
                        return;
                    watchOf(threadId).tools.set(event.itemId, { at: now(), label: toolLabel(event) });
                    check(threadId);
                    return;
                case "item.completed": {
                    if (event.itemType === "assistant_text") {
                        if (!event.synthetic)
                            answered(threadId);
                        return;
                    }
                    const watch = watches.get(threadId);
                    if (event.itemType !== "tool" || !watch)
                        return;
                    if (event.itemId)
                        watch.tools.delete(event.itemId);
                    watch.read = true;
                    check(threadId);
                    return;
                }
                case "content.delta":
                    if (event.streamKind === "assistant_text" && !event.synthetic && event.delta.trim())
                        answered(threadId);
                    return;
            }
        },
        forget,
    };
}
