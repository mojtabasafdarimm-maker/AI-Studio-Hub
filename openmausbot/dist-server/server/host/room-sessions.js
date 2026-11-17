// Invariant: every window line is in the text sent, or was shown to this same native session in exactly this form; any doubt sends the whole window.
import { createHash } from "node:crypto";
import { MAX_WINDOW_MINUTES } from "../cache-keepwarm.js";
import { Handoffs, handedStateUsable, sessionStart, unseenMessages } from "../delta-context.js";
import { sessionIdlePolicy } from "../drivers/session-idle.js";
import { roomSessionsEnabled } from "../room-context-settings.js";
import { isRoomContextMessage } from "./room-transcript.js";
export const ROOM_SESSION_ENGINES = { claudeAgent: "CLAUDE" };
// Known gap: a process kept warm past this (prompt-cache keep-warm) goes on in the recorded session after a start, so a line can be sent twice.
export function roomSessionIdleMs(driverKind, env = process.env) {
    return Object.hasOwn(ROOM_SESSION_ENGINES, driverKind) ? sessionIdlePolicy(ROOM_SESSION_ENGINES[driverKind], env).idleMs : undefined;
}
const NEAR_COMPACTION = 0.8;
const ABANDONED_TURN_MS = 24 * 60 * 60_000;
const OWN = "";
const DELTA_NOTE = "[Messages this conversation received since your last turn in this room, oldest first. Your session already holds the conversation before them.]";
const DELTA_NONE = "[Messages this conversation received since your last turn in this room: none.]";
// The note's opening is one escapeNotes defuses in every transcript line, so no line can pose as this block.
export function renderRoomDelta(lines) {
    if (lines.length === 0)
        return DELTA_NONE;
    const updated = lines.filter((line) => line.updated);
    const earlier = lines.filter((line) => line.earlier && !line.updated);
    const fresh = lines.filter((line) => !line.earlier && !line.updated);
    return [
        DELTA_NOTE,
        ...(updated.length ? [updated.length === 1
                ? "(The first message was shown to you before and has changed since: this copy replaces what you were shown.)"
                : `(The first ${updated.length} messages were shown to you before and have changed since: these copies replace what you were shown.)`] : []),
        ...updated.map((line) => line.text),
        ...(earlier.length ? [`(The ${updated.length ? "next" : "first"} ${earlier.length === 1 ? "message is" : `${earlier.length} messages are`} older than messages you have already seen.)`] : []),
        ...earlier.map((line) => line.text),
        ...fresh.map((line) => line.text),
    ].join("\n");
}
const lineHash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
export function createRoomSessions(deps) {
    const now = deps.now ?? Date.now;
    const records = new Map();
    const inFlight = new Map();
    const lastSpeakers = new Map();
    const traces = new Map();
    const drop = (threadId, botId) => {
        const members = records.get(threadId);
        if (!members?.delete(botId))
            return;
        if (!members.size)
            records.delete(threadId);
    };
    const land = (threadId) => {
        inFlight.delete(threadId);
        handoffs.forget(threadId);
    };
    const roomStore = {
        order: (threadId) => deps.messagesFor(threadId).filter(isRoomContextMessage).map((m) => m.id),
        read: (botId, threadId, instanceId) => {
            const record = records.get(threadId)?.get(botId);
            return record?.instanceId === instanceId ? record.handed : undefined;
        },
        write: (botId, threadId, instanceId, state) => {
            const flight = inFlight.get(threadId);
            if (!flight || flight.distrusted || flight.botId !== botId || flight.instanceId !== instanceId)
                return;
            const members = records.get(threadId) ?? new Map();
            records.set(threadId, members);
            let handed = state;
            if (state.session !== undefined) {
                for (const [otherId, other] of members) {
                    if (otherId === botId || other.handed.session !== state.session)
                        continue;
                    members.delete(otherId);
                    handed = { ids: [] };
                }
            }
            const previous = members.get(botId);
            const earlier = previous && previous.handed.session === handed.session ? previous.texts : [];
            const texts = handed.session === undefined ? new Map()
                : new Map([...earlier, ...(handed.session === flight.cursor ? flight.delta : flight.window)]);
            members.set(botId, { instanceId, adapter: flight.adapter, handed, texts });
        },
        replies: (threadId, turnId) => deps.messagesFor(threadId)
            .filter((m) => m.role === "bot" && m.kind === "text" && m.turnId === turnId).map((m) => m.id),
    };
    const handoffs = new Handoffs(roomStore);
    function clear() {
        for (const threadId of inFlight.keys())
            handoffs.forget(threadId);
        records.clear();
        inFlight.clear();
        lastSpeakers.clear();
        traces.clear();
    }
    function prune(at) {
        const life = Math.max(0, ...Object.keys(ROOM_SESSION_ENGINES).map((kind) => roomSessionIdleMs(kind) ?? 0));
        const readingLife = Math.max(ABANDONED_TURN_MS, MAX_WINDOW_MINUTES * 60_000) + 2 * life;
        for (const [threadId, flight] of inFlight) {
            if (at - flight.since <= ABANDONED_TURN_MS)
                continue;
            land(threadId);
            drop(threadId, flight.botId);
        }
        const flying = (threadId, botId) => inFlight.get(threadId)?.botId === botId;
        for (const [threadId, members] of records) {
            for (const [botId, record] of members) {
                if (flying(threadId, botId))
                    continue;
                if (record.settledAt === undefined || at - record.settledAt > life)
                    members.delete(botId);
            }
            if (!members.size)
                records.delete(threadId);
        }
        for (const [threadId, speakers] of lastSpeakers) {
            for (const [instanceId, last] of speakers) {
                if (flying(threadId, last.botId) && inFlight.get(threadId).instanceId === instanceId)
                    continue;
                if (at - last.at > life)
                    speakers.delete(instanceId);
            }
            if (!speakers.size)
                lastSpeakers.delete(threadId);
        }
        for (const [threadId, members] of traces) {
            for (const [botId, trace] of members)
                if (!flying(threadId, botId) && at - trace.at > readingLife)
                    members.delete(botId);
            if (!members.size)
                traces.delete(threadId);
        }
    }
    const usable = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);
    function nearCompaction(context) {
        const tokens = usable(context?.tokens);
        const threshold = usable(context?.compactAt) ?? usable(context?.window);
        return tokens !== undefined && threshold !== undefined && tokens >= NEAR_COMPACTION * threshold;
    }
    function contextFell(trace, context) {
        if (trace?.ended === undefined)
            return false;
        const tokens = usable(context()?.tokens);
        if (tokens === undefined)
            return false;
        const fell = trace.session === trace.ended && trace.tokens !== undefined && tokens < trace.tokens;
        trace.tokens = tokens;
        trace.session = trace.ended;
        return fell;
    }
    function unseenLines(record, input, config, idleMs, context) {
        if (!record || input.reset)
            return undefined;
        const { handed, texts } = record;
        const { order, lines: window, readable } = input.window;
        if (record.instanceId !== input.instance.instanceId || record.adapter !== input.instance.adapter)
            return undefined;
        if (handed.config !== config)
            return undefined;
        if (record.settledAt === undefined || now() - record.settledAt > idleMs)
            return undefined;
        if (handed.session === undefined || !handedStateUsable(handed, handed.session, order))
            return undefined;
        if (nearCompaction(context()))
            return undefined;
        if (handed.omitted !== undefined && window.length && order.indexOf(window[0].id) <= order.indexOf(handed.omitted))
            return undefined;
        const inWindow = new Set(window.map((line) => line.id));
        const unseen = new Map(unseenMessages(readable.map((id) => ({ id, role: "user", text: "" })), order, handed)
            .map((message) => [message.id, message.earlier === true]));
        for (const id of unseen.keys())
            if (!inWindow.has(id))
                return undefined;
        for (const id of texts.keys())
            if (!inWindow.has(id))
                texts.delete(id);
        const lines = [];
        const shown = new Map();
        for (const line of window) {
            const hash = lineHash(line.text);
            const earlier = unseen.get(line.id);
            const known = texts.get(line.id);
            if (earlier === undefined && known === OWN) {
                texts.set(line.id, hash);
                continue;
            }
            if (earlier === undefined && known === hash)
                continue;
            shown.set(line.id, hash);
            lines.push(earlier !== undefined ? (earlier ? { ...line, earlier: true } : line)
                : known === undefined ? { ...line, earlier: true } : { ...line, updated: true });
        }
        return { session: handed.session, lines, shown };
    }
    function decide(input, full, today) {
        const { threadId, botId, instance, window } = input;
        const legacy = () => ({ mode: "legacy", text: full, send: today });
        if (!roomSessionsEnabled(deps.settings(), deps.env)) {
            clear();
            return legacy();
        }
        const at = now();
        prune(at);
        const stale = inFlight.get(threadId);
        if (stale)
            drop(threadId, stale.botId);
        land(threadId);
        const speakers = lastSpeakers.get(threadId) ?? new Map();
        lastSpeakers.set(threadId, speakers);
        const spokeLast = speakers.get(instance.instanceId)?.botId === botId;
        speakers.set(instance.instanceId, { botId, at });
        const idleMs = roomSessionIdleMs(instance.driverKind);
        if (idleMs === undefined || instance.adapter.capabilities.strictResume !== true || !input.hooks || input.guestConfined) {
            drop(threadId, botId);
            const untracked = traces.get(threadId)?.get(botId);
            if (untracked)
                untracked.ended = undefined;
            return legacy();
        }
        let asked;
        const context = () => (asked ??= { reading: input.context?.() }).reading;
        if (contextFell(traces.get(threadId)?.get(botId), context))
            drop(threadId, botId);
        const config = createHash("sha256").update(JSON.stringify(input.config)).digest("hex");
        const { order } = window;
        const ids = window.lines.map((line) => line.id);
        const first = ids.length ? order.indexOf(ids[0]) : order.length;
        const started = sessionStart(order, ids, order.slice(first));
        const nothing = { ...(order.length ? { omitted: order.at(-1) } : {}), sent: [] };
        const handoff = { botId, instanceId: instance.instanceId, config, started, recovery: started, resumed: nothing, carried: [], own: [] };
        const fly = (delta, cursor) => {
            handoffs.dispatching(threadId, input.claimId);
            inFlight.set(threadId, {
                botId, instanceId: instance.instanceId, adapter: instance.adapter, claimId: input.claimId, since: at,
                ...(cursor === undefined ? {} : { cursor }),
                window: new Map(window.lines.map((line) => [line.id, lineHash(line.text)])), delta,
            });
        };
        const delta = spokeLast ? unseenLines(records.get(threadId)?.get(botId), input, config, idleMs, context) : undefined;
        if (!delta) {
            drop(threadId, botId);
            handoffs.begin(threadId, input.claimId, { ...handoff, resumeCursor: undefined, placed: [] });
            fly(new Map());
            return { mode: "start", text: full, send: today };
        }
        handoffs.begin(threadId, input.claimId, { ...handoff, resumeCursor: delta.session, placed: [...order] });
        fly(delta.shown, delta.session);
        return {
            mode: "resume",
            text: input.wrap(renderRoomDelta(delta.lines) + input.tail),
            send: { resumeCursor: delta.session, recoveryText: full },
        };
    }
    function forget(threadId) {
        records.delete(threadId);
        lastSpeakers.delete(threadId);
        traces.delete(threadId);
        land(threadId);
    }
    function guarded(threadId, work) {
        try {
            work();
        }
        catch (error) {
            try {
                forget(threadId);
            }
            catch { /* nothing more to let go of */ }
            console.warn(`room sessions: forgot the sessions of thread ${threadId} (${error instanceof Error ? error.message : String(error)})`);
        }
    }
    function onEvent(event) {
        handoffs.onEvent(event);
        if (event.type !== "turn.completed" && event.type !== "session.started")
            return;
        const flight = inFlight.get(event.threadId);
        if (!flight || event.providerInstanceId !== flight.instanceId)
            return;
        if (flight.turnId && event.turnId && event.turnId !== flight.turnId)
            return;
        if (event.type === "session.started") {
            if (event.sessionId)
                flight.session = event.sessionId;
            return;
        }
        inFlight.delete(event.threadId);
        const spoke = lastSpeakers.get(event.threadId)?.get(flight.instanceId);
        if (spoke?.botId === flight.botId)
            spoke.at = now();
        const members = traces.get(event.threadId) ?? new Map();
        traces.set(event.threadId, members);
        members.set(flight.botId, { ...members.get(flight.botId), ended: flight.session, at: now() });
        const record = records.get(event.threadId)?.get(flight.botId);
        if (!event.ok || flight.distrusted || !record || record.handed.session === undefined || record.handed.session !== flight.session) {
            drop(event.threadId, flight.botId);
            return;
        }
        record.settledAt = now();
        const turnId = event.turnId ?? flight.turnId;
        if (turnId)
            for (const id of roomStore.replies(event.threadId, turnId))
                record.texts.set(id, OWN);
    }
    return {
        dispatch(input) {
            const full = input.wrap(input.window.text + input.tail);
            const today = input.reset ? { sessionReset: true } : {};
            try {
                return decide(input, full, today);
            }
            catch (error) {
                try {
                    const stale = inFlight.get(input.threadId);
                    if (stale)
                        drop(input.threadId, stale.botId);
                    land(input.threadId);
                    drop(input.threadId, input.botId);
                }
                catch { /* nothing more to let go of */ }
                console.warn(`room sessions: sent the whole window instead on thread ${input.threadId} (${error instanceof Error ? error.message : String(error)})`);
                return { mode: "legacy", text: full, send: today };
            }
        },
        bindTurn(threadId, claimId, turnId) {
            guarded(threadId, () => {
                handoffs.bindTurn(threadId, claimId, turnId);
                const flight = inFlight.get(threadId);
                if (flight?.claimId === claimId)
                    flight.turnId ??= turnId;
            });
        },
        onEvent(event) {
            guarded(event.threadId, () => onEvent(event));
        },
        distrust(threadId, botId) {
            guarded(threadId, () => {
                drop(threadId, botId);
                const flight = inFlight.get(threadId);
                if (flight?.botId === botId)
                    flight.distrusted = true;
            });
        },
        forget,
        tracked() {
            const count = (map) => [...map.values()].reduce((n, inner) => n + inner.size, 0);
            const lines = [...records.values()].flatMap((members) => [...members.values()]).reduce((n, record) => n + record.texts.size, 0);
            return { records: count(records), flights: inFlight.size, speakers: count(lastSpeakers), lines, readings: count(traces) };
        },
    };
}
