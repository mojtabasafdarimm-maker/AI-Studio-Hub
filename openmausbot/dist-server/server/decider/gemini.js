// Google's Decisions API for Gemini Decision 1. Error bodies are never read into a message: they can echo the request.
import { jevRequestBody, parseJevResponse, questionsFit, refusal } from "./jev.js";
export const GEMINI_DECIDER_URL = "https://generativelanguage.googleapis.com/v1beta/decisions";
export const GEMINI_DECIDER_MODEL = "gemini-decision-1";
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
/** Jev's questions, except that Google names a yes/no question's criteria `true_description` and `false_description`. */
export function geminiRequestBody(state, questions) {
    const wire = jevRequestBody(state, questions).questions;
    for (const [id, question] of Object.entries(questions)) {
        if (question.type !== "yesno" || !(question.criteria?.yes || question.criteria?.no))
            continue;
        wire[id] = {
            type: "noul",
            instructions: question.instructions,
            criteria: {
                ...(question.criteria.yes ? { true_description: question.criteria.yes } : {}),
                ...(question.criteria.no ? { false_description: question.criteria.no } : {}),
            },
        };
    }
    return { model: GEMINI_DECIDER_MODEL, input: typeof state === "string" ? state : JSON.stringify(state), questions: wire };
}
/** Google answers a bad key with 400 and reason API_KEY_INVALID, not 401. */
async function keyInvalid(response) {
    const body = await response.json().catch(() => null);
    const details = isRecord(body) && isRecord(body.error) ? body.error.details : undefined;
    return Array.isArray(details) && details.some((detail) => isRecord(detail) && detail.reason === "API_KEY_INVALID");
}
async function decide(request) {
    if (!questionsFit(request.questions))
        return { ok: false, reason: "misconfigured" };
    let response;
    try {
        response = await request.fetch(GEMINI_DECIDER_URL, {
            method: "POST",
            headers: { "x-goog-api-key": request.key, "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify(geminiRequestBody(request.state, request.questions)),
            signal: request.signal,
            redirect: "error",
        });
    }
    catch {
        return { ok: false, reason: "unreachable" };
    }
    if (!response.ok) {
        if (response.status === 400 && await keyInvalid(response))
            return { ok: false, reason: "rejected", status: 400 };
        await response.body?.cancel().catch(() => undefined);
        return refusal(response.status);
    }
    try {
        const body = await response.json();
        const parsed = parseJevResponse(body, request.questions);
        if (!parsed.ok || !isRecord(body))
            return { ok: false, reason: "malformed" };
        const tokens = isRecord(body.usage) ? body.usage.total_input_tokens : undefined;
        return {
            ok: true,
            answers: parsed.answers,
            model: GEMINI_DECIDER_MODEL,
            ...(typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? { inputTokens: tokens } : {}),
        };
    }
    catch {
        return { ok: false, reason: "malformed" };
    }
}
export const geminiBackend = { id: "gemini", decide };
