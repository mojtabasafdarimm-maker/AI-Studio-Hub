export const SECRET_ON_PAGE = "A saved password was just filled on this page, so agent_browser_eval is refused here for now. Submit the form or open another page first; to read this page, use agent_browser_snapshot or agent_browser_get_text.";
/** Per browser session, the page a fill left a secret on. `runClear` runs a clear in the browser's lane and says whether
 * it ran. */
export class SecretHolds {
    holds = new Map();
    runClear;
    constructor(runClear) {
        this.runClear = runClear;
    }
    hold(session, held) {
        this.drop(session);
        const hold = { url: held.url, until: Date.now() + held.ms, clears: Boolean(held.clear), tab: held.tab ?? null };
        const clear = held.clear;
        if (clear) {
            hold.timer = setTimeout(() => {
                hold.timer = undefined;
                // A clear that could not run (a person holds the browser, or it stayed busy) leaves the hold until the page moves.
                void this.runClear(session, clear).then((ran) => { if (ran && this.holds.get(session) === hold)
                    this.holds.delete(session); }, () => undefined);
            }, held.ms);
            hold.timer.unref();
        }
        this.holds.set(session, hold);
    }
    /** Fails closed: a page whose address cannot be read counts as the page that holds the secret. */
    async refuses(session, pageUrl, tab) {
        const hold = this.holds.get(session);
        if (!hold)
            return false;
        if (!hold.clears && Date.now() >= hold.until) {
            this.holds.delete(session);
            return false;
        }
        if (hold.tab !== null && tab !== undefined && tab !== hold.tab)
            return false;
        const url = await pageUrl();
        if (!url || url.split("#", 1)[0] === hold.url.split("#", 1)[0])
            return true;
        if (!hold.clears)
            this.holds.delete(session);
        return false;
    }
    drop(session) {
        clearTimeout(this.holds.get(session)?.timer);
        this.holds.delete(session);
    }
    sessions() {
        return [...this.holds.keys()];
    }
}
