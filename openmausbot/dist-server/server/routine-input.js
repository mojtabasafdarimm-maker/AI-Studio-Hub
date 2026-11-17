// A routine as a person, a bot or an import asked for it, checked and cleaned before RoutineManager keeps it.
import { approvalModeFor } from "../shared/approval-mode.js";
import { runsOnce } from "../shared/limit-reset.js";
import { cleanAttachments, cleanTimeoutMinutes } from "./routine-attachments.js";
import { loadChecks, loadModelSelection } from "./routine-load.js";
import { cleanSchedule } from "./routine-schedules.js";
import { userErrorThrown } from "./user-errors.js";
export const ROUTINE_MODEL_PERMISSIONS = "That model runs on another engine, which can't keep this bot's permission level. Choose a model on the bot's own engine, or change the bot's permissions first.";
/** A run's thread keeps its bot's permission level, so its model may change engines only where a bot's own model change could
 * without dropping to Ask: a Custom grant never leaves its engine, and Auto-accept edits stops at an engine without it. */
function keepsPermissions(checks, botId, selection) {
    const bot = checks.bot(botId);
    return !bot || !checks.engineSwitchNeedsAsk(approvalModeFor(bot), bot.modelSelection, selection);
}
/** Checks a requested routine model the way a bot's is checked, and leaves the checked form in the body. A move to another bot
 * checks the model the routine already has against that bot. */
export function routineModelRefusal(body, checks, existing) {
    const fields = body && typeof body === "object" ? body : {};
    if (fields.modelSelection == null && fields.botId === undefined)
        return null;
    let selection = fields.modelSelection === null ? undefined : existing?.modelSelection;
    if (fields.modelSelection != null) {
        const checked = checks.check(fields.modelSelection);
        if (!checked.ok)
            return { status: checked.status, error: checked.error };
        selection = body.modelSelection = checked.selection;
    }
    const botId = typeof fields.botId === "string" ? fields.botId : existing?.botId;
    return selection && botId && !keepsPermissions(checks, botId, selection) ? { status: 400, error: ROUTINE_MODEL_PERMISSIONS } : null;
}
/** The model a run opens its thread on: the routine's own, unless its bot's permissions changed since so that it no longer may. */
export function routineThreadModel(routine, checks) {
    return routine?.modelSelection && keepsPermissions(checks, routine.botId, routine.modelSelection) ? routine.modelSelection : undefined;
}
export function sanitizeInput(input, after) {
    const name = String(input.name ?? "").trim().slice(0, 80);
    const prompt = String(input.prompt ?? "").trim().slice(0, 20_000);
    const botId = String(input.botId ?? "").trim();
    if (!name)
        throw new Error("Give the routine a name");
    if (!prompt)
        throw new Error("Tell the bot what to do");
    if (!botId)
        throw new Error("Choose a bot");
    const target = input.target ?? "bot";
    if (target !== "bot" && target !== "room-goal")
        throw new Error("Choose a valid routine target");
    const groupId = typeof input.groupId === "string" ? input.groupId.trim() : "";
    const runOn = input.runOn ?? "maus";
    if (runOn !== "maus" && runOn !== "cloud")
        throw new Error("Choose where this routine runs");
    const attachments = cleanAttachments(input.attachments);
    const timeoutMinutes = cleanTimeoutMinutes(input.timeoutMinutes);
    if (target === "room-goal" && runOn === "cloud") {
        throw new Error("Room goals can only run on this computer");
    }
    if (target === "room-goal" && attachments.length > 0) {
        throw new Error("Room goals do not support attachments yet");
    }
    if (runOn === "cloud" && attachments.length > 0) {
        throw new Error("Attachments can only run on this computer until cloud file staging is available");
    }
    const continuity = input.continuity === true;
    if (input.overlap !== undefined && input.overlap !== "skip" && input.overlap !== "queue") {
        throw new Error("Choose skip or queue for overlapping runs");
    }
    if (continuity && target === "room-goal") {
        throw new Error("Room goals do not carry continuity yet");
    }
    const sameConversation = input.sameConversation === true;
    if (sameConversation && target === "room-goal")
        throw new Error("Room goals do not keep one conversation");
    const modelSelection = input.modelSelection == null ? undefined : loadModelSelection(input.modelSelection);
    if (input.modelSelection != null && !modelSelection)
        throw new Error("Choose a model: an engine, a model id, and an effort level or a variant, not both");
    if (modelSelection && target === "room-goal")
        throw new Error("Room goals run on their bots' own models");
    const schedule = cleanSchedule(input.schedule, after);
    if (modelSelection && schedule.type === "limit_reset")
        throw new Error("A limit-reset routine continues its conversation on that conversation's model");
    if (sameConversation && schedule.type === "limit_reset")
        throw new Error("A limit-reset routine already continues its conversation");
    const asked = Array.isArray(input.checks) && input.checks.length === 0 ? null : input.checks;
    const checks = asked == null ? undefined : loadChecks(asked);
    if (asked != null && (!checks || checks.length !== new Set(asked).size))
        throw userErrorThrown("serverError.routine.checks");
    if (checks && (target !== "bot" || runsOnce(schedule)))
        throw userErrorThrown("serverError.routine.checksRepeat");
    if (input.access != null && input.access !== "read-and-draft")
        throw userErrorThrown("serverError.routine.access");
    if (input.deliver != null && (input.deliver !== "brief" || target !== "bot"))
        throw userErrorThrown("serverError.routine.deliver");
    return {
        name,
        prompt,
        target,
        botId,
        groupId: target === "room-goal" && groupId ? groupId : undefined,
        runOn,
        enabled: input.enabled !== false,
        schedule,
        durationMinutes: Math.min(240, Math.max(5, Math.round(Number(input.durationMinutes) || 30))),
        ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
        attachments,
        ...(continuity ? { continuity: true } : {}),
        ...(sameConversation ? { sameConversation: true } : {}),
        ...(modelSelection ? { modelSelection } : {}),
        ...(input.overlap === "queue" ? { overlap: "queue" } : {}),
        ...(input.runOnStartup === true && !runsOnce(schedule) ? { runOnStartup: true } : {}),
        ...(checks ? { checks } : {}),
        ...(input.access === "read-and-draft" ? { access: "read-and-draft" } : {}),
        ...(input.deliver === "brief" ? { deliver: "brief" } : {}),
    };
}
