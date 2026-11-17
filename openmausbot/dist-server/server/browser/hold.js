export const HOLD_LIMITS = { graceMs: 2 * 60_000, idleMs: 5 * 60_000 };
/** One browser's two hold timers. `end` runs when either passes, and checks that the hold is still the one timed. */
export class HoldClock {
    #idle;
    #grace;
    #end;
    #limits;
    constructor(end, limits = HOLD_LIMITS) {
        this.#end = end;
        this.#limits = limits;
    }
    /** The person took control or sent input. */
    used() {
        clearTimeout(this.#idle);
        this.#idle = this.#after(this.#limits.idleMs);
    }
    /** Whether one of the person's views of the browser is open; with none, the grace runs. */
    watched(open) {
        if (open) {
            clearTimeout(this.#grace);
            this.#grace = undefined;
        }
        else {
            this.#grace ??= this.#after(this.#limits.graceMs);
        }
    }
    stop() {
        clearTimeout(this.#idle);
        clearTimeout(this.#grace);
        this.#idle = undefined;
        this.#grace = undefined;
    }
    #after(ms) {
        const timer = setTimeout(() => {
            this.stop();
            this.#end();
        }, ms);
        timer.unref?.();
        return timer;
    }
}
