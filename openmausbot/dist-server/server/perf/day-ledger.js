// The last day of turn timings by hour: one histogram per phase and per tool kind, and counts. Bounded at 25 hours of
// fixed-size slots whatever the traffic.
import { addTo, countOf, emptyHistogram, histogramQuantile, mergeInto, parseHistogram, PHASES } from "./phases.js";
import { activeMs, counter, isLimitScope, isRetryCode, isToolKind, KIND } from "./turn-record.js";
const HOUR = 3_600_000;
export const DAY_HOURS = 24;
/** A turn counts as slow past each of these (ms) of its time less any wait on a person. */
export const SLOW_TURN_MS = [60_000, 300_000, 900_000];
const REASONS_KEPT = 12, LIMIT_KEYS_KEPT = 12;
const emptySlot = (hour) => ({ hour, turns: 0, failed: 0, slow: SLOW_TURN_MS.map(() => 0), phases: {}, tools: {},
    retries: { turns: 0, n: 0, backoffMs: 0, why: counter() }, limits: counter(), failovers: 0 });
const bump = (map, key, cap, by = 1) => {
    if (!Object.hasOwn(map, key) && Object.keys(map).length >= cap)
        key = "other";
    map[key] = (map[key] ?? 0) + by;
};
const statsOf = (histogram) => ({ p50: histogramQuantile(histogram, 0.5), p95: histogramQuantile(histogram, 0.95), max: histogram.max, n: countOf(histogram) });
export function createDayLedger(now) {
    const slots = new Map();
    const slot = (at) => {
        const hour = Math.floor(at / HOUR);
        let found = slots.get(hour);
        if (!found) {
            found = emptySlot(hour);
            slots.set(hour, found);
            for (const key of slots.keys())
                if (key <= hour - DAY_HOURS)
                    slots.delete(key);
        }
        return found;
    };
    return {
        noteTool(kind, ms, ok, open, at = now()) {
            const tools = slot(at).tools;
            const entry = tools[kind] ??= { hist: emptyHistogram(), errors: 0, open: 0 };
            addTo(entry.hist, ms);
            if (!ok)
                entry.errors += 1;
            if (open)
                entry.open += 1;
        },
        noteTurn(turn) {
            const into = slot(turn.endedAt);
            into.turns += 1;
            if (!turn.ok)
                into.failed += 1;
            for (const phase of PHASES) {
                const ms = turn.ms[phase];
                if (ms !== undefined)
                    addTo(into.phases[phase] ??= emptyHistogram(), ms);
            }
            const active = activeMs(turn);
            SLOW_TURN_MS.forEach((edge, index) => { if (active > edge)
                into.slow[index] += 1; });
            if (turn.retries) {
                into.retries.turns += 1;
                into.retries.n += turn.retries;
                into.retries.backoffMs += turn.backoffMs;
                for (const why of turn.retryWhy ?? [])
                    bump(into.retries.why, why, REASONS_KEPT);
            }
            if (turn.limit)
                bump(into.limits, `${turn.engine ?? "unknown"}:${turn.limit}`, LIMIT_KEYS_KEPT);
            if (turn.failover)
                into.failovers += 1;
        },
        /** A usage limit refused a turn before it started: no turn to time, but the refusal counts. */
        noteRefusal(engine, scope, at = now()) {
            bump(slot(at).limits, `${engine ?? "unknown"}:${scope}`, LIMIT_KEYS_KEPT);
        },
        read(windowMs = DAY_HOURS * HOUR) {
            const from = Math.floor((now() - windowMs) / HOUR);
            const phases = {};
            const tools = {};
            const out = { turns: 0, failed: 0, phases: {}, slow: SLOW_TURN_MS.map(() => 0), tools: [],
                retries: { turns: 0, n: 0, backoffMs: 0, why: counter() }, limits: counter(), failovers: 0 };
            for (const entry of slots.values()) {
                if (entry.hour <= from)
                    continue;
                out.turns += entry.turns;
                out.failed += entry.failed;
                out.failovers += entry.failovers;
                entry.slow.forEach((count, index) => { out.slow[index] += count; });
                for (const [phase, histogram] of Object.entries(entry.phases))
                    mergeInto(phases[phase] ??= emptyHistogram(), histogram);
                for (const [kind, tool] of Object.entries(entry.tools)) {
                    const into = tools[kind] ??= { hist: emptyHistogram(), errors: 0, open: 0 };
                    mergeInto(into.hist, tool.hist);
                    into.errors += tool.errors;
                    into.open += tool.open;
                }
                out.retries.turns += entry.retries.turns;
                out.retries.n += entry.retries.n;
                out.retries.backoffMs += entry.retries.backoffMs;
                for (const [why, count] of Object.entries(entry.retries.why))
                    bump(out.retries.why, why, REASONS_KEPT, count);
                for (const [key, count] of Object.entries(entry.limits))
                    bump(out.limits, key, LIMIT_KEYS_KEPT, count);
            }
            for (const phase of PHASES)
                if (phases[phase])
                    out.phases[phase] = statsOf(phases[phase]);
            out.tools = Object.entries(tools)
                .map(([kind, tool]) => ({ kind, n: countOf(tool.hist), errors: tool.errors, open: tool.open, ms: tool.hist.sum, p95: histogramQuantile(tool.hist, 0.95), max: tool.hist.max }))
                .sort((left, right) => right.ms - left.ms);
            return out;
        },
        save: () => [...slots.values()],
        load(saved) {
            if (!Array.isArray(saved))
                return;
            const oldest = Math.floor(now() / HOUR) - DAY_HOURS;
            for (const raw of saved.slice(-DAY_HOURS - 1)) {
                const parsed = parseSlot(raw);
                if (parsed && parsed.hour > oldest)
                    slots.set(parsed.hour, parsed);
            }
        },
    };
}
const whole = (value) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);
const codes = (value, accept, cap) => {
    const out = counter();
    for (const [key, count] of Object.entries((value && typeof value === "object" ? value : {})).slice(0, cap)) {
        if (accept(key))
            out[key] = whole(count);
    }
    return out;
};
const limitKey = (key) => key === "other" || (isLimitScope(key.slice(key.lastIndexOf(":") + 1)) && KIND.test(key.slice(0, key.lastIndexOf(":"))));
const reasonKey = (key) => isRetryCode(key);
function parseSlot(raw) {
    if (!raw || typeof raw !== "object" || !Number.isSafeInteger(raw.hour))
        return null;
    const slot = emptySlot(raw.hour);
    slot.turns = whole(raw.turns);
    slot.failed = whole(raw.failed);
    slot.failovers = whole(raw.failovers);
    if (Array.isArray(raw.slow))
        slot.slow = SLOW_TURN_MS.map((_, index) => whole(raw.slow[index]));
    for (const phase of PHASES) {
        const value = raw.phases?.[phase];
        if (value)
            slot.phases[phase] = parseHistogram(value);
    }
    for (const [kind, value] of Object.entries((raw.tools ?? {}))) {
        if (isToolKind(kind) && value)
            slot.tools[kind] = { hist: parseHistogram(value.hist), errors: whole(value.errors), open: whole(value.open) };
    }
    const retries = (raw.retries ?? {});
    slot.retries = { turns: whole(retries.turns), n: whole(retries.n), backoffMs: whole(retries.backoffMs), why: codes(retries.why, reasonKey, REASONS_KEPT) };
    slot.limits = codes(raw.limits, limitKey, LIMIT_KEYS_KEPT);
    return slot;
}
