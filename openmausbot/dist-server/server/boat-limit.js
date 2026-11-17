import { cloudLimitFromBody, cloudLimitSentence } from "../shared/place-view.js";
export function cloudFailureOf(error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const { boatCode, boatStatus, status } = failure;
    const providerStatus = typeof boatStatus === "number" ? boatStatus : typeof status === "number" ? status : undefined;
    const limit = cloudLimitFields(failure).cloudLimit;
    return {
        message: failure.message,
        ...(typeof boatCode === "string" ? { code: boatCode } : {}),
        ...(providerStatus !== undefined ? { status: providerStatus } : {}),
        ...(limit ? { limit } : {}),
    };
}
/** What the bot is told when the Admin turned its cloud computer away by one of the Cloud's limits. */
export const cloudLimitText = (error) => cloudLimitSentence(cloudFailureOf(error)) ?? undefined;
/** An HTTP error body's `cloudLimit`: the Admin's limit, beside the words, for the app to read. */
export function cloudLimitFields(error) {
    const limit = error && typeof error === "object" ? cloudLimitFromBody(error.boatLimit) : undefined;
    return limit ? { cloudLimit: limit } : {};
}
