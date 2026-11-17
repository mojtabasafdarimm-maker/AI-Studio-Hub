// Upload rules and messages follow T3 Code's apps/server/src/preview/ServerBrowser.ts
// (uploadFiles), Copyright 2026 T3 Tools Inc., used under the MIT License
// (third_party/t3-code/LICENSE).
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DriverError } from "./errors.js";
import { callOnNode } from "./evaluate.js";
export function checkUploadPaths(paths) {
    for (const path of paths) {
        if (!isAbsolute(path))
            throw new DriverError("refused", `Upload paths must be absolute: ${path}`);
        let file;
        try {
            file = statSync(path);
        }
        catch {
            throw new DriverError("not-found", `There is no file at ${path}.`);
        }
        if (!file.isFile())
            throw new DriverError("refused", `${path} is not a file.`);
    }
}
/** File pickers a page opened, intercepted so the agent or the person controlling the tab answers them. */
export class FileChoosers {
    #waiters = new Set();
    #listeners = new Set();
    #open = null;
    get open() {
        return this.#open;
    }
    /** Called whenever a picker opens, is answered or goes away. */
    onChange(listener) {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
    #set(open) {
        this.#open = open;
        for (const listener of this.#listeners) {
            try {
                listener();
            }
            catch { }
        }
    }
    watch(session) {
        return session.on("Page.fileChooserOpened", (params) => {
            if (typeof params.backendNodeId !== "number")
                return;
            // A newer picker replaces an unanswered one, as a real browser shows only one.
            this.#set({
                frameId: String(params.frameId),
                backendNodeId: params.backendNodeId,
                multiple: params.mode === "selectMultiple",
                session,
                openedAt: Date.now(),
            });
            for (const waiter of this.#waiters)
                waiter();
        });
    }
    /** The open picker, or one that opens within `waitMs`: a click's picker is announced just after the click returns. */
    async opened(waitMs) {
        if (this.#open || waitMs <= 0)
            return this.#open;
        await new Promise((resolve) => {
            const done = () => {
                this.#waiters.delete(done);
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(done, waitMs);
            this.#waiters.add(done);
        });
        return this.#open;
    }
    /** Hands files to the open picker; an empty list cancels it. */
    async answer(paths, { waitMs = 1_000 } = {}) {
        const open = await this.opened(waitMs);
        if (!open) {
            throw new DriverError("refused", "No file picker is open. Click the page's upload control first, or pass the file input's ref.");
        }
        if (paths.length > 1 && !open.multiple)
            throw new DriverError("refused", "This file picker accepts one file.");
        checkUploadPaths(paths);
        await open.session.send("DOM.setFileInputFiles", { files: [...paths], backendNodeId: open.backendNodeId });
        if (this.#open === open)
            this.#set(null);
    }
    forget(session) {
        if (this.#open && (!session || this.#open.session === session))
            this.#set(null);
    }
}
const FILE_INPUT = `function () {
  if (!(this instanceof HTMLInputElement) || this.type !== "file") return null;
  return { multiple: this.multiple, disabled: this.disabled };
}`;
/** Sets files on one <input type=file>. */
export async function setInputFiles(frames, handle, paths) {
    checkUploadPaths(paths);
    const input = await callOnNode(frames, handle, FILE_INPUT);
    if (!input)
        throw new DriverError("not-editable", "That element is not a file input. Pass the <input type=file>'s ref, or click the upload control and answer its picker.");
    if (input.disabled)
        throw new DriverError("not-editable", "That file input is disabled.");
    if (paths.length > 1 && !input.multiple)
        throw new DriverError("refused", "This file input accepts one file.");
    await handle.session.send("DOM.setFileInputFiles", { files: [...paths], backendNodeId: handle.backendNodeId });
}
