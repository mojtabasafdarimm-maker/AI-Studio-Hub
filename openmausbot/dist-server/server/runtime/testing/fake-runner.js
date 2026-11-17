export const complete = (text, evidence) => ({ kind: "complete", text, evidence });
export const fail = (outcome, text, evidence) => ({ kind: "fail", outcome, text, evidence });
export const needsInput = (question, cards) => ({ kind: "needsInput", question, ...(cards ? { cards } : {}) });
export const continueTurn = (text, note, handoffPath, evidence) => ({ kind: "continue", text, note, ...(handoffPath !== undefined ? { handoffPath } : {}), ...(evidence ? { evidence } : {}) });
export const handOut = (children, after) => ({ kind: "handOut", children, after });
export const hang = () => ({ kind: "hang" });
export const custom = (fn) => ({ kind: "custom", fn });
const clone = (value) => structuredClone(value);
export class FakeRunner {
    calls = [];
    enqueues = [];
    running = new Set();
    parked = new Set();
    canStartAnswers = new Map();
    validateReasons = new Map();
    outwardAnswers = new Map();
    bots;
    personName = "Milind";
    lookup;
    outward;
    #port;
    #scripts = new Map();
    #hung = new Map();
    #throwOnce = new Set();
    #rejectRunOnce = false;
    constructor(bots = {}, options = {}) {
        this.bots = bots;
        if (options.outward !== false)
            this.outward = (a) => this.#outward(a);
    }
    attach(port) {
        this.#port = port;
    }
    script(key, ...scripts) {
        const queue = this.#scripts.get(key) ?? [];
        queue.push(...scripts);
        this.#scripts.set(key, queue);
    }
    setCanStart(key, answer) {
        this.canStartAnswers.set(key, answer);
    }
    setOutward(key, labels) {
        this.outwardAnswers.set(key, labels);
    }
    throwOnce(method) {
        this.#throwOnce.add(method);
    }
    rejectRunOnce() {
        this.#rejectRunOnce = true;
    }
    release(id, script = complete("released")) {
        const hung = this.#hung.get(id);
        if (!hung)
            throw new Error(`fake runner: ${id} is not hung`);
        this.#hung.delete(id);
        hung.resolve(this.#settle(script));
    }
    hungIds() {
        return [...this.#hung.keys()];
    }
    reboot() {
        this.running.clear();
        this.parked.clear();
        this.#hung.clear();
        this.#throwOnce.clear();
        this.#rejectRunOnce = false;
    }
    live() {
        return { running: this.running, parked: this.parked };
    }
    callsOf(method, id) {
        return this.calls.filter((c) => c.method === method && (id === undefined || c.id === id));
    }
    runs(id) {
        return this.callsOf("run", id);
    }
    reports(id) {
        return this.callsOf("report", id);
    }
    parks(id) {
        return this.callsOf("park", id);
    }
    validate(a, parent) {
        this.#maybeThrow("validate");
        const answer = this.validateReasons.get(a.id) ?? this.validateReasons.get(a.assignee.botId);
        this.calls.push({ method: "validate", id: a.id, a: clone(a), parent: parent && clone(parent), answer });
        return answer;
    }
    canStart(a) {
        this.#maybeThrow("canStart");
        const answer = this.canStartAnswers.get(a.id) ?? this.canStartAnswers.get(a.assignee.botId) ?? true;
        this.calls.push({ method: "canStart", id: a.id, a: clone(a), answer });
        return answer;
    }
    run(a, input, signal) {
        this.#maybeThrow("run");
        const call = {
            method: "run",
            id: a.id,
            a: clone(a),
            input: { ...input, settled: input.settled?.map(clone) },
            signal,
            storedStatus: this.lookup?.(a.id)?.status,
        };
        this.calls.push(call);
        if (this.#rejectRunOnce) {
            this.#rejectRunOnce = false;
            return Promise.reject(new Error("fake runner: run rejected"));
        }
        this.parked.delete(a.id);
        this.running.add(a.id);
        const script = this.#nextScript(a);
        return this.#execute(a, input, signal, script, call).then((result) => {
            this.running.delete(a.id);
            call.result = result;
            call.settledAborted = signal.aborted;
            return result;
        }, (err) => {
            this.running.delete(a.id);
            call.settledAborted = signal.aborted;
            throw err;
        });
    }
    park(a, question) {
        this.#maybeThrow("park");
        this.calls.push({ method: "park", id: a.id, a: clone(a), question });
        this.parked.add(a.id);
    }
    report(a, parent) {
        this.#maybeThrow("report");
        this.calls.push({ method: "report", id: a.id, a: clone(a), parent: parent && clone(parent) });
        this.parked.delete(a.id);
    }
    changed(assignments) {
        this.#maybeThrow("changed");
        const rows = assignments.map(clone);
        this.calls.push({ method: "changed", rows });
        for (const row of rows)
            if (row.status !== "needs_input")
                this.parked.delete(row.id);
    }
    names(a, parent) {
        this.#maybeThrow("names");
        this.calls.push({ method: "names", id: a.id, a: clone(a), parent: parent && clone(parent) });
        const requester = a.requester.botId
            ? this.bots[a.requester.botId]?.name ?? a.requester.botId
            : a.requester.kind === "person" ? this.personName : a.requester.kind;
        return {
            requester,
            assignee: this.bots[a.assignee.botId]?.name ?? a.assignee.botId,
            person: a.origin.kind === "person" ? this.personName : undefined,
            thread: a.requester.threadId,
        };
    }
    #outward(a) {
        this.#maybeThrow("outward");
        const answer = this.outwardAnswers.get(a.id) ?? this.outwardAnswers.get(a.assignee.botId) ?? [];
        this.calls.push({ method: "outward", id: a.id, a: clone(a), answer });
        return answer;
    }
    #maybeThrow(method) {
        if (!this.#throwOnce.has(method))
            return;
        this.#throwOnce.delete(method);
        throw new Error(`fake runner: ${method} threw once`);
    }
    #nextScript(a) {
        for (const key of [a.id, a.assignee.botId]) {
            const queue = this.#scripts.get(key);
            if (queue && queue.length > 0)
                return queue.shift();
        }
        return complete("done");
    }
    #settle(script) {
        switch (script.kind) {
            case "complete":
                return { kind: "completed", text: script.text, evidence: script.evidence };
            case "fail":
                return { kind: "failed", outcome: script.outcome, text: script.text, evidence: script.evidence };
            case "needsInput":
                return { kind: "needs_input", question: script.question, ...(script.cards ? { cards: script.cards } : {}) };
            case "continue":
                return { kind: "continue", text: script.text, note: script.note, ...(script.handoffPath !== undefined ? { handoffPath: script.handoffPath } : {}),
                    ...(script.evidence ? { evidence: script.evidence } : {}) };
            default:
                throw new Error(`fake runner: ${script.kind} cannot settle a released turn`);
        }
    }
    childRequest(a, spec) {
        const { origin, requester, levels, ...rest } = spec;
        return {
            parentId: a.id,
            origin: origin ?? clone(a.origin),
            requester: requester ?? {
                kind: "bot_turn",
                botId: a.assignee.botId,
                threadId: a.assignee.destination.threadId,
                chief: this.bots[a.assignee.botId]?.chief === true,
            },
            levels: levels ?? { own: "ask" },
            ...rest,
        };
    }
    async #execute(a, input, signal, script, call) {
        // An engine answers asynchronously: nothing settles inside the caller's stack frame.
        await Promise.resolve();
        const ctx = {
            a,
            input,
            signal,
            handOut: (child) => {
                if (!this.#port)
                    throw new Error("fake runner: attach(runtime) before a handOut script runs");
                const req = this.childRequest(a, child);
                const result = this.#port.enqueue(req);
                this.enqueues.push({ from: a.id, req, result });
                return result;
            },
        };
        switch (script.kind) {
            case "complete":
            case "fail":
            case "needsInput":
            case "continue":
                return this.#settle(script);
            case "handOut":
                for (const child of script.children)
                    ctx.handOut(child);
                return this.#execute(a, input, signal, script.after, call);
            case "custom":
                return script.fn(ctx);
            case "hang":
                return new Promise((resolve) => {
                    this.#hung.set(a.id, { resolve, call });
                    signal.addEventListener("abort", () => {
                        if (!this.#hung.has(a.id))
                            return;
                        this.#hung.delete(a.id);
                        call.aborted = true;
                        resolve({ kind: "failed", outcome: "stopped", text: "aborted" });
                    }, { once: true });
                });
        }
    }
}
