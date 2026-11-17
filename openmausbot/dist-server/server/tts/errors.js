import { NoVoiceConfigured } from "./index.js";
import { OpenAiVoiceError } from "./openai.js";
export function voiceFailure(error) {
    if (error instanceof OpenAiVoiceError) {
        return { status: error.errorKey === "voice.openai.error.key" ? 409 : 502, body: { error: error.message, errorKey: error.errorKey } };
    }
    if (error instanceof NoVoiceConfigured)
        return { status: 409, body: { error: error.message } };
    return undefined;
}
export function voiceNoteFailure(error) {
    const known = voiceFailure(error);
    if (known)
        return known;
    const status = error?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
        return { status, body: { error: error instanceof Error ? error.message : "voice note failed" } };
    }
    return undefined;
}
