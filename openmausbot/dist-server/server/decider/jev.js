import { keySafeUrl } from "../provider-key-check.js";
export const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const JEV_MODEL = "jev-latest";
export const JEV_MAX_OPTIONS = 255;
export const JEV_MIN_LEVELS = 2;
export const JEV_MAX_LEVELS = 10;
/** Sent only with Cloud's included token, to the Admin's relay. */
export const RELAY_SEAM_HEADER = "x-omb-seam";
/** Null when the key must not be sent there: https anywhere, plain http only to this machine. */
export const jevEndpoint = (baseUrl) => keySafeUrl(baseUrl?.trim() || JEV_DEFAULT_BASE_URL, "v1/systemone");
/** Questions within the API's limits: 2–255 options, 2–10 levels. */
export function questionsFit(questions) {
    const entries = Object.entries(questions);
    if (!entries.length)
        return false;
    return entries.every(([, question]) => {
        if (question.type === "choice") {
            const count = Object.keys(question.options).length;
            return count >= 2 && count <= JEV_MAX_OPTIONS;
        }
        if (question.type === "score")
            return question.levels.length >= JEV_MIN_LEVELS && question.levels.length <= JEV_MAX_LEVELS;
        return true;
    });
}
export function jevRequestBody(state, questions) {
    const wire = {};
    for (const [id, question] of Object.entries(questions)) {
        if (question.type === "choice") {
            wire[id] = { type: "choice", instructions: question.instructions, criteria: { ...question.options } };
        }
        else if (question.type === "score") {
            wire[id] = { type: "score", instructions: question.instructions, criteria: [...question.levels] };
        }
        else {
            const criteria = question.criteria?.yes || question.criteria?.no
                ? { ...(question.criteria.yes ? { true: question.criteria.yes } : {}), ...(question.criteria.no ? { false: question.criteria.no } : {}) }
                : undefined;
            wire[id] = { type: "noul", instructions: question.instructions, ...(criteria ? { criteria } : {}) };
        }
    }
    return { state, model: JEV_MODEL, questions: wire };
}
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isProbability = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
/** Jev rounds to two places, so a map can sum to 0.98 or 1.02. */
const SUM_TOLERANCE = 0.1;
const EPSILON = 1e-9;
function parseChoice(raw, question) {
    const offered = new Set(Object.keys(question.options));
    const choice = raw.choice;
    if (typeof choice !== "string" || !offered.has(choice))
        return null;
    if (!isRecord(raw.probabilities))
        return null;
    const probabilities = {};
    let sum = 0;
    for (const [key, value] of Object.entries(raw.probabilities)) {
        if (!offered.has(key) || !isProbability(value))
            return null;
        probabilities[key] = value;
        sum += value;
    }
    if (!(Math.abs(sum - 1) <= SUM_TOLERANCE))
        return null;
    const pTop = probabilities[choice];
    if (pTop === undefined)
        return null;
    const others = Object.entries(probabilities).filter(([key]) => key !== choice).map(([, value]) => value);
    const runnerUp = others.length ? Math.max(...others) : 0;
    // Ties break to the first key on the vendor side; a choice that is not the most likely option is not what it claims.
    if (runnerUp > pTop + EPSILON)
        return null;
    return { type: "choice", choice, pTop, margin: pTop - runnerUp, probabilities };
}
function parseScore(raw, question) {
    const levels = question.levels.length;
    const score = raw.score;
    if (typeof score !== "number" || !Number.isFinite(score) || score < -EPSILON || score > levels - 1 + EPSILON)
        return null;
    if (!isRecord(raw.probabilities))
        return null;
    const probabilities = Array.from({ length: levels }, () => 0);
    for (const [key, value] of Object.entries(raw.probabilities)) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= levels || String(index) !== key || !isProbability(value))
            return null;
        probabilities[index] = value;
    }
    const sum = probabilities.reduce((total, value) => total + value, 0);
    if (!(Math.abs(sum - 1) <= SUM_TOLERANCE))
        return null;
    const level = probabilities.indexOf(Math.max(...probabilities));
    return { type: "score", score, level, probabilities };
}
function parseYesNo(raw) {
    return isProbability(raw.noul) ? { type: "yesno", p: raw.noul } : null;
}
const WIRE_TYPE = { choice: "choice", score: "score", yesno: "noul" };
export function parseJevResponse(body, questions) {
    if (!isRecord(body) || !isRecord(body.answers))
        return { ok: false };
    const answers = {};
    for (const [id, question] of Object.entries(questions)) {
        const raw = body.answers[id];
        if (!isRecord(raw))
            return { ok: false };
        if (raw.type !== undefined && raw.type !== WIRE_TYPE[question.type])
            return { ok: false };
        const parsed = question.type === "choice" ? parseChoice(raw, question)
            : question.type === "score" ? parseScore(raw, question)
                : parseYesNo(raw);
        if (!parsed)
            return { ok: false };
        answers[id] = parsed;
    }
    const usage = isRecord(body.usage) ? body.usage.input_tokens : undefined;
    const inputTokens = typeof usage === "number" && Number.isFinite(usage) && usage >= 0 ? usage : undefined;
    const model = typeof body.model === "string" && body.model.length <= 80 ? body.model : undefined;
    return { ok: true, answers, ...(inputTokens !== undefined ? { inputTokens } : {}), ...(model ? { model } : {}) };
}
export function refusal(status) {
    if (status === 413)
        return { ok: false, reason: "too_large", status };
    if (status === 401 || status === 403)
        return { ok: false, reason: "rejected", status };
    if (status === 429)
        return { ok: false, reason: "rate_limited", status };
    if (status === 529 || status === 503)
        return { ok: false, reason: "overloaded", status };
    return { ok: false, reason: "http_error", status };
}
async function decide(request) {
    const endpoint = jevEndpoint(request.baseUrl);
    if (!endpoint || !questionsFit(request.questions))
        return { ok: false, reason: "misconfigured" };
    let response;
    try {
        response = await request.fetch(endpoint, {
            method: "POST",
            headers: {
                authorization: `Bearer ${request.key}`, "content-type": "application/json", accept: "application/json",
                // The relay checks the request against this seam's shape (server/decider/relay.ts); Jev itself never sees it.
                ...(request.relaySeam ? { [RELAY_SEAM_HEADER]: request.relaySeam } : {}),
            },
            body: JSON.stringify(jevRequestBody(request.state, request.questions)),
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
    const parsed = parseJevResponse(body, request.questions);
    return parsed.ok ? parsed : { ok: false, reason: "malformed" };
}
export const jevBackend = { id: "jev", decide };
