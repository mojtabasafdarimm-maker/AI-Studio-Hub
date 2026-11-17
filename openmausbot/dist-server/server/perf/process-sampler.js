// Who used the CPU here lately, by process bucket, and how responsive the server's event loop was. One sample
// a minute on Linux from /proc (a few hundred small file reads), one every five minutes elsewhere from a single `ps`; no
// other process, no network. The event loop is read from the sampler's own timer (how late it fired) and Node's
// utilization counter, never a fast timer of its own. Memory: the last sample's rows and an hour of per-bucket totals.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { exactQuantile } from "./phases.js";
import { classifyProcesses, parseCgroupCpuMs, parseProcStat, parsePsLine, parseReapedChildrenMs, } from "./process-buckets.js";
export const LINUX_SAMPLE_MS = 60_000;
export const OTHER_SAMPLE_MS = 5 * 60_000;
const HOUR = 3_600_000, FIVE_MINUTES = 5 * 60_000;
const BUCKETS_SHOWN = 12;
const readText = (path) => { try {
    return readFileSync(path, "utf8");
}
catch {
    return null;
} };
/** A sample reads at most this many processes: a container holds a few thousand at its limit, a shared host may show more. */
export const MAX_SAMPLED_PROCESSES = 8_192;
/** Every process /proc shows, up to MAX_SAMPLED_PROCESSES, read synchronously: one stat file each. */
export function linuxProcessList(read = readText, list = () => readdirSync("/proc")) {
    const rows = [];
    let names = [];
    try {
        names = list();
    }
    catch { }
    for (const name of names) {
        if (rows.length >= MAX_SAMPLED_PROCESSES)
            break;
        if (!/^\d+$/.test(name))
            continue;
        const text = read(`/proc/${name}/stat`);
        const row = text === null ? null : parseProcStat(Number(name), text);
        if (row)
            rows.push(row);
    }
    const self = read("/proc/self/stat");
    return { rows, reapedMs: self === null ? null : parseReapedChildrenMs(self), totalMs: parseCgroupCpuMs(read("/sys/fs/cgroup/cpu.stat"), read("/sys/fs/cgroup/cpuacct/cpuacct.usage")) };
}
/** One `ps` over every process: the fallback where there is no /proc (macOS). */
export function psProcessList() {
    return new Promise((resolve) => {
        execFile("ps", ["-axo", "pid=,ppid=,rss=,time=,comm="], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
            if (error)
                return resolve(null);
            const rows = stdout.split("\n").flatMap((line) => { const row = parsePsLine(line); return row ? [row] : []; });
            resolve({ rows, reapedMs: null, totalMs: null });
        });
    });
}
export function nodeUtilization() {
    let previous = performance.eventLoopUtilization();
    return () => {
        const current = performance.eventLoopUtilization();
        const delta = performance.eventLoopUtilization(current, previous);
        previous = current;
        return Number.isFinite(delta.utilization) ? delta.utilization : null;
    };
}
export function createProcessSampler(options) {
    const now = options.now ?? Date.now, monotonic = options.monotonic ?? (() => performance.now());
    const serverPid = options.serverPid ?? process.pid;
    const samples = [];
    let previous = null;
    let latest = null;
    let timer = null, due = 0, running = false;
    const take = (list, driftMs) => {
        const at = monotonic();
        const buckets = classifyProcesses(list.rows, serverPid, options.scope === "tree", options.engines?.());
        try {
            options.seen?.(list.rows, buckets);
        }
        catch { }
        const cpu = {}, procs = {}, rss = {};
        const rows = new Map();
        let browsers = 0;
        const browserPids = new Set(list.rows.filter((row) => buckets.get(row.pid) === "browser").map((row) => row.pid));
        for (const row of list.rows) {
            const bucket = buckets.get(row.pid);
            if (!bucket)
                continue;
            procs[bucket] = (procs[bucket] ?? 0) + 1;
            rss[bucket] = (rss[bucket] ?? 0) + row.rssBytes;
            if (bucket === "browser" && !browserPids.has(row.ppid))
                browsers += 1;
            const before = previous?.rows.get(row.pid);
            const used = before && before.start === row.start && row.cpuMs >= before.cpuMs ? row.cpuMs - before.cpuMs : previous ? row.cpuMs : 0;
            cpu[bucket] = (cpu[bucket] ?? 0) + used;
            rows.set(row.pid, { start: row.start, cpuMs: row.cpuMs, bucket, ppid: row.ppid });
        }
        if (previous && list.reapedMs !== null && previous.reapedMs !== null) {
            let reaped = list.reapedMs - previous.reapedMs;
            for (const [pid, before] of previous.rows)
                if (before.ppid === serverPid && !rows.has(pid))
                    reaped -= before.cpuMs;
            if (reaped > 0)
                cpu.commands = (cpu.commands ?? 0) + reaped;
        }
        if (previous) {
            const total = list.totalMs !== null && previous.totalMs !== null ? Math.max(0, list.totalMs - previous.totalMs) : null;
            samples.push({ at: now(), windowMs: Math.max(1, at - previous.at), cpu, total, driftMs, elu: options.utilization?.() ?? null });
            while (samples.length && samples[0].at <= now() - HOUR)
                samples.shift();
        }
        else
            options.utilization?.();
        previous = { at, rows, reapedMs: list.reapedMs, totalMs: list.totalMs };
        latest = { at: now(), procs, rss, browsers };
    };
    const tick = async () => {
        const driftMs = Math.max(0, monotonic() - due);
        if (driftMs >= 2_000)
            options.stalled?.(Math.round(driftMs));
        await sampleNow(driftMs);
        try {
            options.afterSample?.();
        }
        catch { }
        schedule();
    };
    const schedule = () => {
        due = monotonic() + options.intervalMs;
        timer = setTimeout(() => void tick(), options.intervalMs);
        timer.unref?.();
    };
    const sampleNow = async (driftMs = 0) => {
        if (running)
            return;
        running = true;
        try {
            const list = await options.list();
            if (list)
                take(list, driftMs);
        }
        catch { }
        finally {
            running = false;
        }
    };
    return {
        start() { if (!timer) {
            void sampleNow();
            schedule();
        } },
        stop() { if (timer)
            clearTimeout(timer); timer = null; },
        sampleNow,
        report() {
            const at = now();
            const since = (ms) => samples.filter((sample) => sample.at > at - ms);
            const hour = since(HOUR), five = since(FIVE_MINUTES);
            const sum = (list, bucket) => list.reduce((total, sample) => total + (sample.cpu[bucket] ?? 0), 0);
            const names = new Set([...Object.keys(latest?.procs ?? {}), ...hour.flatMap((sample) => Object.keys(sample.cpu))]);
            const buckets = [...names].map((bucket) => ({
                bucket, procs: latest?.procs[bucket] ?? 0, cpu5mS: round1(sum(five, bucket) / 1000), cpu60mS: round1(sum(hour, bucket) / 1000),
                peakPct: Math.round(Math.max(0, ...hour.map((sample) => ((sample.cpu[bucket] ?? 0) / sample.windowMs) * 100))),
                rssMB: Math.round((latest?.rss[bucket] ?? 0) / 1_048_576),
            })).sort((left, right) => right.cpu60mS - left.cpu60mS || right.rssMB - left.rssMB).slice(0, BUCKETS_SHOWN);
            const totals = hour.filter((sample) => sample.total !== null);
            const seen = (sample) => Object.values(sample.cpu).reduce((total, ms) => total + (ms ?? 0), 0);
            const unseen = totals.length ? totals.reduce((total, sample) => total + Math.max(0, (sample.total ?? 0) - seen(sample)), 0) : null;
            const drifts = hour.map((sample) => sample.driftMs).sort((left, right) => left - right);
            const elus = hour.flatMap((sample) => (sample.elu === null ? [] : [sample.elu]));
            return {
                at: latest?.at ?? null, intervalS: Math.round(options.intervalMs / 1000), scope: options.scope, samples: hour.length, buckets,
                browsers: latest?.browsers ?? 0, unseen60mS: unseen === null ? null : round1(unseen / 1000),
                loop: { eluPct: elus.length ? Math.round(elus.at(-1) * 100) : null, eluMaxPct: elus.length ? Math.round(Math.max(...elus) * 100) : null,
                    driftP95Ms: Math.round(exactQuantile(drifts, 0.95)), driftMaxMs: Math.round(drifts.at(-1) ?? 0) },
            };
        },
    };
}
const round1 = (value) => Math.round(value * 10) / 10;
