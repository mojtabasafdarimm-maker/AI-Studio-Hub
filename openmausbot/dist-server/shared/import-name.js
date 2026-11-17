/** Cut to `max` UTF-16 units without leaving the high half of a surrogate pair at the end. */
function cut(value, max) {
    const head = value.slice(0, Math.max(0, max));
    return /[\ud800-\udbff]$/.test(head) ? head.slice(0, -1) : head;
}
/** Shared by import and preview, including names reserved by archived bots. */
export function takeImportName(value, taken, maxLength = 100) {
    const base = cut(value.trim(), maxLength);
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) {
        const suffix = ` ${n}`;
        name = `${cut(base, maxLength - suffix.length).trimEnd()}${suffix}`;
    }
    taken.add(name.toLowerCase());
    return name;
}
