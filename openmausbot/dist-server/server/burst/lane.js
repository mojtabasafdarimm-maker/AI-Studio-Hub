// The burst lane: burst threads run up to the plan's limit, apart from the plan's own turn caps, so a burst never takes a
// place from the person's chats. Queued children wait in the lane's own store, never in the runtime or the engine queue,
// so the work of one step does not grow with the size of the burst.
export class BurstLane {
    deps;
    running = 0;
    pumping = false;
    again = false;
    constructor(deps) {
        this.deps = deps;
    }
    /** How many burst threads the lane has running or starting. */
    runningCount() {
        return this.running;
    }
    /** A burst thread ended: its place is free. */
    release() {
        this.running = Math.max(0, this.running - 1);
        this.pump();
    }
    /** Starts children while there is a place. Never re-enters: a start that settles at once asks for one more pass. */
    pump() {
        if (this.pumping) {
            this.again = true;
            return;
        }
        this.pumping = true;
        try {
            do {
                this.again = false;
                while (this.running < this.deps.parallel() && this.deps.hasRoom()) {
                    const slot = this.deps.next();
                    if (slot === undefined)
                        break;
                    this.running += 1;
                    this.deps.begin(slot);
                }
            } while (this.again);
        }
        finally {
            this.pumping = false;
        }
    }
}
