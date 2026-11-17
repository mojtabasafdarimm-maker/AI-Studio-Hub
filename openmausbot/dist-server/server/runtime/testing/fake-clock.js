export class FakeClock {
    #now;
    #monotonic;
    constructor(start = 1_760_000_000_000, monotonic = 10_000) {
        this.#now = start;
        this.#monotonic = monotonic;
    }
    now() {
        return this.#now;
    }
    monotonic() {
        return this.#monotonic;
    }
    advance(ms) {
        this.#now += ms;
        this.#monotonic += ms;
    }
    sleep(ms) {
        this.#now += ms;
    }
}
