// A routine's checks: plain code that reads Calendar and Gmail and other routines' runs on each tick, with no AI. What
// needs no judgement goes to the brief straight away; what needs judgement goes to one run, and the cursors move only
// once that run's answer is kept. State is ids and times only, one entry per routine, in routine-checks.json.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.js";
import { SourceError } from "../connected-reads.js";
import { clashes, emailSince, fingerprint, keepNewest, LOOKAHEAD_MS, mergeMeetings, nextMeetingDue, planMail, planMeetings, pruneMeetings, } from "./check-plan.js";
import { checkedPrompt, watchPrompt } from "./check-prompts.js";
const MINUTE = 60_000;
const CHECK_MS = 15 * MINUTE;
const MAX_JUDGED = 1_000;
const MAIL_READ_LIMIT = 100;
/** A run that took items and was never heard of again gives them back after this long. */
const PENDING_MS = 3 * 60 * MINUTE;
/** A read that keeps failing is tried again after 15 minutes doubled each time, at most 2 hours. */
const READ_RETRY_MS = 15 * MINUTE;
const READ_RETRY_MAX_MS = 2 * 60 * MINUTE;
export const CHECKS_FILE = "routine-checks.json";
const at = z.number().finite().nonnegative();
const id = z.string().min(1).max(512);
const pendingSchema = z.object({
    at,
    mailCursor: at.optional(), mail: z.array(id).max(200), prep: z.array(id).max(50), runsCursor: at.optional(),
    /** The threads a draft may answer, each to its own sender: the run's emails, nothing else. */
    replies: z.array(z.object({ threadId: id, to: z.string().max(320) })).max(200),
    drafted: z.array(id).max(200).optional(),
});
const failureSchema = z.object({ since: at, count: z.number().int().min(1), signedOut: z.boolean().optional(), lastAt: at });
const routineStateSchema = z.object({
    mailCursor: at.optional(),
    judged: z.array(id).max(MAX_JUDGED).optional(),
    meetings: z.record(id, z.object({ start: at, fingerprint: z.string().max(64), prepStartedAt: at.optional(), preppedAt: at.optional(), remindedAt: at.optional() })).optional(),
    runsCursor: at.optional(),
    address: z.string().max(320).optional(),
    pending: z.record(id, pendingSchema).optional(),
    failures: z.object({ gmail: failureSchema.optional(), googlecalendar: failureSchema.optional() }).optional(),
});
const fileSchema = z.object({ version: z.literal(1), routines: z.record(id, routineStateSchema) });
const ACTIVE = new Set(["queued", "running", "waiting"]);
const appName = { gmail: "Gmail", googlecalendar: "Google Calendar" };
const addressOf = (from) => (/<([^<>\s]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
export function troubleSentence(trouble) {
    if (!trouble.length)
        return undefined;
    const names = trouble.map((one) => appName[one.app]).join(" or ");
    if (trouble.some((one) => one.signedOut))
        return `Couldn't read ${names}. Reconnect it in Connected apps.`;
    if (trouble.some((one) => one.severalAccounts))
        return `Couldn't read ${names}. Several accounts are connected, so I read the newest one; check or reconnect it in Connected apps.`;
    return `Couldn't read ${names}. I'll try again soon.`;
}
export function createRoutineChecks(deps) {
    const file = join(deps.dataDir, CHECKS_FILE);
    const now = deps.now ?? Date.now;
    let state = { version: 1, routines: {} };
    try {
        const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
        if (parsed.success)
            state = parsed.data;
        else
            console.warn(`checks: ${file} is not a checks file; starting fresh`);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            console.warn(`checks: ${file} is unreadable; starting fresh`);
    }
    /** The headers and events a pending run was handed, while this process holds them: the state keeps only their ids. */
    const handed = new Map();
    const save = () => {
        try {
            writeFileAtomic(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
        }
        catch (error) {
            console.warn(`checks: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    const of = (routineId) => (state.routines[routineId] ??= {});
    const ownerOf = (key) => {
        for (const [routineId, entry] of Object.entries(state.routines)) {
            const pending = entry.pending?.[key];
            if (pending)
                return [routineId, pending];
        }
        return null;
    };
    function release(key) {
        const owner = ownerOf(key);
        handed.delete(key);
        if (!owner)
            return;
        const entry = of(owner[0]);
        for (const meeting of owner[1].prep)
            if (entry.meetings?.[meeting])
                delete entry.meetings[meeting].prepStartedAt;
        delete entry.pending[key];
        save();
    }
    function commit(key) {
        const owner = ownerOf(key);
        handed.delete(key);
        if (!owner)
            return;
        const [routineId, pending] = owner;
        const entry = of(routineId);
        if (pending.replies.length)
            deps.sorted?.(routineId, pending.replies.length);
        if (pending.mailCursor !== undefined)
            entry.mailCursor = Math.max(entry.mailCursor ?? 0, pending.mailCursor);
        if (pending.runsCursor !== undefined)
            entry.runsCursor = Math.max(entry.runsCursor ?? 0, pending.runsCursor);
        entry.judged = keepNewest([...new Set([...(entry.judged ?? []), ...pending.mail])], MAX_JUDGED);
        for (const meeting of pending.prep) {
            const record = entry.meetings?.[meeting];
            if (!record)
                continue;
            delete record.prepStartedAt;
            record.preppedAt = now();
        }
        delete entry.pending[key];
        save();
    }
    /** A read that failed counts toward its app's failure streak, so the brief says so once and reads back off. */
    function failed(entry, app, error) {
        const signedOut = error instanceof SourceError && error.signedOut;
        const severalAccounts = error instanceof SourceError && error.severalAccounts;
        const previous = entry.failures?.[app];
        entry.failures = { ...entry.failures, [app]: { since: previous?.since ?? now(), count: (previous?.count ?? 0) + 1, lastAt: now(), ...(signedOut ? { signedOut } : {}) } };
        console.warn(`checks: could not read ${appName[app]}: ${error instanceof Error ? error.message : String(error)}`);
        return { app, signedOut, ...(severalAccounts ? { severalAccounts } : {}) };
    }
    const readsBackOff = (entry, app) => {
        const failure = entry.failures?.[app];
        return failure !== undefined && now() < failure.lastAt + Math.min(READ_RETRY_MAX_MS, READ_RETRY_MS * 2 ** (failure.count - 1));
    };
    const succeeded = (entry, app) => {
        if (entry.failures?.[app])
            delete entry.failures[app];
    };
    async function check(routine, context) {
        const checks = routine.checks ?? [];
        const entry = of(routine.id);
        const at = now();
        for (const [key, pending] of Object.entries(entry.pending ?? {})) {
            const run = deps.runs().find((candidate) => candidate.checkKey === key);
            if ((run && !ACTIVE.has(run.status)) || (!run && at - pending.at > PENDING_MS))
                release(key);
        }
        // The first check fixes where mail is watched from, so mail a failed read or run gave back is read again.
        if (checks.includes("mail"))
            entry.mailCursor ??= emailSince({ now: at });
        const brief = routine.deliver === "brief";
        const aiAllowed = !context.hold && (routine.access !== "read-and-draft" || deps.fenced(routine.botId));
        const report = { routine, at };
        const trouble = [];
        const items = { mail: [], prep: [], runs: [] };
        const pending = { mail: [], prep: [], replies: [] };
        const held = new Set(Object.values(entry.pending ?? {}).flatMap((one) => [...one.mail, ...one.prep]));
        let wakeAt;
        const apps = checks.includes("calendar") || checks.includes("mail") ? await deps.reads.connected().catch(() => null) : null;
        const session = deps.reads.session();
        report.session = session;
        const readable = (app) => apps?.[app] === true && deps.mayRead(routine.botId, app) && !trouble.some((one) => one.app === app) &&
            (context.manual || !readsBackOff(entry, app));
        if (readable("gmail") && entry.address === undefined) {
            try {
                entry.address = await session.address();
            }
            catch (error) {
                trouble.push(failed(entry, "gmail", error));
            }
        }
        if (checks.includes("calendar") && readable("googlecalendar")) {
            try {
                const meetings = mergeMeetings(await session.events(at - 60 * MINUTE, at + LOOKAHEAD_MS), entry.address);
                succeeded(entry, "googlecalendar");
                entry.meetings = pruneMeetings(entry.meetings ?? {}, at);
                const records = entry.meetings;
                const jobs = planMeetings({ now: at, events: meetings, meetings: records, checkMs: CHECK_MS });
                const record = (event) => (records[event.id] ??= { start: event.start, fingerprint: "" });
                for (const job of jobs) {
                    const kept = record(job.event);
                    if (kept.start !== job.event.start)
                        Object.assign(kept, { start: job.event.start, preppedAt: undefined, remindedAt: undefined });
                }
                if (brief) {
                    report.meetings = meetings;
                    report.clashes = clashes(meetings, { now: at, timeZone: deps.timeZone() });
                    report.remind = jobs.filter((job) => job.kind === "remind").map((job) => job.event);
                    for (const event of report.remind)
                        record(event).remindedAt = at;
                }
                for (const job of jobs) {
                    if (job.kind !== "prep" || held.has(job.event.id))
                        continue;
                    if (!aiAllowed) {
                        if (!context.hold)
                            report.unfenced = true;
                        continue;
                    }
                    items.prep.push({ key: job.event.id, event: job.event, short: job.short });
                    Object.assign(record(job.event), { prepStartedAt: at, fingerprint: fingerprint(job.event), start: job.event.start });
                    pending.prep.push(job.event.id);
                }
                wakeAt = nextMeetingDue({ now: at, events: meetings, meetings: records });
            }
            catch (error) {
                trouble.push(failed(entry, "googlecalendar", error));
            }
        }
        if (checks.includes("mail") && readable("gmail")) {
            try {
                const since = emailSince({ now: at, emailCursor: entry.mailCursor });
                const { emails, more } = await session.emails(since, MAIL_READ_LIMIT);
                succeeded(entry, "gmail");
                const judged = new Set([...(entry.judged ?? []), ...held]);
                const plan = planMail({ now: at, emails, judged });
                const waiting = plan.waiting.length;
                const advanced = waiting || more ? undefined : at;
                const helpers = brief && deps.inbox?.ready() === true;
                if (helpers)
                    report.helpersSort = true;
                const picked = helpers && plan.batch.length ? await deps.inbox.triage(plan.batch, deps.dismissedFrom()) : null;
                if (picked) {
                    // Sorted with no AI turn: every email of the batch is judged, and the picks become brief rows.
                    report.picked = picked.flatMap((pick) => {
                        const email = plan.batch.find((one) => one.id === pick.id);
                        return email ? [{ email, why: pick.why, ...(pick.whyText ? { whyText: pick.whyText } : {}), needsReply: pick.needsReply }] : [];
                    });
                    entry.judged = keepNewest([...new Set([...(entry.judged ?? []), ...plan.batch.map((email) => email.id), ...plan.quiet.map((email) => email.id)])], MAX_JUDGED);
                    if (plan.batch.length)
                        deps.sorted?.(routine.id, plan.batch.length);
                    // Mail an earlier run still holds keeps the cursor back, so a failed run's mail is read again.
                    const heldMail = Object.values(entry.pending ?? {}).some((one) => one.mail.length > 0);
                    if (advanced !== undefined && !heldMail)
                        entry.mailCursor = advanced;
                }
                else if (helpers && plan.batch.length && !aiAllowed) {
                    // The helper models did not answer this time and no fenced AI may sort: the mail waits for the next check.
                }
                else if (plan.batch.length && aiAllowed) {
                    items.mail = plan.batch;
                    pending.mail = [...plan.batch.map((email) => email.id), ...plan.quiet.map((email) => email.id)];
                    pending.replies = plan.batch.map((email) => ({ threadId: email.threadId, to: addressOf(email.from) }));
                    if (advanced !== undefined)
                        pending.mailCursor = advanced;
                }
                else {
                    if (plan.batch.length && !context.hold)
                        report.unfenced = true;
                    const sorted = plan.batch.length && context.hold ? [] : [...plan.batch, ...plan.quiet];
                    entry.judged = keepNewest([...new Set([...(entry.judged ?? []), ...sorted.map((email) => email.id)])], MAX_JUDGED);
                    if (advanced !== undefined && !(plan.batch.length && context.hold))
                        entry.mailCursor = advanced;
                }
                if (brief && (waiting || more))
                    report.waiting = more ? true : waiting;
            }
            catch (error) {
                trouble.push(failed(entry, "gmail", error));
            }
        }
        if (checks.includes("runs")) {
            const since = entry.runsCursor ?? routine.createdAt;
            const finished = deps.runs().filter((run) => run.routineId !== routine.id && run.finishedAt !== undefined && run.finishedAt > since && ["completed", "failed", "missed"].includes(run.status));
            if (brief) {
                report.runs = finished;
                entry.runsCursor = at;
            }
            else if (finished.length && aiAllowed) {
                items.runs = finished;
                pending.runsCursor = at;
            }
            else if (!finished.length)
                entry.runsCursor = at;
        }
        if (apps)
            report.gmail = { connected: apps.gmail === true, ...(entry.address ? { address: entry.address } : {}) };
        if (trouble.length)
            report.trouble = trouble;
        let run;
        const work = brief ? items.mail.length + items.prep.length : items.mail.length + items.prep.length + items.runs.length;
        if (work > 0) {
            const key = `chk-${randomUUID()}`;
            entry.pending = { ...entry.pending, [key]: { at, ...pending } };
            handed.set(key, { mail: items.mail, prep: items.prep.map(({ key: meeting, event }) => ({ key: meeting, event })) });
            run = {
                key,
                prompt: brief
                    ? watchPrompt({ instructions: routine.prompt, items, timeZone: deps.timeZone(), dismissedFrom: deps.dismissedFrom() })
                    : checkedPrompt({ instructions: routine.prompt, items, timeZone: deps.timeZone() }),
            };
        }
        save();
        if (brief)
            await deps.report(report);
        const sentence = troubleSentence(trouble);
        return { ...(run ? { run } : {}), ...(sentence ? { trouble: sentence } : {}), ...(wakeAt !== undefined ? { wakeAt } : {}) };
    }
    function settled(run) {
        const key = run.checkKey;
        if (!key || !ownerOf(key))
            return;
        if (run.status !== "completed")
            release(key);
        else if (run.deliver !== "brief")
            commit(key);
    }
    return {
        check, release, settled, commit,
        mayDraft(key, threadId, to) {
            const pending = ownerOf(key)?.[1];
            const target = pending?.replies.find((reply) => reply.threadId === threadId);
            return Boolean(target && !pending.drafted?.includes(threadId) && (to === undefined || to.trim().toLowerCase() === target.to));
        },
        drafted(key, threadId) {
            const pending = ownerOf(key)?.[1];
            if (!pending)
                return;
            pending.drafted = [...new Set([...(pending.drafted ?? []), threadId])];
            save();
        },
        items: (key) => handed.get(key) ?? null,
        address: () => Object.values(state.routines).find((entry) => entry.address)?.address,
        pendingKeys: () => Object.values(state.routines).flatMap((entry) => Object.keys(entry.pending ?? {})),
        forget(routineId) {
            if (!state.routines[routineId])
                return;
            delete state.routines[routineId];
            save();
        },
    };
}
