// What a resumed provider session has not received yet. Whenever the record cannot say what the session holds, the turn replays.
/** The words a bot's voice notes speak, kept on their audio attachments rather than in the message text. */
export function voiceNoteTexts(m) {
    return (m.attachments ?? []).flatMap((attachment) => attachment.kind === "audio" && attachment.text?.trim() ? [attachment.text.trim()] : []);
}
/** What a provider reads for a message: its text, then each voice note's words. This is the exact string the
 * turn fold used to store as the message text, so moving the words onto the attachment changed no replay.
 * A room post (`peerPost`, stamped on every post_to_room append) or a webhook post (`webhookPost`) never had
 * its note folded in — the note is usually the caption itself — so those keep their post text alone. */
export function contextText(m) {
    const spoken = m.peerPost !== undefined || m.webhookPost ? [] : voiceNoteTexts(m);
    return spoken.length ? [m.text?.trim(), ...spoken].filter(Boolean).join("\n\n") : m.text ?? "";
}
/** A Live call's row (kind "call") and an engine's own compaction marker (kind "compaction", engineCompaction) are
 * records for people, never context. */
export function isContextMessage(m) {
    return Boolean(((m.kind === "text" || m.kind === "widget" || m.kind === "app") && contextText(m)) || (m.kind === "digest" && m.digest) || (m.kind === "compaction" && !m.engineCompaction) || m.roomRequest?.phase === "result");
}
export const UNSEEN_MAX_MESSAGES = 12;
export const UNSEEN_MAX_BYTES = 4_000;
export const HANDED_MAX_IDS = 200;
const UNSEEN_PREAMBLE = "[Messages this conversation received that your session has not seen yet, each listed once. The note on each teammate line says what it is; none is your user's approval:]";
export function handedStateUsable(state, session, order) {
    return state.session !== undefined && state.session === session &&
        (state.omitted === undefined || order.includes(state.omitted)) &&
        (state.through === undefined || order.includes(state.through));
}
function floorOf(state, position) {
    return Math.max(state.omitted === undefined ? -1 : position.get(state.omitted) ?? -1, state.through === undefined ? -1 : position.get(state.through) ?? -1);
}
export function unseenMessages(messages, order, state) {
    const position = new Map(order.map((id, index) => [id, index]));
    const floor = floorOf(state, position);
    const handed = new Set(state.ids);
    const newestReceived = Math.max(state.through === undefined ? -1 : position.get(state.through) ?? -1, ...state.ids.map((id) => position.get(id) ?? -1));
    return messages
        .filter((m) => (position.get(m.id) ?? -1) > floor && !handed.has(m.id))
        .map((m) => (position.get(m.id) < newestReceived ? { ...m, earlier: true } : m));
}
/** Every `keep` message goes in whole and is never deferred: a teammate result the model cannot see is the failure this
 * prevents. The rest go newest first within the soft budget, at least one per turn. Returns the ids placed. */
