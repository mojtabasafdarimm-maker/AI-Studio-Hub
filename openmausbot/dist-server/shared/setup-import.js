// "Bring what you already use": the skills and MCP servers of a person's other AI tools that the welcome flow finds
// on this computer and brings in.
export function detectionCount(detection) {
    return detection ? detection.skills.length + detection.tools.length : 0;
}
/** Each source once, in the order first found. */
export function detectionSources(items) {
    return [...new Set(items.map((item) => item.source))];
}
