// OMB's own timing of each agents tool call, sent to the harness before the call's answer goes back to the engine, so the
// receipt is in the turn before the engine can end it and the trace shows the server's measure on every engine. A lost
// receipt costs only the timing, never the call.
import { errorLine, toolDetail } from "../usage-trace/detail.js";
const RECEIPT_TIMEOUT_MS = 2_000;
/** Resolves once the harness has the receipt, or once it could not be delivered; never rejects. */
export async function sendToolReceipt(context, name, args, startedAt, outcome) {
    const detail = toolDetail(name, args);
    const error = outcome.ok ? undefined : errorLine(outcome.error);
    const body = JSON.stringify({ name, startedAt, endedAt: Date.now(), ok: outcome.ok, ...(detail ? { detail } : {}), ...(error ? { error } : {}) });
    try {
        await context.client.apiResponse("/api/internal/tool-timing", { method: "POST", body, signal: AbortSignal.timeout(RECEIPT_TIMEOUT_MS) });
    }
    catch {
    }
}
