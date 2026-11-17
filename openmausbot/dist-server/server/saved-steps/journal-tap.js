import { slimResponse } from "./driver-wire.js";
export const COMPUTER_JOURNAL_PATH = "/api/internal/computer/journal";
export function journalUrl(controlUrl) {
    return new URL(COMPUTER_JOURNAL_PATH, controlUrl).href;
}
export function postJournal(url, token, fetchImpl = fetch) {
    return (entry, signal) => fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(entry),
        signal,
    }).then((response) => response.body?.cancel());
}
function parse(line) {
    try {
        const value = JSON.parse(line);
        return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
    }
    catch {
        return null;
    }
}
export function createJournalTap(options) {
    const timeoutMs = options.timeoutMs ?? 1000;
    const pending = new Map();
    return {
        leaveOut(id) {
            if (typeof id === "string" || typeof id === "number")
                pending.delete(id);
        },
        request(line) {
            const frame = parse(line);
            if (!frame || frame.method !== "tools/call" || (typeof frame.id !== "string" && typeof frame.id !== "number"))
                return;
            const params = frame.params;
            if (typeof params?.name !== "string")
                return;
            const args = params.arguments;
            pending.set(frame.id, {
                tool: params.name,
                arguments: typeof args === "object" && args !== null && !Array.isArray(args) ? args : {},
            });
        },
        async response(line) {
            const frame = parse(line);
            if (!frame || frame.method !== undefined || (typeof frame.id !== "string" && typeof frame.id !== "number"))
                return;
            const call = pending.get(frame.id);
            if (!call)
                return;
            pending.delete(frame.id);
            const controller = new AbortController();
            let timer;
            try {
                const posted = Promise.resolve(options.post({ ...call, result: slimResponse(frame) }, controller.signal));
                const expired = new Promise((resolve) => {
                    timer = setTimeout(() => { controller.abort(); resolve(); }, timeoutMs);
                });
                await Promise.race([posted, expired]);
            }
            catch {
                // A slow or failed journal must never hold back the engine's reply.
            }
            finally {
                clearTimeout(timer);
            }
        },
    };
}
