// The `schedule` section of a Cloud home's health report, made from the occurrence ledger each time the report is read.
// Times, counts, booleans and fixed state words only: no routine's id, name, prompt, output, schedule rule or bot.
import { occurrenceEnded, occurrenceLastAt } from "./routine-ledger.js";
import { LATE_START_MS } from "./routine-occurrences.js";
const DAY_MS = 24 * 60 * 60_000, MAX_TIME = 1e15, MAX_COUNT = 1e9;
const whole = (value, max) => Math.min(max, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));
const counts = (value) => ({ ran: whole(value.ran, MAX_COUNT), failed: whole(value.failed, MAX_COUNT), missed: whole(value.missed, MAX_COUNT), late: whole(value.late, MAX_COUNT), retried: whole(value.retried, MAX_COUNT) });
/** The last 24 hours, from the saved records. A record that counts a span of occurrences gives the share of them that
 * falls in the day. Occurrences passed over only because the scheduler itself was held up are no misses and are left out. */
export function dayCounts(records, now) {
    const day = { ran: 0, failed: 0, missed: 0, late: 0, retried: 0 }, from = now - DAY_MS;
    const within = (at) => at !== undefined && at > from && at <= now;
    for (const record of records) {
        if (record.void || record.reason === "scheduler-late")
            continue;
        if (record.attempts > 0 && within(record.startedAt)) {
            if (record.startedAt - record.dueAt > LATE_START_MS)
                day.late += 1;
            day.retried += record.attempts - 1;
        }
        if (!occurrenceEnded(record))
            continue;
        if (record.state === "ran" || record.state === "failed") {
            if (within(record.endedAt))
                day[record.state] += 1;
            continue;
        }
        const last = occurrenceLastAt(record), span = last - record.dueAt, total = record.count ?? 1;
        if (total === 1 || span <= 0) {
            if (within(record.endedAt ?? last))
                day.missed += total;
            continue;
        }
        const overlap = Math.min(last, now) - Math.max(record.dueAt, from);
        if (overlap >= 0)
            day.missed += Math.min(total, Math.max(1, Math.ceil(total * overlap / span)));
    }
    return day;
}
export function scheduleSection({ seq, unreadable, slowStops, next, records, boot, now }) {
    const all = [...records], base = { v: 1, seq: whole(seq, MAX_TIME), unreadable };
    const due = { boot: counts(boot), day: counts(unreadable ? { ran: 0, failed: 0, missed: 0, late: 0, retried: 0 } : dayCounts(all, now)) };
    if (unreadable)
        return { ...base, nextDueAt: null, oldestUnconfirmed: null, lastConfirmed: null, due, slowStops: whole(slowStops, MAX_COUNT) };
    const upcoming = next.filter((one) => !one.paused).map((one) => one.at);
    let oldest = null, last = null;
    for (const { at } of next)
        if (at <= now && (!oldest || at < oldest.dueAt))
            oldest = { dueAt: whole(at, MAX_TIME), state: "due", since: whole(at, MAX_TIME) };
    for (const record of all) {
        if (record.void)
            continue;
        if (record.state === "queued") {
            if (record.dueAt <= now && (!oldest || record.dueAt < oldest.dueAt))
                oldest = { dueAt: whole(record.dueAt, MAX_TIME), state: "queued", since: whole(record.madeAt, MAX_TIME) };
        }
        else if (!last || occurrenceLastAt(record) > occurrenceLastAt(last))
            last = record;
    }
    const state = last?.state;
    return {
        ...base,
        nextDueAt: upcoming.length ? whole(Math.min(...upcoming), MAX_TIME) : null,
        oldestUnconfirmed: oldest,
        lastConfirmed: last && state ? {
            dueAt: whole(occurrenceLastAt(last), MAX_TIME),
            startedAt: state === "missed" || state === "skipped" ? null : whole(last.startedAt ?? last.endedAt ?? last.madeAt, MAX_TIME),
            state,
        } : null,
        due, slowStops: whole(slowStops, MAX_COUNT),
    };
}
