import { killCliTree } from "../procs.js";
const EXIT_WAIT_MS = 7_000;
export class AntigravityProcesses {
    #running = new Map();
    track(instanceId, child) {
        const children = this.#running.get(instanceId) ?? new Set();
        this.#running.set(instanceId, children);
        children.add(child);
        const forget = () => {
            children.delete(child);
            if (!children.size && this.#running.get(instanceId) === children)
                this.#running.delete(instanceId);
        };
        child.once("close", forget);
        child.once("error", () => { if (child.pid === undefined)
            forget(); });
    }
    count(instanceId) {
        return this.#running.get(instanceId)?.size ?? 0;
    }
    /** Resolves once this account's processes are gone: each was asked to exit and gets `waitMs` before it is killed. */
    async stopped(instanceId, waitMs = EXIT_WAIT_MS) {
        const children = [...this.#running.get(instanceId) ?? []];
        await Promise.all(children.map((child) => new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null)
                return resolve();
            const timer = setTimeout(() => void killCliTree(child).catch(() => false).then(() => resolve()), waitMs);
            timer.unref?.();
            child.once("close", () => { clearTimeout(timer); resolve(); });
        })));
    }
}
