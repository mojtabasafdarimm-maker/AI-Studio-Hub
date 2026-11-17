import { approvalModeFor } from "../shared/approval-mode.js";
import { sameModelSelection } from "../shared/thread-model.js";
import { newId } from "./contracts.js";
export const UNTITLED_THREAD = "New thread";
const TASK_TITLE_MAX = 80;
export function threadTitleFrom(title) {
    return title?.trim().slice(0, TASK_TITLE_MAX) || UNTITLED_THREAD;
}
export function buildTask(bot, title, projectId, openedBy, approvalMode, modelSelection, cwd) {
    const createdAt = Date.now();
    return {
        threadId: newId(),
        title: threadTitleFrom(title),
        createdAt,
        updatedAt: createdAt,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(projectId ? { projectId } : {}),
        ...(openedBy ? { openedBy: structuredClone(openedBy) } : {}),
        resumeCursors: {},
        ...(modelSelection && !sameModelSelection(modelSelection, bot.modelSelection) ? { modelSelection: structuredClone(modelSelection) } : {}),
        approvalMode: approvalMode ?? approvalModeFor(bot),
        autoApprove: approvalMode ? false : Boolean(bot.autoApprove),
        alwaysAllow: approvalMode ? [] : [...(bot.alwaysAllow ?? [])],
        unread: false,
        activity: "idle",
        busy: false,
    };
}
