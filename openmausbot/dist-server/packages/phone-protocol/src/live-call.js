// Pure pieces of a Live (GPT-Live) call. With client delegation GPT-Live says
// *that* it wants help, never *what*: `session.delegation.created` carries an id
// and a timeline offset, so the request is rebuilt from the input transcript.
/** Collects `session.input_transcript.delta` fragments on the session
 * timeline. Fragments are appended in delivery order, as the API asks. */
export class LiveTranscript {
    input = [];
    /** when the voice itself was speaking, on the same timeline */
    output = [];
    cutoffMs = -1;
    addInput(text, startMs, endMs) {
        if (!text)
            return;
        this.input.push({ text, startMs: Number.isFinite(startMs) ? startMs : 0, endMs: Number.isFinite(endMs) ? endMs : 0 });
        // keep memory bounded on long calls: only the unconsumed tail matters
        if (this.input.length > 2_000)
            this.input = this.input.filter((segment) => segment.startMs > this.cutoffMs);
    }
    /** A stretch of the voice's own speech (a `session.output_transcript.delta`
     * with its timing). Input heard during it may be the voice itself, picked
     * up again by the microphone of a phone on speaker. Deltas without timing
     * are ignored. */
    addOutput(startMs, endMs) {
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs)
            return;
        const last = this.output.at(-1);
        if (last && startMs <= last.endMs)
            last.endMs = Math.max(last.endMs, endMs);
        else
            this.output.push({ startMs, endMs });
        if (this.output.length > 500)
            this.output.splice(0, this.output.length - 500);
    }
    /** The words spoken since the previous request, up to a little past the
     * delegation point (transcription can trail the delegation event, and the
     * person may finish the sentence that triggered it). Consumes them, so the
     * next request starts after this one. */
    takeRequest(offsetMs, graceMs = 1_500) {
        return this.takeRequestParts(offsetMs, graceMs).text;
    }
    /** takeRequest, plus the same words without those heard while the voice
     * spoke (`withoutEcho`), for reading a spoken yes/no. Consumes all of them. */
    takeRequestParts(offsetMs, graceMs = 1_500) {
        const until = offsetMs + graceMs;
        const taken = this.input.filter((segment) => segment.startMs > this.cutoffMs && segment.startMs <= until);
        if (!taken.length)
            return { text: "", withoutEcho: "" };
        this.cutoffMs = Math.max(this.cutoffMs, ...taken.map((segment) => segment.startMs));
        return {
            text: joinFragments(taken.map((segment) => segment.text)),
            withoutEcho: joinFragments(taken.filter((segment) => !this.echoed(segment)).map((segment) => segment.text)),
        };
    }
    /** Everything heard since the last taken request, without consuming it —
     * used to read a spoken yes/no while a permission question is open.
     * `skipEcho` leaves out what was heard while the voice itself spoke. */
    pending(options = {}) {
        return joinFragments(this.input
            .filter((segment) => segment.startMs > this.cutoffMs && !(options.skipEcho && this.echoed(segment)))
            .map((segment) => segment.text));
    }
    echoed(segment) {
        return this.output.some((span) => segment.startMs < span.endMs && segment.endMs > span.startMs);
    }
    /** Mark everything heard so far as handled (e.g. after a spoken decision). */
    consumeAll() {
        for (const segment of this.input)
            this.cutoffMs = Math.max(this.cutoffMs, segment.startMs);
    }
}
/** Transcript deltas are fragments of words, not words: glue them as sent. */
export function joinFragments(fragments) {
    return fragments.join("").replace(/\s+/g, " ").trim();
}
export const FULL_ANSWER_IN_CHAT = "The full answer is in the chat.";
/** GPT-Live voices from OpenAI's documentation (Managing GPT-Live sessions,
 * "Voice options", and the SDK's BuiltInVoice list), with the regional
 * notes the docs give for the additional ones. */
export const LIVE_VOICE_OPTIONS = [
    { id: "marin", label: "Marin (default)" },
    { id: "cedar", label: "Cedar" },
    { id: "alloy", label: "Alloy" },
    { id: "ash", label: "Ash" },
    { id: "ballad", label: "Ballad" },
    { id: "coral", label: "Coral" },
    { id: "echo", label: "Echo" },
    { id: "sage", label: "Sage" },
    { id: "shimmer", label: "Shimmer" },
    { id: "verse", label: "Verse" },
    { id: "gleam", label: "Gleam — North American, feminine" },
    { id: "meridian", label: "Meridian — North American, masculine" },
    { id: "quartz", label: "Quartz — Australian, feminine" },
    { id: "ripple", label: "Ripple — Australian, masculine" },
    { id: "vesper", label: "Vesper — British, masculine" },
    { id: "willow", label: "Willow — Irish, feminine" },
    { id: "stone", label: "Stone — Irish, masculine" },
    { id: "delta", label: "Delta — Southern U.S., feminine" },
    { id: "cinder", label: "Cinder — Southern U.S., masculine" },
    { id: "beacon", label: "Beacon — Filipino, masculine" },
    { id: "bossa", label: "Bossa — Brazilian Portuguese, feminine" },
    { id: "tempo", label: "Tempo — Brazilian Portuguese, masculine" },
];
/** Gemini Live's prebuilt voices (Gemini API docs, "Live API capabilities", voices), with the docs' one-word character.
 * Gemini names them with a capital letter. */
export const GEMINI_LIVE_VOICE_OPTIONS = [
    { id: "Puck", label: "Puck — upbeat (default)" },
    { id: "Charon", label: "Charon — informative" },
    { id: "Kore", label: "Kore — firm" },
    { id: "Fenrir", label: "Fenrir — excitable" },
    { id: "Aoede", label: "Aoede — breezy" },
    { id: "Leda", label: "Leda — youthful" },
    { id: "Orus", label: "Orus — firm" },
    { id: "Zephyr", label: "Zephyr — bright" },
];
export const GEMINI_LIVE_DEFAULT_VOICE = "Puck";
/** A saved Gemini voice when it is one of Gemini's, else the default. */
export function geminiLiveVoice(voice) {
    return GEMINI_LIVE_VOICE_OPTIONS.find((option) => option.id === voice?.trim())?.id ?? GEMINI_LIVE_DEFAULT_VOICE;
}
/** Whether `voice` is one of the voices a bot can have of its own for Live calls: a GPT-Live or a Gemini Live voice. */
export function isBotLiveVoice(voice) {
    return [...LIVE_VOICE_OPTIONS, ...GEMINI_LIVE_VOICE_OPTIONS].some((option) => option.id === voice);
}
/** The voice a Live call with a bot speaks in: the bot's own voice when it is one of this provider's, else the app's. */
export function botCallVoice(botVoice, appVoice, gemini) {
    return (gemini ? GEMINI_LIVE_VOICE_OPTIONS : LIVE_VOICE_OPTIONS).some((option) => option.id === botVoice) ? botVoice : appVoice;
}
/** A call's length as a clock: m:ss under an hour ("0:07", "1:42"),
 * h:mm:ss from an hour on ("1:02:05"). Whole seconds; a value that is not a
 * length reads as 0:00. */
export function formatCallDuration(seconds) {
    const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    const hours = Math.floor(total / 3_600);
    const minutes = Math.floor((total % 3_600) / 60);
    const rest = String(total % 60).padStart(2, "0");
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}
/** A Live call row's text: what a client that does not know kind "call"
 * shows as a plain line ("Call with Ada · 1:42"). */
export function liveCallRowText(botName, seconds) {
    return `Call with ${botName} · ${formatCallDuration(seconds)}`;
}
