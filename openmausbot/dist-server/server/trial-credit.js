export { TRIAL_CREDIT_REFUSED } from "../shared/trial-credit.js";
export const trialCreditEnds = (refusal) => refusal === "used_up" || refusal === "ended";
export const TRIAL_CREDIT_OWN_AI = "Your own AI is connected on My Cloud, so bots use it instead of the trial Claude credit.";
export const TRIAL_KEY_HELD = "Saved on My Cloud. Your bots use this key once the trial's Claude credit runs out.";
const RELAY_CODES = "trial_credit_used_up|trial_credit_ended|trial_credit_too_low|invalid_api_key";
const RELAY_CODE = new RegExp(`"code"\\s*:\\s*"(${RELAY_CODES})"|\\((${RELAY_CODES})\\)$`);
/** Only the relay's own codes end or pause the credit; a 401/402/403 without one (a proxy's page) is an ordinary failed call. */
export function trialCreditRefusal(status, body = "") {
    if (status === 429)
        return "paused";
    const match = RELAY_CODE.exec(body);
    const code = match?.[1] ?? match?.[2];
    if (status === 402 && code === "trial_credit_used_up")
        return "used_up";
    if ((status === 402 && code === "trial_credit_ended") || (status === 401 && code === "invalid_api_key"))
        return "ended";
    if (status === 400 && code === "trial_credit_too_low")
        return "too_low";
    return null;
}
const HTTP_FAILURE = /^upstream HTTP (\d{3})(?::\s?([\s\S]*))?$/;
export function trialCreditFailure(message) {
    const match = HTTP_FAILURE.exec(message);
    return match ? trialCreditRefusal(Number(match[1]), match[2] ?? "") : null;
}
