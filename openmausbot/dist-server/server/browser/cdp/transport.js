class Listeners {
    messages = new Set();
    closes = new Set();
    #closeReason = null;
    get closed() {
        return this.#closeReason !== null;
    }
    message(text) {
        for (const listener of this.messages) {
            try {
                listener(text);
            }
            catch { }
        }
    }
    close(reason) {
        if (this.#closeReason !== null)
            return;
        this.#closeReason = reason;
        for (const listener of this.closes) {
            try {
                listener(reason);
            }
            catch { }
        }
    }
    onClose(listener) {
        if (this.#closeReason !== null)
            listener(this.#closeReason);
        else
            this.closes.add(listener);
    }
}
/** Chrome's --remote-debugging-pipe: JSON messages separated by NUL, written to fd 3 and read from fd 4. */
export function pipeTransport(writable, readable) {
    const listeners = new Listeners();
    let pending = [];
    readable.on("data", (chunk) => {
        let start = 0;
        for (let end = chunk.indexOf(0); end !== -1; end = chunk.indexOf(0, start)) {
            pending.push(chunk.subarray(start, end));
            const text = Buffer.concat(pending).toString("utf8");
            pending = [];
            start = end + 1;
            if (text)
                listeners.message(text);
        }
        if (start < chunk.length)
            pending.push(chunk.subarray(start));
    });
    readable.on("end", () => listeners.close("the browser closed its pipe"));
    readable.on("close", () => listeners.close("the browser closed its pipe"));
    readable.on("error", (error) => listeners.close(error.message));
    writable.on("error", (error) => listeners.close(error.message));
    return {
        send(message) {
            if (listeners.closed)
                return;
            writable.write(`${message}\0`);
        },
        onMessage(listener) {
            listeners.messages.add(listener);
        },
        onClose(listener) {
            listeners.onClose(listener);
        },
        close() {
            listeners.close("closed by the driver");
            writable.end();
            readable.destroy();
        },
    };
}
/** A browser's DevTools WebSocket, for a Chrome OMB did not launch (the person's own, or a cloud browser). */
export function webSocketTransport(url, { timeoutMs = 15_000 } = {}) {
    if (!/^wss?:\/\//i.test(url))
        return Promise.reject(new Error(`Not a DevTools WebSocket address: ${url}`));
    const socket = new WebSocket(url);
    const listeners = new Listeners();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`The browser at ${new URL(url).host} did not accept a DevTools connection within ${timeoutMs} ms.`));
            socket.close();
        }, timeoutMs);
        socket.addEventListener("open", () => {
            clearTimeout(timer);
            resolve({
                send(message) {
                    if (!listeners.closed && socket.readyState === WebSocket.OPEN)
                        socket.send(message);
                },
                onMessage(listener) {
                    listeners.messages.add(listener);
                },
                onClose(listener) {
                    listeners.onClose(listener);
                },
                close() {
                    listeners.close("closed by the driver");
                    socket.close();
                },
            });
        });
        socket.addEventListener("message", (event) => {
            const data = event.data;
            listeners.message(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
        });
        socket.addEventListener("error", () => {
            clearTimeout(timer);
            reject(new Error(`Could not open a DevTools connection to ${new URL(url).host}.`));
            listeners.close("the DevTools connection failed");
        });
        socket.addEventListener("close", (event) => {
            clearTimeout(timer);
            listeners.close(`the DevTools connection closed (${event.code})`);
        });
    });
}
/** Records every command as it leaves for the browser, below the driver's own guard. */
export function tracingTransport(inner, record) {
    return {
        send(message) {
            try {
                const parsed = JSON.parse(message);
                if (typeof parsed.method === "string") {
                    record({
                        method: parsed.method,
                        sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
                        params: parsed.params && typeof parsed.params === "object" ? parsed.params : {},
                    });
                }
            }
            catch { }
            inner.send(message);
        },
        onMessage: (listener) => inner.onMessage(listener),
        onClose: (listener) => inner.onClose(listener),
        close: () => inner.close(),
    };
}
