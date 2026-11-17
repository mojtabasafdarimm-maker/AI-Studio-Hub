// The time rides each turn's text, never the system prompt (whose stable half must stay byte-identical); engines add the date at most.
import { plainTimeZone } from "../shared/plain-time-zone.js";
export function hostTimeZone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
const parts = (at, timeZone) => {
    const formatted = new Intl.DateTimeFormat("en-US", {
        timeZone,
        weekday: "long",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZoneName: "longOffset",
    }).formatToParts(at);
    const part = (type) => formatted.find((entry) => entry.type === type)?.value ?? "";
    return { part, timeZone };
};
export const TURN_CLOCK_LEAD = "Current time when this message was sent: ";
export function turnClockLine(at, timeZone) {
    let read;
    try {
        read = parts(at, timeZone);
    }
    catch {
        read = parts(at, "UTC");
    }
    const { part } = read;
    // longOffset spells UTC as a bare "GMT", and some ICU builds write the minus sign as U+2212.
    const offset = part("timeZoneName").replace(/^GMT/, "").replace("\u2212", "-") || "+00:00";
    const plain = plainTimeZone(read.timeZone);
    return `${TURN_CLOCK_LEAD}${part("weekday")}, ${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")} ${read.timeZone} (${plain === read.timeZone ? "" : `${plain}, `}UTC${offset}).`;
}
/** Not for an empty text or a slash command: a prefix would turn an engine's own command into prose. */
export function takesTurnClock(text) {
    return Boolean(text.trim()) && !text.trimStart().startsWith("/");
}
export function withTurnClock(clock, text) {
    if (!clock || !takesTurnClock(text))
        return text;
    return `${clock}\n\n${text}`;
}
