import { askQuestionSummary, parseAsyncQuestions, questionAnswersById, questionChoices, } from "../../shared/ask-question.js";
import { newId } from "../contracts.js";
/**
 * Codex's request_user_input_async posts its questions on an agent message (`delivery: "async"`) and keeps working;
 * no server request follows. They open the ordinary question card. An answer is steered into the running turn; once
 * that turn is gone the request is unavailable, and the harness sends the answer as the person's reply.
 */
export function openAsyncQuestion(item, asks, steer, emit) {
    const questions = item.delivery === "async" ? parseAsyncQuestions(item.questions) : null;
    if (!questions)
        return;
    const requestId = newId();
    asks.set(requestId, async (behavior, message, source = "user") => {
        if (!asks.delete(requestId))
            return "unavailable";
        if (behavior !== "answer" || source !== "user" || !message?.trim()) {
            emit({ type: "request.resolved", requestId, behavior: "deny", source });
            return "rejected";
        }
        if (await steer(message) === "refused") {
            emit({ type: "request.resolved", requestId, behavior: "deny", source: "system" });
            return "unavailable";
        }
        emit({ type: "request.resolved", requestId, behavior: "answer", source: "user" });
        return "answered";
    });
    const choices = questionChoices(questions);
    emit({
        type: "request.opened", requestId, requestType: "question", tool: "ask_user", summary: askQuestionSummary(questions), questions,
        ...(choices ? { choices } : {}),
    });
}
/** requestUserInput's reply. Only the person's reply is filed: system notes never occupy the slot the model reads as their words. */
export function codexQuestionReply(behavior, message, source, questions) {
    const mapped = behavior === "answer" && source === "user" && typeof message === "string" ? questionAnswersById(message, questions) : {};
    // Null prototype: an id like __proto__ must not hit the inherited setter.
    const answers = Object.create(null);
    for (const [id, answer] of Object.entries(mapped))
        answers[id] = { answers: [answer] };
    return { answers };
}
