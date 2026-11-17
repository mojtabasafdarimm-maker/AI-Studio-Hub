/** Busy keeps the hand-off latency people see; parked work only needs its access and time limits rechecked; idle wakes
 * for the daily prune alone. */
export const HANDOFF_TICK_MS = { busy: 250, parked: 10_000, idle: 60 * 60_000 };
export function createHandoffTicks() {
    let options = null;
    let timer = null;
    /** The timer fires within one busy tick. Not worked out from the clock: waking a suspended machine moves the clock on, and its
     * pending timers keep the awake time they had left (measured on Fly, Node 22). */
    let near = false;
    let ticking = false;
    const arm = (delay) => {
        if (timer)
            clearTimeout(timer);
        near = delay <= HANDOFF_TICK_MS.busy;
        timer = setTimeout(fire, delay);
        timer.unref();
    };
    const fire = () => {
        timer = null;
        near = false;
        if (!options)
            return;
        ticking = true;
        let pace = "busy";
        try {
            options.tick();
            pace = options.pace();
        }
        catch (error) {
            console.error("coordinator:", error);
        }
        finally {
            ticking = false;
        }
        if (options)
            arm(HANDOFF_TICK_MS[pace]);
    };
    return {
        kick() {
            if (!options || ticking || near)
                return;
            arm(0);
        },
        start(next) {
            options = next;
            arm(HANDOFF_TICK_MS.busy);
        },
        stop() {
            options = null;
            if (timer)
                clearTimeout(timer);
            timer = null;
            near = false;
        },
    };
}
