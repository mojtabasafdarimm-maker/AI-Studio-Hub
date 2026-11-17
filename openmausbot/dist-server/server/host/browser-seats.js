// A bot's browser has one page and one set of refs, so one conversation drives it at a time. Another conversation's call
// waits for it in plain sight instead of being refused, and a holder that has stopped browsing gives it up to a waiter.
import { settledWithin } from "../auto-vm-claims.js";
import { serverLine } from "../server-lines.js";
/** Longer than a model usually thinks between two browser calls. A holder quiet for this long, while another conversation
 * waits, gives the browser up; its next call is refused once, so nothing lands on a page it did not open. */
export const BROWSER_IDLE_HANDOVER_MS = 60_000;
const POLL_MS = 250;
export const browserResource = (session) => `browser:${session}`;
export const browserBusyText = (waitMs) => "Another conversation of this bot is using this browser. This call was NOT performed. This turn gets the browser as soon as it is free: "
    + `to keep waiting, make a browser call again (each waits up to ${Math.round(waitMs / 1000)} seconds). Do not end your turn over this, and carry on with anything that does not need the browser.`;
export const BROWSER_WAITED = "This browser is free now, but this call had to wait for it, so it was NOT performed. Call again: the next call goes through at once. "
    + "Another conversation had the browser, so look at the page before you act on it.";
export const BROWSER_HANDED_OVER = "Another conversation used this browser while this turn was not using it, so this call was NOT performed and the page may have changed. "
    + "Open the page you need again, take a fresh snapshot, then continue.";
export function createBrowserSeats(deps) {
    const now = deps.now ?? Date.now, idleMs = deps.idleHandoverMs ?? BROWSER_IDLE_HANDOVER_MS, pollMs = deps.pollMs ?? POLL_MS;
    const waits = new Map();
    const lastUse = new Map();
    const handedOver = new Map();
    const handOverIfQuiet = (resource, session, waiter) => {
        const holder = deps.resources.blocker(resource, waiter);
        if (!holder)
            return;
        const seen = lastUse.get(resource);
        if (seen?.generation !== holder.generation) {
            lastUse.set(resource, { generation: holder.generation, at: now() });
            return;
        }
        if (now() - seen.at < idleMs || deps.working(session))
            return;
        deps.resources.releaseOne(resource, holder);
        for (const [generation, owner] of handedOver)
            if (!deps.active(owner))
                handedOver.delete(generation);
        handedOver.set(holder.generation, holder);
    };
    const wait = (owner, resource, session) => {
        const running = waits.get(owner.generation);
        if (running)
            return running;
        const work = (async () => {
            const position = deps.resources.startWaiting(resource, owner);
            const blocker = deps.resources.blocker(resource, owner);
            const { holder, threadRef } = blocker ? deps.holderOf(blocker) : { holder: undefined, threadRef: undefined };
            const language = deps.language(owner.threadId);
            deps.row(owner.threadId, holder?.task
                ? serverLine(language, "server.browser.waitingTask", { name: holder.name, task: holder.task })
                : serverLine(language, "server.browser.waiting"), threadRef);
            deps.waitStarted(owner.threadId, resource, position, holder);
            const since = now();
            let acquired = false;
            try {
                while (deps.active(owner)) {
                    handOverIfQuiet(resource, session, owner);
                    if (deps.claim(owner, resource)) {
                        acquired = true;
                        break;
                    }
                    await new Promise((resolve) => { setTimeout(resolve, pollMs).unref?.(); });
                }
            }
            finally {
                deps.resources.stopWaiting(resource, owner);
                waits.delete(owner.generation);
                deps.row(owner.threadId, serverLine(language, acquired ? "server.browser.free" : "server.browser.stoppedWaiting"));
                deps.waitEnded(owner.threadId, resource, acquired ? "acquired" : "stopped", now() - since, holder);
            }
        })();
        waits.set(owner.generation, work);
        return work;
    };
    return {
        /** Null when this call may go ahead; otherwise what the engine reads instead of the call's result. */
        async take(owner, session, signal) {
            const resource = browserResource(session), askedAt = now();
            if (!deps.claim(owner, resource)) {
                await settledWithin(wait(owner, resource, session), deps.callWaitMs, signal);
                if (!deps.resources.owns(resource, owner))
                    return browserBusyText(deps.callWaitMs);
            }
            lastUse.set(resource, { generation: owner.generation, at: now() });
            if (handedOver.delete(owner.generation))
                return BROWSER_HANDED_OVER;
            return now() - askedAt > deps.actWithinMs ? BROWSER_WAITED : null;
        },
        /** The call just answered: the quiet time a holder is allowed starts now. */
        used(owner, session) {
            lastUse.set(browserResource(session), { generation: owner.generation, at: now() });
        },
    };
}
