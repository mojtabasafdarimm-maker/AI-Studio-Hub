import { APPROVAL_MODES, supportsApprovalMode as driverKindSupportsApprovalMode } from "../shared/approval-mode.js";
import { availableTools } from "./drivers/agents-catalog.js";
const ENVELOPE = {
    skillAuthoring: true,
    sharedComputers: true,
    voiceNotes: true,
    computerSelection: true,
    cloudHome: false,
    chief: true,
    botId: "",
};
export function harnessCapabilityLines(from, to) {
    if (!from || !to)
        return [];
    const lines = [];
    if (from.agentsMcp !== to.agentsMcp) {
        const names = availableTools(ENVELOPE).map((tool) => tool.name);
        const coordination = ["coordinate_bots", "assignment_status"].filter((name) => names.includes(name));
        lines.push(to.agentsMcp
            ? "Gains peer coordination and the other team tools: " + names.length + " tools including " + coordination.join(", ") + "."
            : "Loses peer coordination and every team tool: " + names.length + " tools including " + coordination.join(", ") + " go away.");
    }
    if (from.driverKind !== to.driverKind) {
        const lost = APPROVAL_MODES.filter((mode) => driverKindSupportsApprovalMode(from.driverKind, mode) && !driverKindSupportsApprovalMode(to.driverKind, mode));
        const gained = APPROVAL_MODES.filter((mode) => !driverKindSupportsApprovalMode(from.driverKind, mode) && driverKindSupportsApprovalMode(to.driverKind, mode));
        if (lost.length)
            lines.push("Loses approval levels: " + lost.join(", ") + ".");
        if (gained.length)
            lines.push("Gains approval levels: " + gained.join(", ") + ".");
    }
    return lines;
}
export function createApprovalModeSupport(registry) {
    return function supportsApprovalMode(target, mode) {
        const driverKind = target === undefined
            ? undefined
            : "driverKind" in target
                ? target.driverKind
                : registry.cliTarget(target.instanceId)?.driverKind;
        return driverKindSupportsApprovalMode(driverKind, mode);
    };
}
