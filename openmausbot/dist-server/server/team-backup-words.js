import { goalHistoryWords } from "../shared/team-backup.js";
import { redactSecretsInText } from "../shared/redact.js";
import { chatNotice } from "./chat-notices.js";
function goalLine(textCode, before, content) {
    const textParams = { before: redactSecretsInText(before), content: redactSecretsInText(content) };
    return { text: chatNotice(textCode, textParams), textCode, textParams };
}
export function exportedGoalWords(message, text, before = "", after) {
    const run = message.goalRun;
    if (!run || message.role !== "bot")
        return { text };
    const words = [run.goal, run.detail].filter(Boolean).join("\n");
    const content = after ?? (words ? `\n${words}` : "");
    const code = `chat.notice.exportedGoal.${run.status}`;
    if (chatNotice(code, { before, content }) !== text)
        return { text };
    return goalLine(code, before, content);
}
export function restoredGoalWords(message) {
    const parsed = goalHistoryWords.safeParse(message);
    if (!parsed.success)
        return {};
    const { text, textCode, textParams } = parsed.data;
    if (chatNotice(textCode, textParams) !== text)
        return {};
    return goalLine(textCode, textParams.before, textParams.content);
}
