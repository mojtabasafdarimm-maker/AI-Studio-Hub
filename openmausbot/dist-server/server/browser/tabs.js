import { SessionControl } from "./session-control.js";
export class TabRegistry {
    #next = 1;
    #byId = new Map();
    #byTarget = new Map();
    add(page, origin, openerTabId) {
        const existing = this.#byTarget.get(page.targetId);
        if (existing)
            return existing;
        const tab = {
            id: `t${this.#next++}`,
            page,
            control: new SessionControl(null, () => page.invalidateRefs()),
            openerTabId,
            origin,
            createdAt: Date.now(),
        };
        this.#byId.set(tab.id, tab);
        this.#byTarget.set(page.targetId, tab);
        return tab;
    }
    remove(targetId) {
        const tab = this.#byTarget.get(targetId);
        if (!tab)
            return null;
        this.#byTarget.delete(targetId);
        this.#byId.delete(tab.id);
        void tab.control.close().catch(() => { });
        return tab;
    }
    get(id) {
        const tab = this.#byId.get(id);
        return tab && !tab.page.closed ? tab : undefined;
    }
    byPage(page) {
        return page ? this.#byTarget.get(page.targetId) : undefined;
    }
    list() {
        return [...this.#byId.values()].filter((tab) => !tab.page.closed);
    }
    /** Every tab is gone with its browser; the numbering goes on. */
    clear() {
        for (const tab of this.#byId.values())
            void tab.control.close().catch(() => { });
        this.#byId.clear();
        this.#byTarget.clear();
    }
}
