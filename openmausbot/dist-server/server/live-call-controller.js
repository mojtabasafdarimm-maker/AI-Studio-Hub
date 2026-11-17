// Nothing said on the call is logged; the summary line has counters only.
import { randomUUID } from "node:crypto";
import { spokenConsent } from "../shared/call-consent.js";
import { LIVE_COPY, liveCardKind, liveStepLabel, spokenApprovalPrompt, spokenConnectorPrompt, spokenQuestionPrompt, spokenReviewPrompt, spokenSecretPrompt, spokenSignInPrompt, } from "../shared/live-approval.js";
import { botCallVoice, clampAppend, commentaryChunks, geminiLiveVoice, LiveTranscript } from "../shared/live-call.js";
import { signInWaits } from "../shared/sign-in-request.js";
import { FISH_AGENT_VOICE } from "./live-fish.js";
import { LIVE_NEEDS_KEY, liveAuthHeaders, liveCallSummaryLine, liveProviderName, LiveSessionError, liveVoice, spokenHangUp } from "./live-call.js";
import { LIVE_CUSTOM_REFUSAL } from "./live-access.js";
export const DELEGATION_SETTLE_MS = 700;
export const CONSENT_SETTLE_MS = 1_200;
export const PROGRESS_INTERVAL_MS = 4_000;
export const ATTACH_TIMEOUT_MS = 10_000;
/** Fish's client asks for the microphone only after the session exists, so its first report can wait on a permission prompt. */
export const FISH_ATTACH_TIMEOUT_MS = 25_000;
export const CLOSE_TIMEOUT_MS = 5_000;
export const IDLE_CHECK_MS = 15_000;
export const STATUS_INTERVAL_MS = 30_000;
/** Time for the voice to say goodbye before a call the person asked to end is closed. */
export const GOODBYE_MS = 4_000;
const SOCKET_OPEN = 1;
const MAX_ERRORS = 5;
const MAX_REVOKED_DEVICES = 200;
/** GPT-Live's own delegation of a spoken yes/no may land this far past the decision on the session timeline. */
const DECISION_ECHO_MS = 3_000;
export const LIVE_FISH_NEEDS_APP = "Live calls through Fish Audio work in the desktop app or a web browser, not in the phone app yet.";
export const LIVE_GEMINI_NEEDS_APP = "Live calls through Gemini work in the desktop app or a web browser, not in the phone app yet.";
export const LIVE_ELEVENLABS_NEEDS_APP = "Live calls through ElevenLabs work in the desktop app or a web browser, not in the phone app yet.";
/** Fish Audio, Gemini and ElevenLabs calls are relayed: the client holds the provider's session and reports what it heard. */
export function relayedProvider(provider) {
    return provider === "fish" || provider === "gemini" || provider === "elevenlabs" ? provider : null;
}
export class LiveCallBusyError extends Error {
    call;
    constructor(call) {
        super("A Live call is already running.");
        this.call = call;
    }
}
export class LiveCallSignedOutError extends LiveSessionError {
    constructor() {
        super("The sign-in that started this call has ended.", 401);
    }
}
// Node's WebSocket (undici) accepts headers in its second argument.
export const openLiveSocket = (url, key, endpoint) => new WebSocket(url, { headers: liveAuthHeaders(endpoint.provider, key) });
const CLOSE_REASONS = {
    expired: "expired",
    content: "content",
    remote_hangup: "remote-hangup",
    connection_lost: "connection-lost",
};
export class LiveCallController {
    deps;
    call = null;
    revokedDevices = new Set();
    constructor(deps) {
        this.deps = deps;
    }
    current() {
        return this.call && this.call.state.status !== "ended" ? { ...this.call.state } : null;
    }
    async start(input) {
        const settings = this.deps.settings();
        // First: someone refused here is not told about a running call, or sent to set Azure or a relayed service up.
        // The chosen relayed service comes before a key's endpoint, so its refusal and its mismatch check apply.
        const relayedChoice = relayedProvider(settings.provider);
        // A custom endpoint is held to Azure's limit (LIVE_DATA_CHANNEL), with its own words.
        const limited = settings.provider === "azure" || settings.endpoint?.provider === "azure" ? "azure"
            : settings.provider === "custom" || settings.endpoint?.provider === "custom" ? "custom"
                : relayedChoice ?? relayedProvider(settings.endpoint?.provider);
        if (limited) {
            const refusal = limited === "azure" ? this.deps.azureRefusal(input.auth) : limited === "custom" ? this.deps.azureRefusal(input.auth) && LIVE_CUSTOM_REFUSAL
                : limited === "fish" ? this.deps.fishRefusal(input.auth)
                    : limited === "gemini" ? this.deps.geminiRefusal(input.auth) : this.deps.elevenlabsRefusal(input.auth);
            if (refusal) {
                this.deps.log(`[live] call refused bot=${input.botId} client=${input.client} provider=${limited}`);
                throw new LiveSessionError(refusal, 403);
            }
        }
        const relayed = limited === "azure" || limited === "custom" ? null : limited;
        if (relayed && (input.client === "ios" || input.client === "android"))
            throw new LiveSessionError(relayed === "fish" ? LIVE_FISH_NEEDS_APP : relayed === "gemini" ? LIVE_GEMINI_NEEDS_APP : LIVE_ELEVENLABS_NEEDS_APP, 400);
        if (!relayed && !input.sdp)
            throw new LiveSessionError("The call request was not valid.", 400);
        if (this.call && this.call.state.status !== "ended")
            throw new LiveCallBusyError({ ...this.call.state });
        if (input.device && this.revokedDevices.has(input.device))
            throw new LiveCallSignedOutError();
        const key = settings.key.trim();
        const endpoint = settings.endpoint;
        if (settings.setupProblem || !key || !endpoint)
            throw new LiveSessionError(settings.setupProblem || LIVE_NEEDS_KEY, 409);
        if (relayed !== relayedProvider(endpoint.provider))
            throw new LiveSessionError(settings.setupProblem || LIVE_NEEDS_KEY, 409);
        const botVoice = this.deps.botVoice?.(input.botId);
        const voice = relayed === "gemini" ? geminiLiveVoice(botCallVoice(botVoice, settings.geminiVoice, true))
            : relayed ? FISH_AGENT_VOICE : liveVoice(botCallVoice(botVoice, settings.voice, false));
        const call = this.newCall(input, key, endpoint, voice);
        // Taken before the first await: a second start in the same tick is refused.
        this.call = call;
        let session;
        try {
            session = await this.deps.createSession({ key, endpoint, sdp: relayed ? "" : input.sdp ?? "", botId: input.botId, threadId: input.threadId, voice });
        }
        catch (error) {
            if (this.call === call)
                this.call = null;
            this.deps.log(`[live] call failed bot=${input.botId} client=${input.client} status=${error instanceof LiveSessionError ? error.status : "error"}`);
            throw error;
        }
        if (this.call !== call) {
            this.closeOrphan(session.sessionId, key, endpoint);
            throw new LiveSessionError("The call was cancelled.", 503);
        }
        try {
            call.sessionId = session.sessionId;
            call.state.startedAt = this.now();
            call.lastActivityAt = this.now();
            call.lastActivity = this.deps.activity(input.botId, input.threadId);
            if (call.lastActivity === "working")
                this.beginWork(call);
            call.unsubscribe = this.deps.store.onChange((change) => this.onStoreChange(call, change));
            this.deps.log(`[live] call started bot=${input.botId} voice=${voice} client=${input.client}`);
            this.emit(call);
            // Set before attach: a sideband that fails at once runs finish, which clears this interval.
            call.idleTimer = setInterval(() => this.guarded(call, () => this.checkIdle(call)), IDLE_CHECK_MS);
            call.idleTimer.unref?.();
            this.attach(call);
        }
        catch (error) {
            const sidebandOpened = call.socket !== null;
            this.finish(call, "error", "The call could not start.");
            if (!sidebandOpened)
                this.closeOrphan(session.sessionId, key, endpoint);
            throw error;
        }
        const state = { ...call.state };
        if ("fish" in session)
            return { call: state, fish: session.fish };
        if ("gemini" in session)
            return { call: state, gemini: session.gemini };
        if ("elevenlabs" in session)
            return { call: state, elevenlabs: session.elevenlabs };
        return { call: state, sdp: session.sdp };
    }
    async end(callId) {
        const call = this.call;
        if (!call || call.state.callId !== callId || call.state.status === "ended")
            return null;
        await this.hangUp(call, "hung-up");
        return { ...call.state };
    }
    async shutdown() {
        const call = this.call;
        if (!call || call.state.status === "ended")
            return;
        this.command(call, { type: "session.close" });
        this.finish(call, "shutdown");
    }
    deviceRevoked(deviceId) {
        this.revokedDevices.add(deviceId);
        if (this.revokedDevices.size > MAX_REVOKED_DEVICES)
            this.revokedDevices.delete(this.revokedDevices.values().next().value);
        const call = this.call;
        if (!call || call.device !== deviceId)
            return null;
        return this.endSignedOut(call, null, LIVE_COPY.unpaired) ? { ...call.state } : null;
    }
    sessionRevoked(sessionId) {
        const call = this.call;
        if (!call || call.auth.kind !== "session" || call.auth.session.id !== sessionId)
            return null;
        return this.endSignedOut(call, null) ? { ...call.state } : null;
    }
    newCall(input, key, endpoint, voice) {
        return {
            state: { callId: randomUUID(), botId: input.botId, threadId: input.threadId, client: input.client, voice, startedAt: this.now(), status: "connecting" },
            auth: input.auth,
            device: input.device ?? null,
            personKey: this.deps.personKey?.(input.auth),
            botName: input.botName,
            key,
            endpoint,
            sessionId: "",
            socket: null,
            attached: false,
            transcript: new LiveTranscript(),
            heardThroughMs: 0,
            lastDecision: null,
            eventCounter: 0,
            activeDelegation: null,
            lastProgressAt: 0,
            lastActivityAt: this.now(),
            lastActivity: "idle",
            workStartedAt: null,
            workSteps: 0,
            lastStep: null,
            lastStepAt: 0,
            lastStatusAt: 0,
            approval: null,
            question: null,
            waitingCards: [],
            announced: new Set(),
            pendingCall: new Set(),
            claimNextTerminal: false,
            queuedIds: new Set(),
            typedTexts: new Map(),
            batches: new Map(),
            drainBatch: null,
            spokenAnswers: new Set(),
            pendingEnd: null,
            goodbye: false,
            timers: new Set(),
            consentTimer: null,
            idleTimer: null,
            unsubscribe: null,
            closeWaiters: [],
            stats: { delegations: 0, sentToBot: 0, answers: 0, approvals: 0, notHeard: 0, replies: 0, seconds: null, errors: [] },
        };
    }
    attach(call) {
        let socket;
        try {
            socket = this.deps.openSocket(this.deps.attachUrl(call.sessionId, call.endpoint), call.key, call.endpoint);
        }
        catch {
            this.finish(call, "sideband-lost", `The call could not connect to ${liveProviderName(call.endpoint.provider)}.`);
            return;
        }
        call.socket = socket;
        const attachTimer = this.later(call, () => {
            if (!call.attached)
                this.finish(call, "sideband-lost", `The call could not connect to ${liveProviderName(call.endpoint.provider)}.`);
        }, relayedProvider(call.endpoint.provider) ? FISH_ATTACH_TIMEOUT_MS : ATTACH_TIMEOUT_MS);
        socket.onopen = () => {
            call.attached = true;
            this.clear(call, attachTimer);
            if (call.state.status === "connecting") {
                call.state.status = "live";
                this.emit(call);
            }
        };
        socket.onmessage = (event) => this.guarded(call, () => this.onSideband(call, event.data));
        // Node's WebSocket reports a refused handshake as an error without a close.
        socket.onerror = () => {
            if (!call.attached)
                this.finish(call, "sideband-lost", `The call could not connect to ${liveProviderName(call.endpoint.provider)}.`);
        };
        socket.onclose = () => {
            if (call.state.status === "ended")
                return;
            if (call.pendingEnd)
                this.finish(call, call.pendingEnd);
            else
                this.finish(call, "sideband-lost", `The call connection to ${liveProviderName(call.endpoint.provider)} dropped.`);
        };
    }
    closeOrphan(sessionId, key, endpoint) {
        let socket;
        try {
            socket = this.deps.openSocket(this.deps.attachUrl(sessionId, endpoint), key, endpoint);
        }
        catch {
            return;
        }
        const done = () => {
            clearTimeout(timer);
            socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
            try {
                socket.close(1000, "call cancelled");
            }
            catch { }
        };
        const timer = setTimeout(done, ATTACH_TIMEOUT_MS);
        timer.unref?.();
        socket.onopen = () => {
            try {
                socket.send(JSON.stringify({ type: "session.close", event_id: "omb_cancelled" }));
            }
            catch { }
            done();
        };
        socket.onerror = done;
        socket.onclose = () => clearTimeout(timer);
    }
    hangUp(call, reason) {
        if (call.state.status === "ended")
            return Promise.resolve();
        call.pendingEnd ??= reason;
        const done = new Promise((resolve) => call.closeWaiters.push(resolve));
        if (call.state.status === "ending")
            return done;
        call.state.status = "ending";
        this.emit(call);
        if (!this.command(call, { type: "session.close" }))
            this.finish(call, call.pendingEnd);
        else
            this.later(call, () => this.finish(call, call.pendingEnd ?? reason), CLOSE_TIMEOUT_MS);
        return done;
    }
    finish(call, reason, error) {
        if (call.state.status === "ended")
            return;
        call.state.status = "ended";
        call.state.endReason = reason;
        if (error)
            call.state.error = error;
        for (const timer of call.timers)
            clearTimeout(timer);
        call.timers.clear();
        if (call.idleTimer)
            clearInterval(call.idleTimer);
        call.idleTimer = null;
        call.unsubscribe?.();
        call.unsubscribe = null;
        const socket = call.socket;
        call.socket = null;
        if (socket) {
            socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
            try {
                socket.close(1000, "call ended");
            }
            catch { }
        }
        this.emit(call);
        this.writeRecord(call, reason);
        this.deps.log(liveCallSummaryLine({
            botId: call.state.botId,
            voice: call.state.voice,
            client: call.state.client,
            seconds: call.stats.seconds ?? (this.now() - call.state.startedAt) / 1000,
            delegations: call.stats.delegations,
            sentToBot: call.stats.sentToBot,
            answers: call.stats.answers,
            approvals: call.stats.approvals,
            notHeard: call.stats.notHeard,
            replies: call.stats.replies,
            end: reason,
            errors: call.stats.errors,
        }));
        if (this.call === call)
            this.call = null;
        for (const resolve of call.closeWaiters.splice(0))
            resolve();
    }
    writeRecord(call, reason) {
        if (!call.attached || !this.deps.recordCall)
            return;
        const endedAt = this.now();
        const record = {
            callId: call.state.callId,
            botId: call.state.botId,
            client: call.state.client,
            startedAt: call.state.startedAt,
            endedAt,
            seconds: Math.max(0, Math.round(call.stats.seconds ?? (endedAt - call.state.startedAt) / 1000)),
            endReason: reason,
        };
        try {
            this.deps.recordCall({ threadId: call.state.threadId, botName: call.botName, record });
        }
        catch {
            this.recordError(call, "record");
        }
    }
    checkIdle(call) {
        if (call.state.status !== "live" && call.state.status !== "connecting")
            return;
        // Talking keeps a call from idling out; it must not keep a signed-out person's call up.
        if (this.deps.signedIn && !this.deps.signedIn(call.auth)) {
            this.endSignedOut(call, null);
            return;
        }
        if (this.deps.activity(call.state.botId, call.state.threadId) === "working") {
            this.touch(call);
            this.maybeStatus(call);
            return;
        }
        const idleMs = this.deps.settings().idleMinutes * 60_000;
        if (this.now() - call.lastActivityAt >= idleMs)
            void this.hangUp(call, "idle");
    }
    onSideband(call, raw) {
        const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : raw instanceof ArrayBuffer ? Buffer.from(raw).toString("utf8") : "";
        // The sideband mirrors the audio; skip it without parsing megabytes of base64.
        if (!text || text.includes('"session.input_audio.append"') || text.includes('"session.output_audio.delta"'))
            return;
        let event;
        try {
            event = JSON.parse(text);
        }
        catch {
            return;
        }
        if (call.state.status === "ended")
            return;
        switch (event.type) {
            case "session.started":
                if (call.state.status === "connecting") {
                    call.state.status = "live";
                    this.emit(call);
                }
                return;
            case "session.input_transcript.delta":
                call.transcript.addInput(String(event.delta ?? ""), Number(event.start_ms), Number(event.end_ms));
                call.heardThroughMs = Math.max(call.heardThroughMs, Number(event.end_ms) || 0);
                this.touch(call);
                if (call.approval && !call.approval.submitted)
                    this.scheduleConsentCheck(call);
                return;
            case "session.output_transcript.delta":
                call.transcript.addOutput(Number(event.start_ms), Number(event.end_ms));
                this.touch(call);
                return;
            case "session.delegation.created": {
                const delegation = event.delegation;
                if (delegation?.target !== "client" || typeof delegation.id !== "string")
                    return;
                const id = delegation.id;
                const offset = Number(event.offset_ms) || 0;
                call.stats.delegations += 1;
                this.touch(call);
                this.later(call, () => this.delegate(call, id, offset), DELEGATION_SETTLE_MS);
                return;
            }
            case "session.usage.updated":
            case "session.closed": {
                const seconds = Number(event.usage?.seconds);
                if (Number.isFinite(seconds))
                    call.stats.seconds = seconds;
                if (event.type === "session.closed") {
                    const reason = CLOSE_REASONS[String(event.reason)] ?? call.pendingEnd ?? "hung-up";
                    this.finish(call, reason);
                }
                return;
            }
            case "error": {
                this.recordError(call, String(event.error?.code ?? "error"));
                return;
            }
            default:
                return;
        }
    }
    async delegate(call, id, offsetMs) {
        if (call.state.status !== "live" || call.goodbye)
            return;
        const heard = call.transcript.takeRequestParts(offsetMs);
        const said = heard.text;
        // Only the person's own words, never what the voice said back, and all of them: "don't" may be lost in the echo.
        if (spokenHangUp(heard.withoutEcho) && spokenHangUp(said)) {
            call.goodbye = true;
            this.append(call, "instructions", LIVE_COPY.goodbye, id);
            this.later(call, () => this.hangUp(call, "hung-up"), GOODBYE_MS);
            return;
        }
        if (call.approval && !call.approval.submitted) {
            await this.decide(call, heard.withoutEcho, id, said);
            return;
        }
        const question = call.question;
        if (question && !question.submitted && said) {
            question.submitted = true;
            call.activeDelegation = id;
            call.stats.answers += 1;
            const answer = heard.withoutEcho || said;
            const result = await this.respond(call, { auth: call.auth, threadId: call.state.threadId, requestId: question.requestId, behavior: "answer", message: answer, callId: call.state.callId }, id);
            if (!result || call.goodbye)
                return;
            if (result.ok) {
                this.append(call, "thinking", LIVE_COPY.answerPassed, id);
            }
            else if (call.question === question) {
                question.submitted = false;
                this.append(call, "commentary", LIVE_COPY.saveFailed(result.error.trim().slice(0, 200)), id);
            }
            return;
        }
        const decision = call.lastDecision;
        if (!said && decision && offsetMs <= decision.throughMs + DECISION_ECHO_MS) {
            this.append(call, "thinking", decision.copy, id);
            return;
        }
        if (!said) {
            call.stats.notHeard += 1;
            this.append(call, "instructions", LIVE_COPY.notHeard, id);
            return;
        }
        call.activeDelegation = id;
        call.stats.sentToBot += 1;
        this.append(call, "thinking", LIVE_COPY.working, id);
        try {
            const result = await this.deps.send({ auth: call.auth, botId: call.state.botId, threadId: call.state.threadId, text: said, callId: call.state.callId });
            if (result.kind === "queued")
                call.queuedIds.add(result.queueId);
            else if (result.kind === "steered") {
                call.pendingCall.add(result.messageId);
                call.claimNextTerminal = true;
            }
            else
                call.pendingCall.add(result.messageId);
        }
        catch (error) {
            if (error instanceof LiveCallSignedOutError) {
                this.endSignedOut(call, id);
                return;
            }
            const detail = error instanceof Error ? error.message.trim().slice(0, 200) : "";
            this.recordError(call, "send-failed");
            if (call.goodbye)
                return;
            this.append(call, "commentary", `The request could not be sent to ${call.botName}${detail ? `: ${detail}` : "."}`, id);
        }
    }
    async decide(call, said, delegationId, heard = said) {
        if (call.state.status !== "live" || call.goodbye)
            return;
        const open = call.approval;
        if (!open || open.submitted)
            return;
        const decision = spokenConsent(said, "live");
        if (!decision) {
            if (heard.trim())
                this.append(call, "instructions", LIVE_COPY.notClear, delegationId);
            return;
        }
        call.transcript.consumeAll();
        open.submitted = true;
        call.stats.approvals += 1;
        const copy = decision === "allow" ? LIVE_COPY.granted : LIVE_COPY.denied;
        call.lastDecision = { throughMs: call.heardThroughMs, copy };
        this.append(call, "commentary", copy, delegationId);
        const result = await this.respond(call, {
            auth: call.auth,
            threadId: call.state.threadId,
            requestId: open.requestId,
            behavior: decision,
            message: decision === "deny" ? LIVE_COPY.deniedMessage : undefined,
        }, delegationId);
        if (!result || call.goodbye)
            return;
        if (!result.ok && call.approval === open) {
            open.submitted = false;
            this.append(call, "commentary", LIVE_COPY.saveFailed(result.error.trim().slice(0, 200)), delegationId);
        }
    }
    scheduleConsentCheck(call) {
        if (call.consentTimer)
            this.clear(call, call.consentTimer);
        call.consentTimer = this.later(call, () => {
            call.consentTimer = null;
            if (!call.approval || call.approval.submitted)
                return;
            const pending = call.transcript.pending({ skipEcho: true });
            return spokenConsent(pending, "live") ? this.decide(call, pending, call.activeDelegation) : undefined;
        }, CONSENT_SETTLE_MS);
    }
    onStoreChange(call, change) {
        if (call.state.status === "ended")
            return;
        // Listeners run inside the store's write; do the work after it.
        if (change.type === "thread.deleted" && change.threadId === call.state.threadId)
            this.soon(call, () => this.hangUp(call, "deleted"));
        else if (change.type === "bot.deleted" && change.botId === call.state.botId)
            this.soon(call, () => this.hangUp(call, "deleted"));
        else if ((change.type === "message" || change.type === "message.patch") && change.threadId === call.state.threadId) {
            const { type, message } = change;
            this.soon(call, () => this.onMessage(call, type, message));
        }
        else if (change.type === "bot" && change.botId === call.state.botId)
            this.soon(call, () => this.onBotChange(call));
    }
    onBotChange(call) {
        if (call.state.status === "ended")
            return;
        const activity = this.deps.activity(call.state.botId, call.state.threadId);
        const was = call.lastActivity;
        call.lastActivity = activity;
        if (activity === "working")
            this.touch(call);
        if (activity === "working" && (was === "idle" || call.workStartedAt === null))
            this.beginWork(call);
        if (activity === "idle")
            call.workStartedAt = null;
        if (was === "idle" || activity !== "idle" || call.goodbye)
            return;
        this.forgetUnqueued(call);
        if (call.approval || call.question || call.queuedIds.size)
            return;
        if (!call.pendingCall.size && !call.claimNextTerminal)
            return;
        call.pendingCall.clear();
        call.claimNextTerminal = false;
        this.append(call, "commentary", LIVE_COPY.noAnswer);
    }
    forgetUnqueued(call) {
        for (const queueId of call.queuedIds) {
            if (!this.deps.queued(call.state.botId, call.state.threadId, queueId))
                call.queuedIds.delete(queueId);
        }
    }
    onMessage(call, type, message) {
        if (call.state.status === "ended")
            return;
        this.touch(call);
        if (type === "message")
            this.trackDrain(call, message);
        if (message.role === "user") {
            if (type !== "message" || message.kind !== "text")
                return;
            if (message.via === "call") {
                if (message.queueId)
                    call.queuedIds.delete(message.queueId);
                call.pendingCall.add(message.id);
            }
            else if (this.typedByCaller(call, message)) {
                call.typedTexts.set(message.id, message.text ?? "");
            }
            return;
        }
        if (call.goodbye)
            return;
        if (message.kind === "options") {
            this.onCard(call, message);
            return;
        }
        if (message.kind === "connector" || message.kind === "secret" || message.kind === "signin") {
            this.onSetupCard(call, message);
            return;
        }
        if (message.kind === "activity") {
            if (type !== "message" || !message.tool)
                return;
            if (call.workStartedAt !== null) {
                call.workSteps += 1;
                call.lastStep = liveStepLabel(message.tool);
                call.lastStepAt = this.now();
            }
            if (!this.mayNarrate(call))
                return;
            if (message.tool.spoken && this.now() - call.lastProgressAt > PROGRESS_INTERVAL_MS) {
                call.lastProgressAt = this.now();
                this.append(call, "thinking", LIVE_COPY.progress(message.tool.spoken));
            }
            return;
        }
        if (message.kind === "text" && message.turnTerminal && !call.spokenAnswers.has(message.id))
            this.onAnswer(call, message);
    }
    typedByCaller(call, message) {
        if (message.peerAsk || message.aside || message.relayed || message.via === "api" || !message.sendId)
            return false;
        return message.sender?.id === call.personKey;
    }
    trackDrain(call, message) {
        if (message.role !== "user" || message.kind !== "text" || !message.queueId) {
            call.drainBatch = null;
            return;
        }
        call.drainBatch ??= [];
        call.drainBatch.push(message.id);
        call.batches.set(message.id, call.drainBatch);
        if (call.batches.size > 200)
            call.batches.delete(call.batches.keys().next().value);
    }
    onAnswer(call, message) {
        const request = message.requestMessageId;
        const batch = request === undefined ? [] : call.batches.get(request) ?? [request];
        const forCall = batch.some((id) => call.pendingCall.has(id)) || call.claimNextTerminal || (request === undefined && call.pendingCall.size > 0);
        const typed = !forCall && request !== undefined ? call.typedTexts.get(request) : undefined;
        const settle = () => {
            for (const id of batch) {
                call.pendingCall.delete(id);
                call.typedTexts.delete(id);
                call.batches.delete(id);
            }
        };
        if (!forCall && typed === undefined)
            return;
        if (!forCall && !this.deps.settings().readTypedReplies) {
            // Off means nothing about a typed exchange reaches OpenAI, not even as context.
            settle();
            call.spokenAnswers.add(message.id);
            return;
        }
        const lead = !forCall && typed !== undefined ? [LIVE_COPY.typedAnswerLead(typed)] : [];
        const utterances = this.deps.speakable(message.text ?? "");
        if (!utterances.length)
            return;
        const chunks = commentaryChunks([...lead, ...utterances]);
        if (!chunks.length)
            return;
        call.spokenAnswers.add(message.id);
        settle();
        if (forCall) {
            if (request === undefined || call.claimNextTerminal)
                call.pendingCall.clear();
            call.claimNextTerminal = false;
        }
        call.stats.replies += 1;
        const delegationId = forCall ? call.activeDelegation : null;
        for (const chunk of chunks)
            this.append(call, "commentary", chunk, delegationId);
    }
    onCard(call, message) {
        const card = message.card;
        if (!card?.requestId)
            return;
        const kind = liveCardKind(card);
        if (!kind) {
            this.onCardSettled(call, card.requestId);
            return;
        }
        if (call.announced.has(card.requestId))
            return;
        if ((kind === "approval" || kind === "question") && (call.approval || call.question)) {
            if (!call.waitingCards.some((waiting) => waiting.card?.requestId === card.requestId))
                call.waitingCards.push(message);
            return;
        }
        call.announced.add(card.requestId);
        if (kind === "review") {
            this.append(call, "instructions", spokenReviewPrompt(card));
        }
        else if (kind === "approval") {
            call.approval = { requestId: card.requestId, messageId: message.id, submitted: false };
            call.transcript.consumeAll();
            this.append(call, "instructions", LIVE_COPY.permissionRequest(spokenApprovalPrompt(card)));
        }
        else {
            call.question = { requestId: card.requestId, messageId: message.id, submitted: false };
            call.transcript.consumeAll();
            this.append(call, "instructions", spokenQuestionPrompt(card));
        }
    }
    /** A credential must never be spoken into the call. */
    onSetupCard(call, message) {
        const { connector, secret, signIn } = message;
        const waiting = message.kind === "connector"
            ? Boolean(connector && connector.status !== "connected" && !connector.dismissed && !connector.resumed)
            : message.kind === "signin"
                ? Boolean(signIn && signInWaits(signIn))
                : Boolean(secret && !secret.provided && !secret.dismissed && !secret.superseded && !secret.resumed);
        const key = `${message.kind}:${message.id}`;
        if (!waiting || call.announced.has(key))
            return;
        call.announced.add(key);
        this.append(call, "instructions", connector ? spokenConnectorPrompt(connector.label)
            : signIn ? spokenSignInPrompt(signIn.site) : spokenSecretPrompt(secret?.label ?? ""));
    }
    onCardSettled(call, requestId) {
        call.waitingCards = call.waitingCards.filter((waiting) => waiting.card?.requestId !== requestId);
        const open = call.approval?.requestId === requestId ? call.approval : call.question?.requestId === requestId ? call.question : null;
        if (!open)
            return;
        if (call.approval === open)
            call.approval = null;
        else
            call.question = null;
        if (!open.submitted)
            this.append(call, "thinking", LIVE_COPY.answeredInChat, null);
        const next = call.waitingCards.shift();
        if (next)
            this.onCard(call, next);
    }
    beginWork(call) {
        const now = this.now();
        call.workStartedAt = now;
        call.workSteps = 0;
        call.lastStep = null;
        call.lastStepAt = now;
        call.lastStatusAt = now;
    }
    maybeStatus(call) {
        if (call.workStartedAt === null) {
            this.beginWork(call);
            return;
        }
        const now = this.now();
        if (now - call.lastStatusAt < STATUS_INTERVAL_MS)
            return;
        call.lastStatusAt = now;
        if (!this.mayNarrate(call))
            return;
        this.append(call, "thinking", LIVE_COPY.status(now - call.workStartedAt, call.workSteps, call.lastStep, now - call.lastStepAt), null);
    }
    mayNarrate(call) {
        return this.deps.settings().readTypedReplies || call.pendingCall.size > 0 || call.claimNextTerminal;
    }
    append(call, kind, content, delegationId = call.activeDelegation) {
        return this.command(call, { type: `session.${kind}.append`, delegation_id: delegationId, content: clampAppend(content) });
    }
    command(call, event) {
        const socket = call.socket;
        if (!socket || socket.readyState !== SOCKET_OPEN || call.state.status === "ended")
            return false;
        try {
            socket.send(JSON.stringify({ ...event, event_id: `omb_${++call.eventCounter}` }));
            return true;
        }
        catch {
            return false;
        }
    }
    emit(call) {
        try {
            this.deps.broadcast({ kind: "live.call", botId: call.state.botId, threadId: call.state.threadId, call: { ...call.state } });
        }
        catch {
            this.recordError(call, "broadcast");
        }
    }
    touch(call) {
        call.lastActivityAt = this.now();
    }
    later(call, fn, ms) {
        const timer = setTimeout(() => {
            call.timers.delete(timer);
            this.guarded(call, fn);
        }, ms);
        timer.unref?.();
        call.timers.add(timer);
        return timer;
    }
    soon(call, fn) {
        queueMicrotask(() => this.guarded(call, fn));
    }
    /** The server has no unhandled-rejection handler: a relay bug must cost a counter, never the process. */
    guarded(call, fn) {
        try {
            const result = fn();
            if (result instanceof Promise)
                result.catch(() => this.recordError(call, "internal"));
        }
        catch {
            this.recordError(call, "internal");
        }
    }
    async respond(call, input, delegationId) {
        try {
            return await this.deps.respond(input);
        }
        catch (error) {
            if (error instanceof LiveCallSignedOutError) {
                this.endSignedOut(call, delegationId);
                return null;
            }
            this.recordError(call, "respond-failed");
            return { ok: false, error: "" };
        }
    }
    endSignedOut(call, delegationId, why = LIVE_COPY.signedOut) {
        if (call.state.status === "ending" || call.state.status === "ended")
            return false;
        this.recordError(call, "signed-out");
        this.append(call, "commentary", why, delegationId);
        call.state.error = why;
        void this.hangUp(call, "signed-out");
        return true;
    }
    recordError(call, code) {
        if (call.stats.errors.length < MAX_ERRORS)
            call.stats.errors.push(code);
    }
    clear(call, timer) {
        clearTimeout(timer);
        call.timers.delete(timer);
    }
    now() {
        return this.deps.now?.() ?? Date.now();
    }
}
