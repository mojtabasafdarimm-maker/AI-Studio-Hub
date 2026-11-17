// Fan-in event bus — port of upstream's ProviderService fan-in + EventNdjsonLogger tee, minus Effect.
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { EVENTS_DIR } from "../config.js";
import { flushNativeLog } from "../drivers/native.js";
import { redactSecrets } from "../redact.js";
import { batchSaves } from "../save-batch.js";
import { capThreadLog, currentThreadLogCap } from "../thread-log-rotation.js";
import { newId } from "../contracts.js";
import { LiveSteps } from "./live-steps.js";
import { ProgressGate } from "./progress-gate.js";
import { TextItems } from "./text-items.js";
const INCOMPLETE_LOG_MESSAGE = "Canonical event history is incomplete: OpenMausBot could not write one or more events to disk. Live updates will continue.";
const DELTA_MERGE_MS = 50;
const MAX_BATCH_LINES = 64;
const MAX_QUEUED_EVENTS = 4096;
const MAX_QUEUED_BYTES = 32 * 1024 * 1024;
const defaultAppend = (path, data, options) => appendFile(path, data, options);
function sameStream(a, b) {
    return a.provider === b.provider && a.providerInstanceId === b.providerInstanceId && a.turnId === b.turnId &&
        a.itemId === b.itemId && a.streamKind === b.streamKind && a.synthetic === b.synthetic;
}
/** What changes the chat's status line, and so makes a waiting status report stale; a heartbeat or a token count does not. */
const STATUS_LINE_EVENTS = new Set(["turn.started", "content.delta", "item.started", "item.completed", "request.opened"]);
function isTerminalEvent(event) {
    if (event.type === "turn.completed" || event.type === "cap.exhausted" || event.type === "session.exited") {
        return true;
    }
    return event.type === "runtime.error" && event.terminal === true;
}
export class EventBus {
    listeners = new Set();
    unsubscribes = new Map();
    pendingLogWarnings = new Map();
    pendingText = new Map();
    appendLog;
    queued = [];
    queuedBytes = 0;
    pumping = false;
    kickScheduled = false;
    drainWaiters = [];
    queuedLogWarnings = new Map();
    // A status-line report is live only: delivered to listeners, never queued for the log.
    progress = new ProgressGate((event) => {
        if (this.pendingText.has(event.threadId))
            this.flushThread(event.threadId);
        this.deliver(event);
    });
    adapters = new Map();
    steps = new LiveSteps({
        offer: (event) => this.progress.offer(event),
        enginePid: (event) => this.adapters.get(event.providerInstanceId ?? "")?.enginePid?.(event.threadId),
    });
    gate;
    textItems = new TextItems();
    /** `gate` sees each adapter event first; true means it took the event and publishes what it chooses. */
    constructor(appendLog = defaultAppend, gate) {
        this.appendLog = appendLog;
        this.gate = gate;
    }
    attach(instances) {
        for (const instance of instances) {
            this.detach(instance.instanceId);
            this.adapters.set(instance.instanceId, instance.adapter);
            const unsub = instance.adapter.onEvent((event) => {
                // An adapter may only emit events for its own driver kind.
                if (event.provider !== instance.driverKind) {
                    console.error(`bus: dropped cross-driver event from ${instance.instanceId}`);
                    return;
                }
                const stamped = { ...event, providerInstanceId: instance.instanceId };
                if (!this.gate?.(stamped))
                    this.publish(stamped);
            });
            this.unsubscribes.set(instance.instanceId, unsub);
        }
    }
    publish(unstamped) {
        // Reply text is keyed by its message from here on: the delta merge below and every listener see the same id.
        const raw = this.textItems.stamp(unstamped);
        if (!raw)
            return;
        if (raw.type === "turn.progress") {
            this.progress.offer(this.steps.progress(raw));
            return;
        }
        if (raw.type === "item.output") {
            this.steps.output(raw);
            return;
        }
        const event = this.steps.observe(raw, isTerminalEvent(raw));
        if (STATUS_LINE_EVENTS.has(event.type) || isTerminalEvent(event))
            this.progress.supersede(event.threadId, isTerminalEvent(event));
        const pending = this.pendingText.get(event.threadId);
        if (event.type === "content.delta") {
            if (pending && sameStream(pending.event, event)) {
                pending.event = { ...pending.event, delta: pending.event.delta + event.delta };
                return;
            }
            if (pending)
                this.flushThread(event.threadId);
            const timer = setTimeout(() => this.flushThread(event.threadId), DELTA_MERGE_MS);
            timer.unref?.();
            this.pendingText.set(event.threadId, { event, timer });
            return;
        }
        if (pending)
            this.flushThread(event.threadId);
        this.write(event);
        this.steps.announce(event);
    }
    flush() {
        for (const threadId of Array.from(this.pendingText.keys()))
            this.flushThread(threadId);
        return this.flushDisk();
    }
    async flushWithin(ms) {
        let timer;
        const timeout = new Promise((resolve) => {
            // Not unref'd: the caller is waiting on this answer before it exits.
            timer = setTimeout(() => resolve(false), ms);
        });
        try {
            return await Promise.race([this.flush().then(() => this.pendingLogWarnings.size === 0), timeout]);
        }
        finally {
            clearTimeout(timer);
        }
    }
    flushThread(threadId) {
        const pending = this.pendingText.get(threadId);
        if (!pending)
            return;
        // Gone from the map before delivery: a listener may publish on this thread.
        this.pendingText.delete(threadId);
        clearTimeout(pending.timer);
        this.write(pending.event);
    }
    write(event) {
        // Queue first, then deliver: a listener publishing during delivery queues after this, so the log keeps publication order.
        this.enqueue(event);
        this.deliver(event);
        if (!isTerminalEvent(event))
            return;
        flushNativeLog(event.threadId);
        void this.flushDisk();
    }
    enqueue(event) {
        // People paste this log into bug reports: scrub credential-shaped content as the native tee does.
        const line = JSON.stringify(redactSecrets(event));
        const bytes = Buffer.byteLength(line);
        const overCount = this.queued.length >= MAX_QUEUED_EVENTS;
        const overBytes = this.queued.length > 0 && this.queuedBytes + bytes > MAX_QUEUED_BYTES;
        if ((overCount || overBytes) && !isTerminalEvent(event)) {
            if (!this.queuedLogWarnings.has(event.threadId)) {
                const warning = this.logWarning(event);
                this.queuedLogWarnings.set(event.threadId, warning);
                // Queued before delivery: listeners may publish synchronously.
                this.push(warning);
                console.error("bus: canonical event log queue is full");
                this.deliver(warning);
            }
            return;
        }
        this.queuedLogWarnings.delete(event.threadId);
        this.push(event, line, bytes);
    }
    push(event, line = JSON.stringify(redactSecrets(event)), bytes = Buffer.byteLength(line)) {
        this.queued.push({ event, line, bytes });
        this.queuedBytes += bytes;
        this.kick();
    }
    kick() {
        if (this.pumping || this.kickScheduled)
            return;
        this.kickScheduled = true;
        queueMicrotask(() => {
            this.kickScheduled = false;
            if (this.queued.length === 0 || this.pumping) {
                this.settleDrain();
                return;
            }
            this.pumping = true;
            void this.drain().catch((error) => {
                console.error("bus: canonical event log drain failed", error);
            }).finally(() => {
                this.pumping = false;
                if (this.queued.length > 0)
                    this.kick();
                else
                    this.settleDrain();
            });
        });
    }
    flushDisk() {
        if (this.queued.length === 0 && !this.pumping && !this.kickScheduled)
            return Promise.resolve();
        return new Promise((resolve) => {
            this.drainWaiters.push(resolve);
            this.kick();
        });
    }
    settleDrain() {
        if (this.queued.length > 0 || this.pumping || this.kickScheduled)
            return;
        const waiters = this.drainWaiters.splice(0);
        for (const resolve of waiters)
            resolve();
    }
    async drain() {
        if (this.queued.length === 0)
            return;
        const batch = this.queued.splice(0, MAX_BATCH_LINES);
        let bytes = 0;
        for (const item of batch)
            bytes += item.bytes;
        this.queuedBytes -= bytes;
        const groups = [];
        for (const item of batch) {
            const last = groups.at(-1);
            if (last && last.threadId === item.event.threadId)
                last.items.push(item);
            else
                groups.push({ threadId: item.event.threadId, items: [item] });
        }
        for (const group of groups)
            await this.appendGroup(group.threadId, group.items);
        if (this.queued.length > 0)
            await this.drain();
    }
    async appendGroup(threadId, items) {
        const warning = this.pendingLogWarnings.get(threadId);
        const events = items.map((item) => item.event);
        const lines = items.map((item) => item.line);
        if (warning)
            lines.unshift(JSON.stringify(warning));
        const file = join(EVENTS_DIR, `${threadId}.ndjson`);
        try {
            await this.appendLog(file, lines.join("\n") + "\n", { mode: 0o600 });
            if (warning)
                this.pendingLogWarnings.delete(threadId);
            capThreadLog(file, currentThreadLogCap());
        }
        catch (error) {
            this.noteDiskFailure(events[0], error);
        }
        finally {
            const queuedWarning = this.queuedLogWarnings.get(threadId);
            if (queuedWarning && events.includes(queuedWarning))
                this.queuedLogWarnings.delete(threadId);
        }
    }
    logWarning(event) {
        return {
            eventId: newId(),
            provider: event.provider,
            providerInstanceId: event.providerInstanceId,
            threadId: event.threadId,
            createdAt: new Date().toISOString(),
            turnId: event.turnId,
            type: "runtime.error",
            message: INCOMPLETE_LOG_MESSAGE,
        };
    }
    /** Never through publish(): that would retry the same failed write and recurse. */
    noteDiskFailure(event, error) {
        if (this.pendingLogWarnings.has(event.threadId))
            return;
        const warning = this.logWarning(event);
        this.pendingLogWarnings.set(event.threadId, warning);
        console.error("bus: canonical event log write failed", error);
        this.deliver(warning);
    }
    deliver(event) {
        batchSaves(() => {
            for (const listener of Array.from(this.listeners)) {
                try {
                    listener(event);
                }
                catch (e) {
                    console.error("bus: listener threw", e);
                }
            }
        });
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    detachAll() {
        for (const id of this.unsubscribes.keys())
            this.detach(id);
    }
    detach(instanceId) {
        this.unsubscribes.get(instanceId)?.();
        this.unsubscribes.delete(instanceId);
        this.adapters.delete(instanceId);
        void this.flush();
    }
}
