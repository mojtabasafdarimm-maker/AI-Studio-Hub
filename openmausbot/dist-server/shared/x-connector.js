const count = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isoTime = (value) => typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
/** The relay's answer as XIncludedUsage, or null for anything else. Every call used reads as used up. */
export function parseXIncludedUsage(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const { calls, max, usedUp, resetsAt, trialEndsAt } = value;
    if (!count(calls) || !count(max) || !isoTime(resetsAt) || (trialEndsAt !== undefined && !isoTime(trialEndsAt)))
        return null;
    return { calls: Math.min(calls, max), max, ...(usedUp === true || calls >= max ? { usedUp: true } : {}), resetsAt, ...(trialEndsAt !== undefined ? { trialEndsAt } : {}) };
}
export function isXConnectorStatus(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const status = value;
    return (status.using === "own" || status.using === "included" || status.using === null)
        && typeof status.ownKey === "boolean" && typeof status.included === "boolean"
        && (status.usage === undefined || parseXIncludedUsage(status.usage) !== null);
}
