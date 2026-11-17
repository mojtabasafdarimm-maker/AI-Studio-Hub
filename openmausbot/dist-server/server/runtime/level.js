import { hasNativeAutoReview, supportsApprovalMode } from "../../shared/approval-mode.js";
/** `custom` never travels: it is one provider's own rule set, so it has no rank. */
const TRAVELS = ["ask", "edits", "auto", "full"];
const rank = (level) => TRAVELS.indexOf(level);
function engineRuns(level, driverKind) {
    if (level === "full")
        return supportsApprovalMode(driverKind, "full");
    if (level === "auto")
        return hasNativeAutoReview(driverKind);
    if (level === "edits")
        return supportsApprovalMode(driverKind, "edits");
    return level === "ask";
}
function engineCap(inherited, driverKind) {
    for (let i = rank(inherited); i > 0; i--) {
        if (engineRuns(TRAVELS[i], driverKind))
            return TRAVELS[i];
    }
    return "ask";
}
export function assignmentLevel(input) {
    const { own, chief, origin, chiefLineage, driverKind } = input;
    const inherited = chiefLineage && (origin === "person" || origin === "routine") ? chief : undefined;
    if (own === "custom" || inherited === undefined || rank(inherited) <= rank(own))
        return { level: own, source: "own" };
    const capped = engineCap(inherited, driverKind);
    if (rank(capped) <= rank(own))
        return { level: own, source: "engine_cap" };
    return { level: capped, source: capped === inherited ? "chief" : "engine_cap" };
}
