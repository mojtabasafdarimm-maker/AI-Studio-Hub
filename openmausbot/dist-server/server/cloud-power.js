// A Cloud home's power: whether it is busy, and the sleep handshake with the Admin (docs/cloud-pro.md, "Sleeping
// homes"). The home never stops itself: on a plan that sleeps, the Admin reads `report()` about once a minute through
// its signed `GET /api/cloud/power`, asks `prepareSleep()` through `POST /api/cloud/power/sleep` once the home is idle,
// then suspends the machine (or stops it) and wakes it again before the next scheduled run. On every other plan the Admin
// never asks, and nothing here changes how the home behaves.
//
// Privacy: the report carries fixed codes and times only, like the health report.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
/** No user activity for this long (the Admin may ask for another window in its sleep request). */
export const CLOUD_IDLE_ACTIVITY_MS = 10 * 60_000;
/** Work finished this long ago, so follow-ups and delegated work get going first. */
export const CLOUD_IDLE_WORK_MS = 2 * 60_000;
/** Awake at least this long, so a wake is never undone before the request that caused it is served. */
export const CLOUD_IDLE_AWAKE_MS = 2 * 60_000;
/** The next run at least this far away: the Admin wakes a home a minute early, so a shorter sleep isn't worth it. */
export const CLOUD_IDLE_DUE_MS = 5 * 60_000;
/** A sleep the Admin asked for but never carried out (the suspend failed, the Admin restarted) ends by itself. */
export const CLOUD_SLEEP_PENDING_MS = 120_000;
/** The clock tick that notices a resume: a jump this much larger than the tick means the machine was suspended. */
const TICK_MS = 5_000, RESUME_JUMP_MS = 15_000;
/** The first request this soon after a wake or a boot is taken for what woke the home (`wokeBy`). */
export const WOKE_BY_MS = 30_000;
/** Each kind of request, as a fixed code, by its path: never more of the request than that. Anything else is a page. */
const WAKE_CODES = [
    [/^\/api\/events$/, "events"], [/^\/api\/sync(\/|$)/, "sync"], [/^\/api\/shared-computers(\/|$)/, "lending"],
    [/^\/\.well-known\/openmausbot\/environment$/, "version"], [/^\/api\/phones(\/|$)/, "phone"], [/^\/api\/presence(\/|$)/, "presence"],
    [/^\/api\/auth\/session$/, "session"], [/^\/(?:api\/)?(?:auth\/)?pair(?:ing)?(?:\/|$)/, "pair"], [/^\/api\/cloud\//, "admin"],
    [/^\/api\/health$/, "health"], [/^\/hooks(\/|$)/, "webhook"], [/^\/mcp-oauth\//, "sign-in"], [/^\/api\//, "api"],
];
/** A request's kind (`wokeBy`): "events" (a page's live stream), "version" (the desktop's version check), "api" and so on. */
export const wakeCode = (path) => WAKE_CODES.find(([pattern]) => pattern.test(path))?.[1] ?? "page";
/** Paths that never count as someone using the home: the event stream, the public probe, Files and lending loops,
 * and the Admin's own power reads. */
const BACKGROUND = [/^\/api\/events$/, /^\/api\/health$/, /^\/api\/sync(\/|$)/, /^\/api\/shared-computers(\/|$)/, /^\/api\/cloud\/power(\/|$)/];
export const CLOUD_POWER_PATH = "/api/cloud/power";
export const CLOUD_POWER_SLEEP_PATH = "/api/cloud/power/sleep";
export const CLOUD_BACKGROUND_HEADER = "x-omb-background";
export const CLOUD_POWER_HEADER = "x-omb-cloud-power";
const MARKER = "cloud-sleep.json";
/** Long-polls and streams that stay open by design: never "in flight" work. */
const HELD = [/^\/api\/events$/, /^\/api\/sync\/changes$/, /^\/api\/shared-computers\/asks$/, /^\/api\/shared-computers\/[\w-]+\/(?:poll|link)$/, /^\/api\/bot-link\/sync$/];
/** The answer a held poll (Files sync, lending) gets once the home agreed to sleep: the desktop pauses until it wakes. */
export function answerAsleep(res, json) {
    res.setHeader(CLOUD_POWER_HEADER, "asleep");
    json(res, 503, { error: "asleep" });
}
/** A request counts as someone using the home unless it is a background path or the client marked it as background. */
export function countsAsActivity(path, headers) {
    if (BACKGROUND.some((pattern) => pattern.test(path)))
        return false;
    const marked = headers[CLOUD_BACKGROUND_HEADER];
    return !(marked === "1" || (Array.isArray(marked) && marked.includes("1")));
}
/**
 * Whether this boot follows a sleep the machine was stopped for (its marker on the volume): then waking is not a startup,
 * and the routines' "run on startup" option does not fire. Reads and removes the marker. Any other boot: false, as before.
 */
export function wokeFromSleep(dataDir) {
    const path = join(dataDir, MARKER);
    try {
        readFileSync(path, "utf8");
    }
    catch {
        return false;
    }
    rmSync(path, { force: true });
    return true;
}
export function createCloudPower(options) {
    const now = options.now ?? Date.now;
    const bootedAt = now();
    let wokeAt = bootedAt, lastActivityAt = null, lastWorkAt = null;
    /** The last wake from sleep; null while this process has only ever booted normally. */
    let sleptUntil = options.bootedFromSleep ? bootedAt : null;
    if (options.bootedFromSleep)
        options.onWoke?.();
    /** The first request since `wokeAt` (`arrived`), and whether one came. */
    let wokeBy = null, wokeSeen = false, bootWake = Boolean(options.bootedFromSleep);
    let sleepingSince = null, inFlight = 0;
    let sleepAbort = new AbortController();
    let lastTick = now();
    const clearMarker = () => { try {
        rmSync(join(options.dataDir, MARKER), { force: true });
    }
    catch { } };
    const endSleep = () => {
        if (sleepingSince === null)
            return;
        sleepingSince = null;
        sleepAbort = new AbortController();
        clearMarker();
    };
    const sleeping = () => {
        if (sleepingSince !== null && now() - sleepingSince >= CLOUD_SLEEP_PENDING_MS)
            endSleep();
        return sleepingSince !== null;
    };
    const working = () => {
        const busy = [];
        const { probes } = options;
        if (probes.turn())
            busy.push("turn");
        if (probes.run())
            busy.push("run");
        if (probes.handoff())
            busy.push("handoff");
        if (probes.liveCall())
            busy.push("live-call");
        if (probes.computer())
            busy.push("computer");
        if (probes.maintenance() || inFlight > 0)
            busy.push("maintenance");
        return busy;
    };
    /** A resume: the clock jumped past the tick (noticed once, by the tick or by a request). */
    const resumed = (at) => {
        if (at - lastTick <= TICK_MS + RESUME_JUMP_MS)
            return;
        lastTick = at;
        wokeAt = at;
        wokeBy = null;
        wokeSeen = false;
        bootWake = false;
        sleptUntil = at;
        endSleep();
        options.onWoke?.();
    };
    /** Samples work (so "finished two minutes ago" needs no hook in every kind of work) and notices a resume. */
    const tick = () => {
        const at = now();
        resumed(at);
        lastTick = at;
        if (working().length)
            lastWorkAt = at;
    };
    const timer = setInterval(tick, TICK_MS);
    timer.unref?.();
    const busyNow = (activityMs) => {
        tick();
        const at = now(), busy = working(), workingNow = busy.length > 0;
        if (lastActivityAt !== null && at - lastActivityAt < activityMs)
            busy.push("recent-activity");
        if (!workingNow && lastWorkAt !== null && at - lastWorkAt < CLOUD_IDLE_WORK_MS)
            busy.push("recent-work");
        if (at - wokeAt < CLOUD_IDLE_AWAKE_MS)
            busy.push("just-woke");
        const due = options.probes.nextDueAt();
        if (due !== null && due - at < CLOUD_IDLE_DUE_MS)
            busy.push("due-soon");
        return busy;
    };
    /** Someone used the home (see `countsAsActivity`): a pending sleep is off. */
    const noteActivity = () => {
        lastActivityAt = now();
        endSleep();
    };
    /** An authenticated request in progress (an upload, a download) keeps the home awake until it ends; held polls and
     * the event stream don't. Returns the release. */
    const begin = (path) => {
        if (HELD.some((pattern) => pattern.test(path)))
            return () => { };
        inFlight += 1;
        let released = false;
        return () => { if (!released) {
            released = true;
            inFlight -= 1;
        } };
    };
    return {
        noteActivity,
        begin,
        /** Any request at all, first thing (the server's own and its webhooks'): the first after a wake or a boot is what woke
         * it (`wokeBy`). Only its kind is kept. A resume is noticed here too, before the clock tick. */
        arrived(path, headers) {
            const at = now();
            resumed(at);
            if (wokeSeen || at - wokeAt > WOKE_BY_MS)
                return;
            wokeSeen = true;
            wokeBy = { by: wakeCode(path), background: !countsAsActivity(path, headers) };
            if (bootWake)
                options.onBootWakeRequest?.(at);
        },
        /** An authenticated request: someone using the home (`countsAsActivity`), and work in progress until it ends. */
        request(path, headers, res) {
            if (countsAsActivity(path, headers))
                noteActivity();
            res.once("close", begin(path));
        },
        report(activityMs = CLOUD_IDLE_ACTIVITY_MS) {
            const busy = busyNow(activityMs);
            return { v: 1, at: now(), bootedAt, wokeAt, idle: busy.length === 0, busy, lastActivityAt, lastWorkAt, nextDueAt: options.probes.nextDueAt(), sleeping: sleeping(), wokeBy };
        },
        /** The Admin is about to suspend or stop this machine: yes only when idle now. From here until a resume, someone's
         * use or CLOUD_SLEEP_PENDING_MS, held polls answer "asleep" and new ones are refused (`sleeping`). */
        prepareSleep(activityMs = CLOUD_IDLE_ACTIVITY_MS) {
            const busy = busyNow(activityMs);
            if (busy.length)
                return { ok: false, busy };
            sleepingSince = now();
            try {
                writeFileAtomic(join(options.dataDir, MARKER), JSON.stringify({ at: sleepingSince }));
            }
            catch (error) {
                options.log?.(`cloud power: could not write the sleep marker: ${error instanceof Error ? error.message : String(error)}`);
            }
            sleepAbort.abort();
            options.broadcast({ kind: "power", state: "sleeping" });
            return { ok: true, nextDueAt: options.probes.nextDueAt() };
        },
        sleeping,
        /** The last wake from sleep (a resume, or a boot from one), kept current by the tick and each request; null otherwise. */
        sleptUntil: () => sleptUntil,
        /** Aborted the moment the home agrees to sleep: held long-polls end with it and answer "asleep". */
        sleepSignal: () => sleepAbort.signal,
        /** Tests: the clock tick, without waiting for the timer. */
        tick,
        close() { clearInterval(timer); },
    };
}
/** The running home's power, for route modules built before it (Files sync); null on any server that is not a Cloud home. */
let registered = null;
export function registerCloudPower(power) { registered = power; }
export const cloudPowerNow = () => registered;
/** A read the client marked as background, on a home that agreed to sleep: it gets `answerAsleep` and nothing more, so a
 * list kept fresh in the background never holds the home awake or finds it half asleep. A person's own request never does. */
export function backgroundWhileAsleep(path, headers) {
    return Boolean(registered?.sleeping()) && !countsAsActivity(path, headers);
}
