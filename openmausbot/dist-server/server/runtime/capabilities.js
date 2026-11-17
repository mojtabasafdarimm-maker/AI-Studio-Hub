// No import from server/drivers: they pull in the whole provider stack.
import { hasNativeAutoReview, supportsApprovalMode } from "../../shared/approval-mode.js";
const CHAT_STEP_CAP = 64;
const CHAT_ROW = { resume: false, stepCap: CHAT_STEP_CAP, transcript: true };
const ENGINES = {
    claudeAgent: { resume: true },
    codex: { resume: true },
    piAgent: { resume: true },
    ompAgent: { resume: true },
    mistralVibeAgent: { resume: true },
    antigravityAgent: { resume: true },
    grokAgent: { resume: true },
    geminiAgent: { resume: true },
    kimiAgent: { resume: true },
    droidAgent: { resume: true },
    cursorAgent: { resume: true },
    museCode: { resume: true },
    opencodeGo: { resume: true },
    qwenAgent: { resume: true },
    hermesAgent: { resume: true },
    deepseekAgent: { resume: true },
    clineAgent: { resume: true },
    copilotAgent: { resume: true },
    commandCodeAgent: { resume: true },
    kiroAgent: { resume: true },
    devinAgent: { resume: true },
    customAcp: { resume: true },
    "openai-compat": CHAT_ROW,
    grok: CHAT_ROW,
    minimax: CHAT_ROW,
    mistral: CHAT_ROW,
    cerebras: CHAT_ROW,
    groq: CHAT_ROW,
    greenference: CHAT_ROW,
    modelgo: CHAT_ROW,
    meta: CHAT_ROW,
};
export function replaysTranscriptNatively(driverKind) {
    return driverKind !== undefined && Object.hasOwn(ENGINES, driverKind) && ENGINES[driverKind].transcript === true;
}
export const ENGINE_KINDS = Object.keys(ENGINES);
export function engineCapabilities(driverKind) {
    const row = driverKind !== undefined && Object.hasOwn(ENGINES, driverKind) ? ENGINES[driverKind] : undefined;
    return {
        resume: row?.resume ?? false,
        nativeReviewer: hasNativeAutoReview(driverKind),
        full: supportsApprovalMode(driverKind, "full"),
        edits: supportsApprovalMode(driverKind, "edits"),
        ...(row?.stepCap === undefined ? {} : { stepCap: row.stepCap }),
        subagents: false,
    };
}
