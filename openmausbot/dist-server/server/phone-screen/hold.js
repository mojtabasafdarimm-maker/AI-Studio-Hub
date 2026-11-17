import { HoldClock } from "../browser/hold.js";
/** A person's hold on the bots' USB phone: one for every phone and every admin, as the bots share one claim on it. */
export function createPhoneHold(options = {}) {
    let held = false;
    let unwatched = false;
    const waiting = new Set();
    const settleWaits = (outcome) => {
        for (const settle of waiting)
            settle(outcome);
    };
    const release = () => {
        if (!held)
            return;
        held = false;
        clock.stop();
        settleWaits("handed-back");
        options.onChange?.(false);
    };
    const clock = new HoldClock(release, options.limits);
    return {
        get held() {
            return held;
        },
        take() {
            if (!held) {
                held = true;
                clock.watched(!unwatched);
                options.onChange?.(true);
            }
            clock.used();
        },
        release,
        used() {
            if (held)
                clock.used();
        },
        watched(open) {
            unwatched = !open;
            if (held)
                clock.watched(open);
        },
        wait(signal, maxMs) {
            if (!held)
                return Promise.resolve("free");
            if (signal.aborted)
                return Promise.resolve("held");
            return new Promise((resolve) => {
                const settle = (outcome) => {
                    clearTimeout(timer);
                    signal.removeEventListener("abort", stillHeld);
                    waiting.delete(settle);
                    resolve(outcome);
                };
                const stillHeld = () => settle("held");
                const timer = setTimeout(stillHeld, maxMs);
                timer.unref?.();
                signal.addEventListener("abort", stillHeld, { once: true });
                waiting.add(settle);
            });
        },
        stop() {
            clock.stop();
            settleWaits("held");
        },
    };
}
