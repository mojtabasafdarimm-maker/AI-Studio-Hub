// The live status line's vocabulary, shared by the drivers that report it, the bus that coalesces it and the chat that
// shows it. A turn.progress event is live only: it is never written to the event log or the message log.
const KB = 1024;
const MB = 1024 * KB;
/** The size the status line shows: whole KB under a megabyte, tenths of a MB above; nothing under 1 KB. */
export function progressSize(bytes) {
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < KB)
        return null;
    if (bytes < MB)
        return { unit: "kb", count: Math.floor(bytes / KB) };
    return { unit: "mb", count: Math.floor((bytes / MB) * 10) / 10 };
}
/** A path's last part, without control characters and at most 60 characters: never a whole path on the wire. */
export function progressFile(path) {
    if (typeof path !== "string")
        return undefined;
    const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop()?.replace(/\p{Cc}/gu, "").trim();
    if (!name)
        return undefined;
    return name.length > 60 ? `${name.slice(0, 57)}…` : name;
}
/** Two reports that read the same on screen share a key, so only a visible change is worth a frame. */
export function progressKey(event) {
    const size = progressSize(event.bytes);
    const quiet = event.quiet ? `${event.quiet.kind}${event.quiet.kind === "output" ? `@${event.quiet.at}` : ""}` : "";
    return [event.turnId ?? "", event.itemId ?? "", event.activity, event.tool ?? "", event.file ?? "", size ? `${size.count}${size.unit}` : "",
        event.target ?? "", event.detail ?? "", quiet, (event.tail ?? []).join("\n")].join("|");
}
