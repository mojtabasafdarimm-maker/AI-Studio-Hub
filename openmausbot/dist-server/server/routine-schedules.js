// What a routine's schedule is and when it next runs: parsed from input, loaded from disk, cloned and merged on edits.
import { AFTER_RESET_MS } from "../shared/limit-reset.js";
import { normalizeCronSchedule, nextCronRuns } from "../shared/routine-schedule.js";
import { clockMinutes, INTERVAL_RESTRICTION_SEARCH_MS, intervalAllowsOccurrence, intervalHasRestrictions, MAX_DATE_MS, nextAlignedInterval } from "./routine-intervals.js";
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
export function cleanDays(days) {
    if (!Array.isArray(days))
        return ALL_DAYS;
    const out = [...new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    return out.length ? out : ALL_DAYS;
}
export function cloneSchedule(schedule) {
    if (schedule.type === "once")
        return { type: "once", at: schedule.at };
    if (schedule.type === "cron" || schedule.type === "limit_reset")
        return { ...schedule };
    if (schedule.type === "interval") {
        return {
            type: "interval",
            everyMinutes: schedule.everyMinutes,
            anchorAt: schedule.anchorAt,
            ...(schedule.weekdays ? { weekdays: [...schedule.weekdays] } : {}),
            ...(schedule.window ? { window: { ...schedule.window } } : {}),
            ...(schedule.endsAt === undefined ? {} : { endsAt: schedule.endsAt }),
        };
    }
    return { type: "daily", time: schedule.time, weekdays: [...schedule.weekdays] };
}
function cleanIntervalWeekdays(value) {
    if (value == null)
        return undefined;
    if (!Array.isArray(value) || value.length === 0 || value.length > ALL_DAYS.length) {
        throw new Error("Choose at least one valid interval day");
    }
    if (value.some((day) => typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6)) {
        throw new Error("Interval days must be whole numbers from 0 to 6");
    }
    if (new Set(value).size !== value.length)
        throw new Error("Choose each interval day only once");
    const weekdays = [...value].sort((a, b) => a - b);
    return weekdays.length === ALL_DAYS.length ? undefined : weekdays;
}
function cleanIntervalWindow(value, everyMinutes) {
    if (value == null)
        return undefined;
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Choose a valid interval time window");
    }
    const candidate = value;
    const start = typeof candidate.start === "string" ? candidate.start : "";
    const end = typeof candidate.end === "string" ? candidate.end : "";
    const startMinutes = clockMinutes(start);
    const endMinutes = clockMinutes(end);
    if (startMinutes == null || endMinutes == null) {
        throw new Error("Interval window times must use HH:MM");
    }
    if (startMinutes >= endMinutes) {
        throw new Error("Interval window must start before it ends on the same day");
    }
    if (endMinutes - startMinutes < everyMinutes) {
        throw new Error("Interval window must be at least as long as the interval");
    }
    return { start, end };
}
function cleanIntervalEndsAt(value, anchorAt) {
    if (value == null)
        return undefined;
    if (typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < anchorAt ||
        value > MAX_DATE_MS) {
        throw new Error("Choose a valid interval end time after its start");
    }
    return value;
}
export class RoutineScheduleError extends Error {
    status = 400;
}
const ENGINE_ID = /^[\w.:-]{1,128}$/;
function parseSchedule(schedule, after) {
    if (schedule?.type === "cron")
        return normalizeCronSchedule(schedule, after);
    if (schedule?.type === "limit_reset") {
        const engine = typeof schedule.engine === "string" ? schedule.engine.trim() : "";
        if (!ENGINE_ID.test(engine))
            throw new Error("Choose which AI's limit to wait for");
        if (schedule.repeat !== undefined && schedule.repeat !== "once" && schedule.repeat !== "every_reset")
            throw new Error("Choose once or every reset");
        const at = typeof schedule.at === "number" && Number.isSafeInteger(schedule.at) && schedule.at > 0 && schedule.at <= MAX_DATE_MS ? schedule.at : null;
        return { type: "limit_reset", engine, repeat: schedule.repeat ?? "once", at };
    }
    if (schedule?.type === "once") {
        const at = Number(schedule.at);
        if (!Number.isFinite(at) || Math.abs(at) > MAX_DATE_MS)
            throw new Error("Choose a valid date and time");
        return { type: "once", at };
    }
    if (schedule?.type === "daily") {
        const time = String(schedule.time ?? "");
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
            throw new Error("Time must use HH:MM");
        return { type: "daily", time, weekdays: cleanDays(schedule.weekdays) };
    }
    if (schedule?.type === "interval") {
        const { everyMinutes, anchorAt } = schedule;
        if (typeof everyMinutes !== "number" || !Number.isInteger(everyMinutes) || everyMinutes < 5 || everyMinutes > 1_440) {
            throw new Error("Interval must be a whole number from 5 to 1440 minutes");
        }
        if (typeof anchorAt !== "number" ||
            !Number.isSafeInteger(anchorAt) ||
            anchorAt < 0 ||
            anchorAt > MAX_DATE_MS) {
            throw new Error("Choose a valid interval start time");
        }
        const weekdays = cleanIntervalWeekdays(schedule.weekdays);
        const window = cleanIntervalWindow(schedule.window, everyMinutes);
        const endsAt = cleanIntervalEndsAt(schedule.endsAt, anchorAt);
        return {
            type: "interval",
            everyMinutes,
            anchorAt,
            ...(weekdays ? { weekdays } : {}),
            ...(window ? { window } : {}),
            ...(endsAt === undefined ? {} : { endsAt }),
        };
    }
    throw new Error("Choose a supported schedule");
}
export function cleanSchedule(schedule, after) {
    try {
        return parseSchedule(schedule, after);
    }
    catch (error) {
        throw new RoutineScheduleError(error.message);
    }
}
export function loadSchedule(value, after) {
    try {
        return cleanSchedule(value, after);
    }
    catch {
        return null;
    }
}
export function nextOccurrence(schedule, after) {
    if (schedule.type === "once")
        return schedule.at > after ? schedule.at : null;
    if (schedule.type === "limit_reset")
        return schedule.at !== null && schedule.at > after ? schedule.at : null;
    if (schedule.type === "cron")
        return nextCronRuns(schedule, after, 1)[0] ?? null;
    if (schedule.type === "interval") {
        const intervalMs = schedule.everyMinutes * 60_000;
        let candidate = nextAlignedInterval(schedule, after);
        if (!intervalHasRestrictions(schedule))
            return candidate;
        const maxCandidates = Math.ceil(INTERVAL_RESTRICTION_SEARCH_MS / intervalMs) + 2;
        for (let checked = 0; candidate !== null && checked < maxCandidates; checked++) {
            if (schedule.endsAt !== undefined && candidate > schedule.endsAt)
                return null;
            if (intervalAllowsOccurrence(schedule, candidate))
                return candidate;
            const next = candidate + intervalMs;
            candidate = Number.isSafeInteger(next) && next <= MAX_DATE_MS ? next : null;
        }
        return null;
    }
    const [hour, minute] = schedule.time.split(":").map(Number);
    const weekdays = new Set(cleanDays(schedule.weekdays));
    for (let offset = 0; offset <= 8; offset++) {
        const d = new Date(after);
        d.setDate(d.getDate() + offset);
        d.setHours(hour, minute, 0, 0);
        if (d.getTime() > after && weekdays.has(d.getDay()))
            return d.getTime();
    }
    return null;
}
export function mergeScheduleUpdate(current, incoming) {
    if (current.type !== "interval" || incoming.type !== "interval")
        return incoming;
    const merged = { ...incoming };
    if (!Object.hasOwn(incoming, "weekdays") && current.weekdays) {
        merged.weekdays = [...current.weekdays];
    }
    if (!Object.hasOwn(incoming, "window") && current.window) {
        merged.window = { ...current.window };
    }
    if (!Object.hasOwn(incoming, "endsAt") && current.endsAt !== undefined) {
        merged.endsAt = current.endsAt;
    }
    return merged;
}
/** When a limit-reset routine runs: just after the engine's reset, or null while that is not known. A routine never
 * runs twice for one reset, so its time must come after the run it already had. */
export function limitResetOccurrence(resetsAt, lastRunFor) {
    if (resetsAt === null || !Number.isFinite(resetsAt))
        return null;
    const at = resetsAt + AFTER_RESET_MS;
    return lastRunFor !== undefined && at <= lastRunFor ? null : at;
}
export function noFutureResumeMessage(schedule) {
    if (schedule.type === "interval") {
        return "That interval routine has no future runs. Choose a later end time or remove the end restriction before resuming.";
    }
    if (schedule.type === "once") {
        return "That one-time routine's scheduled time has passed. Update it to a new future time before resuming.";
    }
    return "That routine has no future runs. Update its schedule before resuming.";
}
