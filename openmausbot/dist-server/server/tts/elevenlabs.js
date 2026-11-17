// Runs on the harness, never the renderer: the key must not leave the server. OMB_ELEVENLABS_API overrides the
// base URL for dev and tests.
import { elevenLabsProviderApi } from "../included-services.js";
import { userErrorThrown } from "../user-errors.js";
const MODEL = "eleven_flash_v2_5";
// Flash v2.5 has no Thai, Bengali, Hebrew, Georgian, Armenian, Gujarati, Punjabi, Telugu, Kannada or Malayalam; Eleven v3
// speaks them. Text in one of their scripts goes to v3, everything else stays on the faster Flash. The plan's included
// voice relay takes Flash and Turbo only, so through it every line stays on Flash.
const BEYOND_FLASH = /[\u0E00-\u0E7F\u0980-\u09FF\u0590-\u05FF\u10A0-\u10FF\u1C90-\u1CBF\u0530-\u058F\u0A80-\u0AFF\u0A00-\u0A7F\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F]/;
export const speechModel = (text, included = false) => (!included && BEYOND_FLASH.test(text) ? "eleven_v3" : MODEL);
const HEARING_MODEL = "scribe_v2";
// 64kbps mono is indistinguishable for speech and a third of the bytes
const FORMAT = "mp3_44100_64";
async function safeJson(res) {
    try {
        return await res.json();
    }
    catch {
        return null;
    }
}
function message(status, what, body, permissions = "Voices and Text to Speech") {
    const theirs = (typeof body?.detail === "string" && body.detail.trim()) ||
        (typeof body?.detail?.message === "string" && body.detail.message.trim()) ||
        (typeof body?.message === "string" && body.message.trim()) ||
        "";
    if (status === 401 || status === 403) {
        return `ElevenLabs rejected that key. If it's a restricted key, give it the ${permissions} permissions — or paste an unrestricted one.`;
    }
    if (status === 429)
        return theirs || "ElevenLabs is rate-limiting this account — wait a moment and try again.";
    if (status === 402)
        return theirs || "ElevenLabs says this account is out of credit.";
    return theirs ? `${what} failed: ${theirs}` : `${what} failed (${status})`;
}
/** Checked against /voices, not /user: ElevenLabs keys carry per-endpoint scopes, and a speech-only key has no `user_read`. */
export async function verifyKey(key) {
    try {
        const res = await fetch(`${elevenLabsProviderApi()}/voices`, {
            headers: { "xi-api-key": key },
            redirect: "error",
            signal: AbortSignal.timeout(20_000),
        });
        if (res.ok)
            return { ok: true };
        return { ok: false, message: message(res.status, "checking that key", await safeJson(res)) };
    }
    catch {
        return { ok: false, message: "Couldn't reach ElevenLabs to check that key — check your connection." };
    }
}
async function getJson(key, url, what) {
    const res = await fetch(url, {
        headers: { "xi-api-key": key },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
    });
    const body = await safeJson(res);
    if (!res.ok)
        throw new Error(message(res.status, what, body));
    return body;
}
async function accountVoices(key, api) {
    const body = await getJson(key, `${api}/voices`, "listing voices");
    return (body?.voices ?? [])
        .map((v) => ({
        id: String(v.voice_id ?? ""),
        label: String(v.name ?? "Voice"),
        description: [v.labels?.accent, v.labels?.description].filter(Boolean).join(" · ") || undefined,
    }))
        .filter((v) => v.id);
}
async function sharedVoices(key, api, query) {
    const body = await getJson(key, `${api}/shared-voices?page_size=100&${query}`, "searching the Voice Library");
    return (body?.voices ?? [])
        .map((v) => ({
        id: String(v.voice_id ?? ""),
        label: String(v.name ?? "Voice"),
        description: [v.accent, v.description].filter(Boolean).join(" · ") || undefined,
        ...(v.is_added_by_user ? {} : { publicOwnerId: String(v.public_owner_id ?? "") }),
    }))
        .filter((v) => v.id && v.publicOwnerId !== "");
}
/** A Voice Library share link (`…/share/<owner>/<voice>`), a `voiceId=` link, or a bare voice id. */
export function pastedVoice(input) {
    const text = input.trim();
    const share = /\/share\/([A-Za-z0-9]+)\/([A-Za-z0-9]+)(?=$|[/?#])/.exec(text);
    if (share)
        return { owner: share[1], id: share[2] };
    const param = /[?&]voiceId=([A-Za-z0-9]+)(?=$|[&#])/.exec(text);
    if (param)
        return { id: param[1] };
    return /^[A-Za-z0-9]{20}$/.test(text) ? { id: text } : undefined;
}
const firstOfEachId = (voices) => voices.filter((voice, index) => voices.findIndex((v) => v.id === voice.id) === index);
export async function listVoices(key, api, { query } = {}) {
    const account = await accountVoices(key, api);
    const trimmed = query?.trim() ?? "";
    if (!trimmed)
        return account;
    const pasted = pastedVoice(trimmed);
    if (pasted) {
        const mine = account.find((voice) => voice.id === pasted.id);
        if (mine)
            return [mine];
        if (pasted.owner) {
            const owned = await sharedVoices(key, api, `owner_id=${encodeURIComponent(pasted.owner)}`);
            const match = owned.find((voice) => voice.id === pasted.id);
            if (match)
                return [match];
        }
    }
    const needle = trimmed.toLowerCase();
    const library = await sharedVoices(key, api, `search=${encodeURIComponent(pasted?.id ?? trimmed)}`);
    return firstOfEachId([...account.filter((voice) => voice.label.toLowerCase().includes(needle)), ...library]);
}
export async function addSharedVoice(key, api, publicOwnerId, voiceId, name) {
    const res = await fetch(`${api}/voices/add/${encodeURIComponent(publicOwnerId)}/${encodeURIComponent(voiceId)}`, {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ new_name: name }),
        signal: AbortSignal.timeout(20_000),
        redirect: "error",
    });
    const body = await safeJson(res);
    if (!res.ok)
        throw new Error(message(res.status, "adding that voice", body));
    return typeof body?.voice_id === "string" && body.voice_id ? body.voice_id : voiceId;
}
// tsconfig.server.json targets ES2023: Promise.withResolvers is ES2024.
function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}
export function synthesize(text, voiceId, key, api, included = false) {
    const firstAudio = withResolvers();
    const audio = withResolvers();
    // Callers may consume only `audio`: a failure before the first chunk must not become an unhandled rejection.
    firstAudio.promise.catch(() => { });
    void (async () => {
        try {
            const res = await fetch(`${api}/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${FORMAT}`, {
                method: "POST",
                headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
                body: JSON.stringify({ text, model_id: speechModel(text, included) }),
                redirect: "error",
                signal: AbortSignal.timeout(60_000),
            });
            if (!res.ok)
                throw new Error(message(res.status, "speaking", await safeJson(res)));
            if (!res.body)
                throw new Error("speaking failed: no audio came back");
            const reader = res.body.getReader();
            const chunks = [];
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                if (!value?.length)
                    continue;
                chunks.push(value);
                if (chunks.length === 1)
                    firstAudio.resolve({ bytes: value, mime: "audio/mpeg" });
            }
            if (!chunks.length)
                throw new Error("speaking failed: the audio came back empty");
            audio.resolve({ bytes: Buffer.concat(chunks), mime: "audio/mpeg" });
        }
        catch (error) {
            firstAudio.reject(error);
            audio.reject(error);
        }
    })();
    return { firstAudio: firstAudio.promise, audio: audio.promise };
}
/** Speech-to-text with Scribe, for listening where no Fish Audio key is saved. Only the person's own key comes here. */
export async function transcribe(audio, mime, key, api) {
    const form = new FormData();
    form.append("model_id", HEARING_MODEL);
    form.append("tag_audio_events", "false");
    form.append("file", new Blob([audio], { type: mime }), "speech.wav");
    let res;
    try {
        res = await fetch(`${api}/speech-to-text`, {
            method: "POST",
            headers: { "xi-api-key": key },
            body: form,
            redirect: "error",
            signal: AbortSignal.timeout(60_000),
        });
    }
    catch {
        throw userErrorThrown("serverError.voice.elevenLabsTranscribeConnection");
    }
    const body = await safeJson(res);
    if (!res.ok)
        throw new Error(message(res.status, "hearing you", body, "Speech to Text"));
    return typeof body?.text === "string" ? body.text.trim() : "";
}
