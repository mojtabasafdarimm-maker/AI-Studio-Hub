import { keySafeUrl } from "../provider-key-check.js";
import { jevRequestBody, parseJevResponse, questionsFit, refusal } from "./jev.js";
import { chatRequestBody, parseChatResponse } from "./openrouter.js";
export const CUSTOM_DEFAULT_API = "systemone";
const CUSTOM_PATH = { systemone: "systemone", decisions: "decisions", chat: "chat/completions" };
/** A saved or requested protocol, or the default for anything else. */
export const customApiOf = (api) => api === "decisions" || api === "chat" ? api : CUSTOM_DEFAULT_API;
/** Null without a base URL, or when the key must not be sent there. */
export function customEndpoint(baseUrl, api) {
    return baseUrl?.trim() ? keySafeUrl(baseUrl, CUSTOM_PATH[api]) : null;
}
function requestBody(api, state, questions, model) {
    if (api === "decisions")
        return decisionsBody(state, questions, model);
    return api === "chat" ? customChatBody(state, questions, model) : systemOneBody(state, questions, model);
}
/** OpenRouter's chat body without its `max_tokens`: a thinking model behind the gateway (Gemini 2.5 and later) counts its thinking
 * against that cap, which is sized for the answer alone, and could answer empty. The gateway's own limit applies instead. */
function customChatBody(state, questions, model) {
    const { max_tokens: _answerOnly, ...body } = chatRequestBody(state, questions, model);
    return body;
}
export function systemOneBody(state, questions, model) {
    return { ...jevRequestBody(state, questions), model };
}
function decisionsQuestion(name, question) {
    if (question.type === "choice") {
        return {
            type: "choice", name, instructions: question.instructions,
            choices: Object.entries(question.options).map(([value, description]) => ({ value, description })),
        };
    }
    if (question.type === "score") {
        return { type: "score", name, instructions: question.instructions, levels: question.levels.map((label) => ({ label, description: label })) };
    }
    return { type: "predicate", name, instructions: question.instructions };
}
export function decisionsBody(state, questions, model) {
    return {
        model,
        input: typeof state === "string" ? state : JSON.stringify(state),
        questions: Object.entries(questions).map(([id, question]) => decisionsQuestion(id, question)),
        stream: false,
    };
}
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const WIRE_TYPE = { choice: "choice", score: "score", yesno: "predicate" };
/** One `/decisions` answer in Jev's answer shape, for `parseJevResponse` to check; null when it cannot be one. */
function asJevAnswer(raw, question) {
    if (!isRecord(raw) || raw.type !== WIRE_TYPE[question.type])
        return null;
    if (question.type === "yesno")
        return { noul: raw.probability };
    if (!Array.isArray(raw.probabilities))
        return null;
    const probabilities = {};
    for (const entry of raw.probabilities) {
        if (!isRecord(entry))
            return null;
        const key = question.type === "choice" ? entry.value : typeof entry.value === "number" ? String(entry.value) : undefined;
        if (typeof key !== "string" || key in probabilities)
            return null;
        probabilities[key] = entry.probability;
    }
    return question.type === "choice" ? { choice: raw.choice, probabilities } : { score: raw.score, probabilities };
}
export function parseDecisionsResponse(body, questions) {
    const entries = Object.entries(questions);
    if (!isRecord(body) || !Array.isArray(body.answers) || body.answers.length !== entries.length)
        return { ok: false };
    const answers = {};
    for (const [index, [id, question]] of entries.entries()) {
        const answer = asJevAnswer(body.answers[index], question);
        if (!answer)
            return { ok: false };
        answers[id] = answer;
    }
    return parseJevResponse({ answers, usage: body.usage, model: body.model }, questions);
}
async function decide(request) {
    const api = customApiOf(request.api);
    const endpoint = customEndpoint(request.baseUrl, api);
    const model = request.model?.trim();
    if (!endpoint || !model || !questionsFit(request.questions))
        return { ok: false, reason: "misconfigured" };
    let response;
    try {
        response = await request.fetch(endpoint, {
            method: "POST",
            headers: { authorization: `Bearer ${request.key}`, "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify(requestBody(api, request.state, request.questions, model)),
            signal: request.signal,
            // Never replay the key to wherever a redirect points.
            redirect: "error",
        });
    }
    catch {
        return { ok: false, reason: "unreachable" };
    }
    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return refusal(response.status);
    }
    let body;
    try {
        body = await response.json();
    }
    catch {
        return { ok: false, reason: "malformed" };
    }
    if (api === "chat")
        return parseChatResponse(body, request.questions);
    const parsed = api === "decisions" ? parseDecisionsResponse(body, request.questions) : parseJevResponse(body, request.questions);
    return parsed.ok ? parsed : { ok: false, reason: "malformed" };
}
export const customBackend = { id: "custom", decide };
