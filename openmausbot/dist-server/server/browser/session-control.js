// Adapted from pingdotgg/t3code@00cdceb1 apps/server/src/preview/SessionControl.ts, MIT License, Copyright (c) 2026
// T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified: the reason type is declared here instead of
// imported from T3 Code's contracts.
export class BrowserControlInterrupted extends Error {
    reason;
    constructor(message = "Browser control changed. Refresh the snapshot before trying again.", reason = "interrupted") {
        super(message);
        this.reason = reason;
    }
}
/** Reserves control immediately, but drains running work before the new owner can act. */
export class SessionControl {
    agentId;
    onGenerationChange;
    tail = Promise.resolve();
    pending = Promise.resolve();
    owner = null;
    epoch = 0;
    closed = false;
    constructor(agentId, onGenerationChange = () => { }) {
        this.agentId = agentId;
        this.onGenerationChange = onGenerationChange;
    }
    get controller() {
        return this.owner;
    }
    get generation() {
        return this.epoch;
    }
    enqueue(run) {
        const result = this.tail.then(run);
        this.tail = result.then(() => this.pending, () => this.pending);
        return result;
    }
    /** An action can respond before its navigation commits, while later actions still wait. */
    track(work) {
        const settled = work.then(() => undefined, () => undefined);
        this.pending = Promise.all([this.pending, settled]).then(() => undefined);
    }
    assertOpen() {
        if (this.closed)
            throw new BrowserControlInterrupted("This browser tab is closed.", "closed");
    }
    changeOwner(owner) {
        this.owner = owner;
        this.epoch++;
        this.onGenerationChange();
    }
    async action(allowed, run) {
        this.assertOpen();
        if (!allowed())
            throw new BrowserControlInterrupted("You do not control this browser tab.");
        const epoch = this.epoch;
        return this.enqueue(async () => {
            this.assertOpen();
            if (epoch !== this.epoch || !allowed())
                throw new BrowserControlInterrupted();
            return run();
        });
    }
    /** Whether an agent may act here: its own tab, or a tab no agent opened. */
    agentMayAct(agentId) {
        return this.agentId === null || this.agentId === agentId;
    }
    /**
     * An agent action. It may act on its own tab or on one a human opened, but
     * never while a human controls the tab; taking control interrupts it.
     */
    agent(agentId, run) {
        if (!this.agentMayAct(agentId))
            return Promise.reject(new BrowserControlInterrupted("This tab belongs to another agent.", "agentMismatch"));
        if (this.owner !== null)
            return Promise.reject(new BrowserControlInterrupted("A human controls this tab.", "humanControl"));
        return this.action(() => this.agentMayAct(agentId) && this.owner === null, run);
    }
    /** Whether this agent's action would run now rather than be refused. */
    agentCanActNow(agentId) {
        return this.agentMayAct(agentId) && this.owner === null;
    }
    /**
     * A read that needs no control and does not queue, so an agent can look at
     * a page while a human drives it without holding up the human's input.
     */
    observe(run) {
        this.assertOpen();
        return run();
    }
    /**
     * Work any client may ask for, such as a viewport or appearance change. It
     * waits its turn behind running actions but needs no control.
     */
    system(run) {
        this.assertOpen();
        return this.enqueue(async () => {
            this.assertOpen();
            return run();
        });
    }
    human(viewerId, run) {
        return this.action(() => this.owner === viewerId, run);
    }
    async take(viewerId) {
        this.assertOpen();
        if (this.owner !== null && this.owner !== viewerId) {
            throw new BrowserControlInterrupted("Another viewer controls this browser tab.");
        }
        if (this.owner !== viewerId)
            this.changeOwner(viewerId);
        return this.human(viewerId, async () => { });
    }
    async release(viewerId, afterDrain = async () => { }) {
        this.assertOpen();
        if (this.owner !== viewerId) {
            throw new BrowserControlInterrupted("Only the controlling viewer can release this browser tab.");
        }
        this.changeOwner(null);
        await this.enqueue(afterDrain);
    }
    async disconnect(viewerId, afterDrain) {
        if (!this.closed && this.owner === viewerId)
            await this.release(viewerId, afterDrain);
    }
    async close() {
        if (!this.closed) {
            this.closed = true;
            this.changeOwner(null);
        }
        await this.tail;
    }
}
