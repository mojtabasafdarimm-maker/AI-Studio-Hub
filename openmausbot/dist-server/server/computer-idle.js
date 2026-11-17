const MAX_RETRY_MS = 60 * 60_000;
const BUSY_CHECKS_PER_WINDOW = 10;
/** Stops a computer this server started once it has had a full quiet window and is not busy; activity renews the window.
 * While busy it looks again ten times a window, and the first look that finds it quiet starts a full window. */
export class ComputerIdleTimer {
    timer = null;
    lastActivityAt = 0;
    failures = 0;
    busySeen = false;
    /** Bumped by every cancel, so a stop still in flight from an earlier window neither re-arms nor reports. */
    generation = 0;
    idleMs;
    isBusy;
    suspend;
    onFailure;
    /** `suspend` answers "busy" when work arrived after `isBusy` said no; a throw is retried one window later, then two, four, at most an hour apart. */
    constructor(idleMs, isBusy, suspend, onFailure) {
        this.idleMs = checkedIdleMs(idleMs);
        this.isBusy = isBusy;
        this.suspend = suspend;
        this.onFailure = onFailure;
    }
    touch() {
        this.lastActivityAt = Date.now();
        this.failures = 0;
        this.busySeen = false;
        this.arm(this.idleMs);
    }
    cancel() {
        this.generation += 1;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
    }
    setIdleMs(idleMs) {
        this.idleMs = checkedIdleMs(idleMs);
        if (!this.timer)
            return;
        this.arm(Math.max(0, this.lastActivityAt + this.idleMs - Date.now()));
    }
    arm(delayMs) {
        this.cancel();
        this.timer = setTimeout(() => void this.expire(), delayMs);
        this.timer.unref?.();
    }
    async expire() {
        this.timer = null;
        if (this.isBusy()) {
            this.busySeen = true;
            this.arm(this.idleMs / BUSY_CHECKS_PER_WINDOW);
            return;
        }
        if (this.busySeen) {
            this.touch();
            return;
        }
        const generation = this.generation;
        try {
            const outcome = await this.suspend();
            if (generation === this.generation && outcome === "busy")
                this.touch();
        }
        catch (error) {
            if (generation !== this.generation)
                return;
            this.failures += 1;
            const retryInMs = Math.min(this.idleMs * 2 ** (this.failures - 1), Math.max(this.idleMs, MAX_RETRY_MS));
            this.onFailure?.(error, retryInMs);
            this.arm(retryInMs);
        }
    }
}
function checkedIdleMs(idleMs) {
    if (!Number.isFinite(idleMs) || idleMs <= 0)
        throw new Error("A computer idle window must be positive");
    return idleMs;
}
