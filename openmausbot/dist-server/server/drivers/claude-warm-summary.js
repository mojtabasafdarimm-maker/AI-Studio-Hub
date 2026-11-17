import { runForkedPrompt, runKeepWarmPing } from "./claude-keepwarm.js";
import { USAGE_LIMIT } from "./retry.js";
/** Writing the summary is most of it: thousands of output tokens, 35 to 60 s on Opus for a 160k conversation. */
export const WARM_SUMMARY_TIMEOUT_MS = 5 * 60_000;
/** A closed process's launch contract is kept this long for a summary after it: the cache it would read lives an hour. */
export const PARKED_FORK_MS = 60 * 60_000;
const PARKED_MAX = 200;
const INSTRUCTIONS_MAX = 1_500;
/** `/compact` takes its custom instructions as the rest of the line. */
export function warmSummaryPrompt(instructions) {
    const line = instructions.replace(/\s+/g, " ").trim().slice(0, INSTRUCTIONS_MAX);
    return line ? `/compact ${line}` : "/compact";
}
const count = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
export function parseWarmSummaryResult(stdout, stderr, code, sessionBefore) {
    let frame = null;
    try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            frame = parsed;
    }
    catch {
        // Not JSON: the CLI failed before answering (an unknown flag, a session it cannot resume).
    }
    if (!frame || frame.type !== "result") {
        const said = (stderr.trim() || stdout.trim()).split("\n").pop()?.slice(0, 300) ?? "";
        return { ok: false, reason: said ? `the summary failed: ${said}` : `the summary exited ${code ?? "without a code"}` };
    }
    const text = typeof frame.result === "string" ? frame.result : "";
    if (frame.is_error === true) {
        const limit = frame.api_error === "usage_limit_reached" || USAGE_LIMIT.test(text);
        return { ok: false, reason: limit ? "the account's usage limit refused the summary" : `the summary failed: ${text.slice(0, 300) || "API error"}`, ...(limit ? { limit: true } : {}) };
    }
    const session = typeof frame.session_id === "string" && frame.session_id.trim() ? frame.session_id : null;
    if (!session)
        return { ok: false, reason: "the summary did not say which session it wrote" };
    const usage = (frame.usage ?? {});
    const models = frame.modelUsage && typeof frame.modelUsage === "object" && !Array.isArray(frame.modelUsage) ? Object.keys(frame.modelUsage) : [];
    return {
        ok: true,
        session,
        sessionBefore,
        input: count(usage.input_tokens),
        cacheRead: count(usage.cache_read_input_tokens),
        cacheWrite: count(usage.cache_creation_input_tokens),
        output: count(usage.output_tokens),
        costUsd: typeof frame.total_cost_usd === "number" && Number.isFinite(frame.total_cost_usd) ? frame.total_cost_usd : null,
        model: models[0] ?? null,
        ...(typeof frame.total_cost_usd === "number" ? { costTotal: frame.total_cost_usd } : {}),
        ...(frame.modelUsage !== undefined ? { modelUsage: frame.modelUsage } : {}),
    };
}
export function runWarmSummary(opts) {
    return runForkedPrompt({
        cli: opts.cli, contract: opts.contract, sessionId: opts.sessionId, what: "summary", prompt: warmSummaryPrompt(opts.instructions),
        persist: true, timeoutMs: opts.timeoutMs ?? WARM_SUMMARY_TIMEOUT_MS, signal: opts.signal,
        parse: (stdout, stderr, code) => parseWarmSummaryResult(stdout, stderr, code, opts.sessionId),
        failed: (reason) => ({ ok: false, reason }),
    });
}
/** The driver's `cacheKeepWarm` adapter (ping, hold, compact) over its own sessions, and the bookkeeping for a closed one. */
export function claudeForks(deps) {
    const now = deps.now ?? Date.now;
    /** An idle-closed process's contract and session: a summary can still fork it while its cache is warm. */
    const parked = new Map();
    const forkOf = (threadId, live) => {
        const contract = deps.contracts.get(threadId);
        if (live && contract && live.sessionId)
            return { contract, sessionId: live.sessionId };
        const kept = parked.get(threadId);
        if (!kept)
            return null;
        if (now() - kept.at < PARKED_FORK_MS)
            return kept;
        parked.delete(threadId);
        return null;
    };
    return {
        /** A process closed: an idle close parks its contract for a summary, any other forgets it. */
        closed(threadId, why, sessionId) {
            const contract = deps.contracts.get(threadId);
            deps.contracts.delete(threadId);
            deps.holds.delete(threadId);
            parked.delete(threadId);
            if (why !== "idle" || !contract || !sessionId)
                return;
            parked.set(threadId, { contract, sessionId, at: now() });
            if (parked.size > PARKED_MAX)
                parked.delete(parked.keys().next().value);
        },
        adapter: {
            ping: async (threadId, options) => {
                const live = deps.live(threadId);
                const contract = deps.contracts.get(threadId);
                if (!live || !contract || !live.sessionId)
                    return { ok: false, reason: "the conversation's Claude session has closed" };
                if (live.busy)
                    return { ok: false, reason: "a turn is running", busy: true };
                if (!deps.supports("--fork-session") || !deps.supports("--no-session-persistence")) {
                    return { ok: false, reason: "this Claude Code is too old to fork a session; update Claude Code" };
                }
                return runKeepWarmPing({ cli: deps.cli, contract, sessionId: live.sessionId, signal: options?.signal });
            },
            hold: (threadId, until) => {
                if (until === null)
                    deps.holds.delete(threadId);
                else
                    deps.holds.set(threadId, until);
                const live = deps.live(threadId);
                if (!live)
                    return false;
                if (!live.turn)
                    deps.armIdle(threadId);
                return true;
            },
            compact: async (threadId, options) => {
                const live = deps.live(threadId);
                if (live?.busy)
                    return { ok: false, reason: "a turn is running", busy: true };
                const fork = forkOf(threadId, live);
                if (!fork)
                    return { ok: false, reason: "the conversation's Claude session has closed" };
                if (options.session !== undefined && fork.sessionId !== options.session)
                    return { ok: false, reason: "the conversation moved to another session" };
                if (!deps.supports("--fork-session"))
                    return { ok: false, reason: "this Claude Code is too old to fork a session; update Claude Code" };
                const run = await (deps.runSummary ?? runWarmSummary)({ cli: deps.cli, contract: fork.contract, sessionId: fork.sessionId, instructions: options.instructions, signal: options.signal });
                if (!run.ok)
                    return run;
                // A turn that began meanwhile ran on the old session: the fork no longer holds the whole conversation.
                if (options.signal?.aborted || deps.live(threadId)?.busy)
                    return { ok: false, reason: "a turn started while summarizing", busy: true };
                // A CLI that summarized the session in place (same id) is handled the same way: the old process holds the
                // unsummarized conversation in memory either way, and the next turn reopens the session from disk.
                parked.delete(threadId);
                deps.summarized(threadId, run);
                const { costTotal: _total, modelUsage: _usage, ...result } = run;
                return result;
            },
        },
    };
}