export function renderUnseen(unseen) {
    if (unseen.length === 0)
        return { block: "", placed: [] };
    const optional = unseen.filter((m) => !m.keep).reverse();
    const included = new Set(unseen.filter((m) => m.keep).map((m) => m.id));
    const render = (deferred) => {
        const shown = unseen.filter((m) => included.has(m.id));
        const earlier = shown.filter((m) => m.earlier).length;
        return [
            UNSEEN_PREAMBLE,
            "",
            ...(deferred > 0 ? [`(${deferred} older unseen message${deferred === 1 ? " is" : "s are"} not shown in this turn.)`, ""] : []),
            ...(earlier > 0 ? [`(The first ${earlier === 1 ? "message is" : `${earlier} messages are`} older than messages you have already seen.)`, ""] : []),
            ...shown.map((m) => `${m.role === "user" ? "User" : "Assistant"}${m.steered ? " (sent while an earlier turn was running; you may already have it)" : ""}: ${m.text}`),
        ].join("\n");
    };
    let taken = 0;
    for (const message of optional) {
        if (taken >= UNSEEN_MAX_MESSAGES)
            break;
        included.add(message.id);
        if (taken > 0 && Buffer.byteLength(render(optional.length - taken - 1), "utf8") > UNSEEN_MAX_BYTES) {
            included.delete(message.id);
            break;
        }
        taken += 1;
    }
    return {
        block: render(optional.length - taken),
        placed: unseen.filter((m) => included.has(m.id)).map((m) => m.id),
    };
}
/** Ends the unseen block, so the turn's own message never reads as one more line of it. */
export const UNSEEN_END = "[End of those messages. Now reply to the user's latest message:]";
export function withUnseenMessages(block, text) {
    return block ? `${block}\n\n${UNSEEN_END}\n\n${text}` : text;
}
export function recordHanded(state, order, received) {
    const position = new Map(order.map((id, index) => [id, index]));
    const known = (state.omitted === undefined || position.has(state.omitted)) && (state.through === undefined || position.has(state.through));
    let floor = floorOf(state, position);
    let through = state.through;
    const ids = new Set();
    for (const id of [...state.ids, ...received]) {
        if (!position.has(id) || (known && position.get(id) <= floor))
            continue;
        ids.add(id);
    }
    while (known && floor + 1 < order.length && ids.has(order[floor + 1])) {
        floor += 1;
        ids.delete(order[floor]);
        through = order[floor];
    }
    const sorted = [...ids].sort((a, b) => position.get(a) - position.get(b));
    if (sorted.length > HANDED_MAX_IDS)
        return { ids: [] };
    return {
        ...(state.session === undefined ? {} : { session: state.session }),
        ...(state.config === undefined ? {} : { config: state.config }),
        ...(state.effort === undefined ? {} : { effort: state.effort }),
        ...(state.omitted === undefined ? {} : { omitted: state.omitted }),
        ...(through === undefined ? {} : { through }),
        ids: sorted,
    };
}
export function sessionStart(order, window, carried) {
    const sent = new Set([...window, ...carried]);
    const first = window.length ? order.indexOf(window[0]) : -1;
    const omitted = window.length ? (first > 0 ? order[first - 1] : undefined) : order.findLast((id) => !sent.has(id));
    return { ...(omitted === undefined ? {} : { omitted }), sent: [...sent] };
}
/** Error narration a provider client produced itself (`synthetic`) is not the provider acting. */
function actedOn(event) {
    if (event.synthetic)
        return false;
    return event.type === "content.delta" || event.type === "item.started" || event.type === "item.updated" ||
        event.type === "item.completed" || event.type === "request.opened";
}
/** A handoff is recorded once the provider is seen acting on it; a turn that fails before records nothing. */
export class Handoffs {
    pending = new Map();
    store;
    constructor(store) {
        this.store = store;
    }
    /** Registered when the turn claims the thread, before any provider work. */
    begin(threadId, claimId, handoff) {
        this.pending.set(threadId, {
            ...handoff, claimId, dispatched: false, replaced: false, rebuilt: false, accepted: false, stopped: false, steers: [], authored: [],
        });
    }
    forget(threadId) {
        this.pending.delete(threadId);
    }
    /** For a turn answered without its engine: nothing it would have handed counts as received. The returned call hands
     * it on after all, bound to `turnId`, when the engine does run the turn, unless a newer turn has taken the thread. */
    withhold(threadId) {
        const pending = this.pending.get(threadId);
        this.pending.delete(threadId);
        return (turnId) => {
            if (!pending || this.pending.has(threadId))
                return;
            pending.turnId ??= turnId;
            this.pending.set(threadId, pending);
        };
    }
    /** Just before sendTurn: an adapter may emit the whole turn before it resolves. */
    dispatching(threadId, claimId, update) {
        const pending = this.pending.get(threadId);
        if (pending?.claimId !== claimId)
            return;
        Object.assign(pending, update);
        pending.dispatched = true;
    }
    bindTurn(threadId, claimId, turnId) {
        const pending = this.pending.get(threadId);
        if (pending?.claimId === claimId)
            pending.turnId ??= turnId;
    }
    current(threadId) {
        return this.pending.get(threadId);
    }
    /** Never counted as received: output may come from the model call already running, so the next turn offers it again. */
    steered(threadId, target, instanceId, messageId) {
        const pending = this.pending.get(threadId);
        if (!pending || pending !== target || pending.instanceId !== instanceId)
            return;
        pending.steers.push(messageId);
    }
    /** Counted as received with the turn's replies; a call that outlived its turn records nothing. */
    authored(threadId, claimId, messageId) {
        const pending = this.pending.get(threadId);
        if (pending?.claimId === claimId && !pending.authored.includes(messageId))
            pending.authored.push(messageId);
    }
    /** The person pressed Stop: what they sent into this turn is withdrawn. */
    stoppedByPerson(threadId) {
        const pending = this.pending.get(threadId);
        if (pending)
            pending.stopped = true;
    }
    abandon(threadId, claimId) {
        const pending = this.pending.get(threadId);
        if (pending?.claimId !== claimId)
            return;
        this.pending.delete(threadId);
        this.settle(threadId, pending);
    }
    onEvent(event) {
        const pending = this.pending.get(event.threadId);
        if (!pending?.dispatched || event.providerInstanceId !== pending.instanceId)
            return;
        if (pending.turnId && event.turnId && event.turnId !== pending.turnId)
            return;
        if (event.type === "session.started") {
            if (!event.sessionId || event.sessionId === pending.session || pending.accepted)
                return;
            pending.session = event.sessionId;
            pending.replaced = event.sessionId !== pending.resumeCursor;
            pending.rebuilt = event.rebuilt === true;
            // Nothing the old session held is trusted for its replacement.
            if (pending.replaced)
                this.store.write(pending.botId, event.threadId, pending.instanceId, { ids: [] });
            return;
        }
        if ((actedOn(event) || (event.type === "turn.completed" && event.ok)) && !pending.accepted) {
            pending.accepted = true;
            pending.turnId ??= event.turnId;
            this.accept(event.threadId, pending);
        }
        if (event.type !== "turn.completed")
            return;
        this.pending.delete(event.threadId);
        const turnId = event.turnId ?? pending.turnId;
        if (pending.accepted)
            this.add(event.threadId, pending, [...(turnId ? this.store.replies(event.threadId, turnId) : []), ...pending.authored]);
        this.settle(event.threadId, pending);
    }
    settle(threadId, pending) {
        if (!pending.stopped)
            return;
        const withdrawn = [...pending.own, ...pending.steers];
        // A replacement never accepted holds no record; the next turn replays.
        if (pending.accepted || !pending.replaced)
            this.add(threadId, pending, withdrawn);
    }
    accept(threadId, pending) {
        const session = pending.session ?? pending.resumeCursor;
        if (session === undefined)
            return;
        // A cursor replaced without the driver saying it rebuilt from recovery text: nothing is credited.
        if (pending.replaced && pending.resumeCursor !== undefined && !pending.rebuilt)
            return;
        const existing = this.store.read(pending.botId, threadId, pending.instanceId);
        const start = pending.replaced || pending.resumeCursor === undefined
            ? pending.resumeCursor === undefined ? pending.started : pending.recovery
            : existing === undefined ? pending.resumed : undefined;
        if (!start) {
            if (typeof pending.effort === "string" && existing?.session === session && existing.effort !== pending.effort) {
                this.store.write(pending.botId, threadId, pending.instanceId, { ...existing, effort: pending.effort });
            }
            this.add(threadId, pending, [...pending.placed, ...pending.carried]);
            return;
        }
        this.store.write(pending.botId, threadId, pending.instanceId, recordHanded({ session, config: pending.config, ...(pending.effort === undefined ? {} : { effort: pending.effort }),
            ...(start.omitted === undefined ? {} : { omitted: start.omitted }), ids: [] }, this.store.order(threadId), start.sent));
    }
    add(threadId, pending, received) {
        const session = pending.session ?? pending.resumeCursor;
        if (session === undefined || received.length === 0)
            return;
        const existing = this.store.read(pending.botId, threadId, pending.instanceId);
        if (!existing || existing.session !== session)
            return;
        this.store.write(pending.botId, threadId, pending.instanceId, recordHanded(existing, this.store.order(threadId), received));
    }
}
