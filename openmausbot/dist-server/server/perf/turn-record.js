// One finished bot turn's timings, as the ring keeps them and the reports read them. Privacy invariant: ids that match
// the opaque-id pattern, engine kinds, fixed codes and numbers only. Never a tool's name as the engine wrote it (an ACP
// or Codex tool title can be the command itself), a stop reason's words, a prompt or a path.
import { traceToolLook } from "../../shared/usage-trace.js";
import { PHASES } from "./phases.js";
const TOOL_KINDS = new Set(["search", "web", "browser", "computer", "phone", "files", "terminal", "memory",
    "routine", "page", "widget", "bots", "plan", "image", "data", "app", "mcp", "tool"]);
const QUEUE_WHY = new Set(["plan-limit", "memory", "behind-turn", "dispatch"]);
const LIMIT_SCOPES = new Set(["engine", "model", "credits"]);
/** Stop reasons drivers settle a turn with that may be shown as they are; any other becomes "other". */
const STOP_CODES = new Set(["ok", "interrupted", "auth_required", "rpc_error", "shutdown_timeout", "provider_safety",
    "update_required", "spawn_error", "quota", "tool_error", "exit_before_result", "error_during_execution", "error", "failed", "cap",
    "max_tokens", "stalled", "stdin_write_failed", "timeout", "waiting_on_person", "other"]);
/** Why drivers say they retry (classifyError's reasons and the chat runtime's own); any other becomes "other". */
const RETRY_CODES = new Set(["rate_limited", "overloaded", "server_error", "connection_reset", "timeout", "auth", "quota",
    "unknown_model", "invalid_request", "not_found", "interrupted", "unknown", "provider_safety", "terminal_exit", "tool_limit", "request_too_large",
    "tool_use_failed", "stream_truncated", "api_error", "max_output_tokens", "compression", "retry", "other"]);
export const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const KIND = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export const CODE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const matchOr = (pattern, value, fallback) => typeof value === "string" && pattern.test(value) ? value : fallback;
export const TOOL_KINDS_KEPT = 6;
export const RETRY_WHY_KEPT = 4;
/** A tool call's kind from its engine-given name: a shell command when the engine sent one, else the trace view's icon. */
export function toolKindOf(title, summary) {
    if (summary)
        return "terminal";
    return title ? traceToolLook(title).icon : "tool";
}
export const stopCode = (ok, stopReason) => ok ? "ok" : typeof stopReason === "string" && STOP_CODES.has(stopReason) ? stopReason : stopReason ? "other" : "failed";
export const retryCode = (reason) => (typeof reason === "string" && RETRY_CODES.has(reason) ? reason : "other");
const count = (value, max = 1e10) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), max) : 0;
/** A record read back from disk, every field checked again; null when it is not one. */
export function parseTurnTiming(value) {
    const raw = value;
    if (!raw || typeof raw !== "object" || typeof raw.startedAt !== "number" || typeof raw.endedAt !== "number")
        return null;
    const ms = {};
    const rawMs = (raw.ms ?? {});
    for (const phase of PHASES)
        if (typeof rawMs[phase] === "number")
            ms[phase] = count(rawMs[phase]);
    const tools = (Array.isArray(raw.tools) ? raw.tools : []).flatMap((tool) => tool && TOOL_KINDS.has(tool.kind)
        ? [{ kind: tool.kind, n: count(tool.n), ms: count(tool.ms), max: count(tool.max), errors: count(tool.errors), open: count(tool.open) }]
        : []).slice(0, TOOL_KINDS_KEPT);
    const retryWhy = Array.isArray(raw.retryWhy) ? raw.retryWhy.map(retryCode).slice(0, RETRY_WHY_KEPT) : [];
    return {
        turnId: matchOr(ID, raw.turnId, null), threadId: matchOr(ID, raw.threadId, null), botId: matchOr(ID, raw.botId, null),
        engine: matchOr(KIND, raw.engine, null), startedAt: count(raw.startedAt, 1e14), endedAt: count(raw.endedAt, 1e14), ok: raw.ok === true,
        stop: stopCode(raw.ok === true, raw.stop), ms,
        ...(QUEUE_WHY.has(raw.queueWhy) ? { queueWhy: raw.queueWhy } : {}),
        retries: count(raw.retries, 1e6), backoffMs: count(raw.backoffMs), ...(retryWhy.length ? { retryWhy } : {}),
        ...(LIMIT_SCOPES.has(raw.limit) ? { limit: raw.limit } : {}),
        ...(typeof raw.limitResetsAt === "number" ? { limitResetsAt: count(raw.limitResetsAt, 1e14) } : {}),
        ...(raw.failover === "limit" || raw.failover === "signed-out" ? { failover: raw.failover } : {}),
        tools,
    };
}
export const isRetryCode = (value) => RETRY_CODES.has(value);
/** A turn's time less its wait on a person: what "slow" is judged on, so an unanswered card never makes a turn slow. */
export const activeMs = (turn) => Math.max(0, (turn.ms.total ?? 0) - (turn.ms.person ?? 0));
/** A count map safe for keys from outside (`__proto__`, `constructor`): no prototype to fall through to. */
export const counter = () => Object.create(null);
export const isToolKind = (value) => TOOL_KINDS.has(value);
export const isLimitScope = (value) => LIMIT_SCOPES.has(value);
