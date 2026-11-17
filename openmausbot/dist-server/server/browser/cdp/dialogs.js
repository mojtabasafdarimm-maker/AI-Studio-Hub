import { DriverError } from "./errors.js";
const DIALOG_TEXT_LIMIT = 4_000;
const TYPES = ["alert", "confirm", "prompt", "beforeunload"];
/** A tab's JavaScript dialog. It stays open until someone answers it; only an agent's own navigation answers a beforeunload. */
export class Dialogs {
    #openListeners = new Set();
    #closeListeners = new Set();
    #pending = null;
    #acceptBeforeUnload = 0;
    get pending() {
        return this.#pending?.dialog ?? null;
    }
    /** Frames in other renderers raise their dialogs on their own session. */
    watch(session) {
        const clear = () => {
            if (this.#pending?.session === session)
                this.#closed();
        };
        const offs = [
            session.on("Page.javascriptDialogOpening", (params) => this.#opened(session, params)),
            session.on("Page.javascriptDialogClosed", clear),
            session.onDetach(clear),
        ];
        return () => {
            for (const off of offs)
                off();
            clear();
        };
    }
    onOpen(listener) {
        this.#openListeners.add(listener);
        return () => this.#openListeners.delete(listener);
    }
    onClose(listener) {
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
    }
    /** Resolves when a dialog opens; never rejects. */
    nextOpen() {
        let cancel = () => { };
        const opened = new Promise((resolve) => {
            cancel = this.onOpen(resolve);
        });
        return { opened, cancel };
    }
    async answer({ accept, promptText }) {
        const pending = this.#pending;
        if (!pending)
            throw new DriverError("refused", "No dialog is open.");
        await pending.session.send("Page.handleJavaScriptDialog", { accept, ...(promptText === undefined ? {} : { promptText }) });
        if (this.#pending === pending)
            this.#closed();
        return pending.dialog;
    }
    /** While `work` runs, a beforeunload the page raises is accepted: leaving was the agent's own choice. */
    async acceptingBeforeUnload(work) {
        this.#acceptBeforeUnload++;
        try {
            if (this.#pending?.dialog.type === "beforeunload")
                await this.answer({ accept: true });
            return await work();
        }
        finally {
            this.#acceptBeforeUnload--;
        }
    }
    #opened(session, params) {
        const type = TYPES.find((candidate) => candidate === params.type) ?? "alert";
        const dialog = {
            type,
            message: String(params.message ?? "").slice(0, DIALOG_TEXT_LIMIT),
            defaultPrompt: String(params.defaultPrompt ?? "").slice(0, DIALOG_TEXT_LIMIT),
            url: String(params.url ?? "").slice(0, 2_048),
            openedAt: Date.now(),
        };
        this.#pending = { dialog, session };
        for (const listener of this.#openListeners) {
            try {
                listener(dialog);
            }
            catch { }
        }
        if (type === "beforeunload" && this.#acceptBeforeUnload > 0)
            void this.answer({ accept: true }).catch(() => { });
    }
    #closed() {
        const pending = this.#pending;
        if (!pending)
            return;
        this.#pending = null;
        for (const listener of this.#closeListeners) {
            try {
                listener(pending.dialog);
            }
            catch { }
        }
    }
}
