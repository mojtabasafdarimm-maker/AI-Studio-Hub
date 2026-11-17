// Receipts for bot-to-bot sends: queued (not started), injected (the recipient's turn started with it) or failed. Never report a delivery that did not happen.
import { clip, peerName } from "./peer-roster.js";
// Detail can carry peer- or provider-authored text: flattened and clipped like a roster entry.
const DETAIL_MAX = 200;
export function peerDeliveryReceipt(receipt) {
    return {
        botId: receipt.botId,
        ...(receipt.botName ? { botName: receipt.botName } : {}),
        outcome: receipt.outcome,
        detail: clip(receipt.detail, DETAIL_MAX) || "no detail recorded",
        ...(receipt.taskId ? { taskId: receipt.taskId } : {}),
        ...(receipt.requestId ? { requestId: receipt.requestId } : {}),
        ...(receipt.threadId ? { threadId: receipt.threadId } : {}),
        ...(receipt.queue ? { queue: { position: receipt.queue.position, of: receipt.queue.of,
                ...(receipt.queue.waitingFor ? { waitingFor: clip(receipt.queue.waitingFor, DETAIL_MAX) } : {}) } } : {}),
    };
}
const named = (receipt) => peerName(receipt.botName ?? "") || peerName(receipt.botId) || "teammate";
export function renderPeerDeliveryReceipts(receipts) {
    if (!receipts.length)
        return "";
    const line = (receipt) => `${named(receipt)}: ${receipt.outcome} — ${receipt.detail}`;
    if (receipts.length === 1)
        return `Delivery to ${line(receipts[0])}`;
    return ["Delivery receipts:", ...receipts.map(receipt => `- ${line(receipt)}`)].join("\n");
}
