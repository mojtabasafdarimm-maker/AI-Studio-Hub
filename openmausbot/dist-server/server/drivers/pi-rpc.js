import { readFileSync } from "node:fs";
/** omp's RPC v2 splits a frame over 1 MiB into base64 `rpc_chunk` pieces (`chunkId`/`count`/
 *  `byteLength` per frame, sequential `index`, `data` per piece). Any inconsistency drops the sequence. */
export class PiRpcChunks {
    /** omp's advertised cap on one reassembled frame. */
    static MAX_BYTES = 64 * 1024 * 1024;
    /** omp's cap on one decoded piece, which also bounds the piece count. */
    static MAX_PIECE_BYTES = 256 * 1024;
    static MAX_COUNT = PiRpcChunks.MAX_BYTES / PiRpcChunks.MAX_PIECE_BYTES;
    chunkId = null;
    count = 0;
    byteLength = 0;
    bytes = 0;
    parts = [];
    accept(message) {
        const { chunkId, index, count, byteLength, data } = message;
        if (typeof chunkId !== "string" || chunkId.length === 0 || typeof data !== "string" ||
            data.length === 0 || data.length > Math.ceil(PiRpcChunks.MAX_PIECE_BYTES / 3) * 4 ||
            !Number.isInteger(index) || !Number.isInteger(count) || !Number.isInteger(byteLength) ||
            index < 0 || count < 2 || count > PiRpcChunks.MAX_COUNT ||
            index >= count ||
            byteLength < 0 || byteLength > PiRpcChunks.MAX_BYTES) {
            this.reset();
            return null;
        }
        if (chunkId !== this.chunkId) {
            if (index !== 0) {
                this.reset();
                return null;
            }
            this.chunkId = chunkId;
            this.count = count;
            this.byteLength = byteLength;
            this.parts = [];
            this.bytes = 0;
        }
        else if (count !== this.count || byteLength !== this.byteLength) {
            this.reset();
            return null;
        }
        const part = Buffer.from(data, "base64");
        // An empty piece would let a sequence grow without approaching `byteLength`.
        if (index !== this.parts.length || part.length === 0 || part.length > PiRpcChunks.MAX_PIECE_BYTES ||
            this.bytes + part.length > this.byteLength) {
            this.reset();
            return null;
        }
        this.parts.push(part);
        this.bytes += part.length;
        if (this.parts.length < this.count)
            return null;
        const complete = this.bytes === this.byteLength;
        const text = Buffer.concat(this.parts).toString("utf8");
        this.reset();
        if (!complete)
            return null;
        try {
            const frame = JSON.parse(text);
            return frame && typeof frame === "object" && !Array.isArray(frame)
                ? frame
                : null;
        }
        catch {
            return null;
        }
    }
    reset() {
        this.chunkId = null;
        this.count = 0;
        this.byteLength = 0;
        this.bytes = 0;
        this.parts = [];
    }
}
export function decodePiFrame(line, chunks) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return null;
    const frame = parsed;
    return frame.type === "rpc_chunk" ? chunks.accept(frame) : frame;
}
const PI_MAX_LINE = PiRpcChunks.MAX_BYTES;
export function piLineReader(onLine) {
    let buf = "";
    let dropping = false;
    return (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (dropping) {
                dropping = false;
                continue;
            }
            if (line.length > PI_MAX_LINE || !line.trim())
                continue;
            if (onLine(line))
                return;
        }
        if (buf.length > PI_MAX_LINE) {
            buf = "";
            dropping = true;
        }
    };
}
/** pi's prompt frame carries each attached image as base64. */
export function readPiPromptImages(turn) {
    return (turn.images ?? []).map((image) => ({
        type: "image",
        data: readFileSync(image.path).toString("base64"),
        mimeType: image.mime,
    }));
}
