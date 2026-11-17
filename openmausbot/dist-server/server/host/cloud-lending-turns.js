// Which turns on a Cloud home may use the Mac lent to it, read from the harness's own records (server/cloud-lending.ts
// decides), and the plain words a turn that can't is told. A room member turn acts for the person's line that started
// its run, for that turn generation alone, while the run lasts.
import { answersOwnersLine, changedRoutineRefusalText, cloudHomeLendingRefusal, cloudHomeOwnTurnRefusal, cloudLendingRefusalText, handedOnForOwner, ON_THE_CARD, ONLY_THE_PERSON, teamLendingRefusal } from "../cloud-lending.js";
import { unstamped } from "../cloud-owner-lines.js";
import { deviceWord } from "../lent-computers.js";
export function createCloudLendingTurns(deps) {
    const { store } = deps;
    /** Each room member turn's generation, while its run lasts: the harness's own record of which line started it. */
    const roomTurnOperations = new Map();
    /** A room member turn's request: the line its run answers, for this generation alone, stopped once the run is. */
    function roomTurnRequest(generation) {
        const operation = roomTurnOperations.get(generation);
        return operation?.requestMessageId ? { messageId: operation.requestMessageId, generations: new Set([generation]), stopped: operation.cancelled } : undefined;
    }
    function cloudLendingTurn(capability) {
        return {
            request: store.groupByThread(capability.threadId) ? roomTurnRequest(capability.generation) : deps.directRequest(capability.threadId),
            generation: capability.generation,
            thread: store.messagesFor(capability.threadId),
            starters: cloudThreadStarters(capability.threadId),
            reportsFromOthers: store.messagesFor(capability.threadId).some(cloudReportFromOthers),
            botOpened: cloudBotOpened(capability.threadId),
            openedForOwner: openedForOwner(capability.threadId),
            ownerPerson: deps.ownerPerson,
            cardAnswerer: deps.cardAnswerer,
            routineRun: () => {
                const run = deps.activeRoutineRun(capability.threadId);
                if (!run || run.threadId !== capability.threadId || store.taskByThread(capability.botId, capability.threadId)?.routineRunId !== run.id)
                    return null;
                return {
                    triggerSource: run.triggerSource ?? (run.manual ? "manual" : "schedule"),
                    ownerStarted: deps.ownerStartedRun(run.id),
                    ownerAuthored: deps.routineRunIsOwners(run, capability.botId, capability.threadId),
                };
            },
        };
    }
    /** Whether this conversation may reach the lent computer: what came in from outside before the owner allowed this line of
     * theirs on a card (a webhook's or another's routine's post, the work a bot opened it with) doesn't count against it, and
     * whatever comes in after does. The same judge decides; every other gate, and what feeds a bot's memory, reads the
     * conversation as it is. */
    function conversationGate(capability, judge = cloudHomeLendingRefusal) {
        const turn = cloudLendingTurn(capability);
        const allowed = deps.lifts?.()?.outsideAllowed(capability.threadId, turn.request?.messageId);
        return judge(!allowed ? turn : {
            ...turn,
            reportsFromOthers: store.messagesFor(capability.threadId).slice(allowed.index + 1).some(cloudReportFromOthers),
            botOpened: turn.botOpened === true && deps.handedSince?.(capability.threadId, allowed.at) !== false,
        });
    }
    /** Every gate, so what a turn hears never names a way out another gate closes. */
    function gates(capability) {
        return { conversation: conversationGate(capability), memoryChanged: deps.memoryChangedBySomeoneElse(capability.botId) };
    }
    /** What a card may lift for this turn, or null: only for the owner's own line, and never another person's words. */
    function liftable(capability, { conversation, memoryChanged }) {
        const lifts = deps.lifts?.();
        if (!lifts || (!conversation && !memoryChanged))
            return null;
        const turn = cloudLendingTurn(capability);
        const requestMessageId = turn.request?.messageId;
        if (!requestMessageId || !answersOwnersLine(turn))
            return null;
        if (conversation && cloudHomeLendingRefusal({ ...turn, reportsFromOthers: false, botOpened: false }) !== null)
            return null;
        return lifts.declined(capability.threadId, requestMessageId) ? null
            : { requestMessageId, memoryChanged, outside: conversation !== null, botOpened: conversation !== null && turn.botOpened === true };
    }
    /** Why this turn can't use the lent computer, in plain words for the person; null when it can or nothing is lent. */
    function cloudLendingRefusalNotice(capability) {
        const shut = gates(capability);
        const { conversation, memoryChanged } = shut;
        if (!conversation && !memoryChanged)
            return null;
        if (deps.team)
            return teamLendingRefusal(deps.team);
        const changed = conversation === "not-owner" && !memoryChanged ? changedRoutine(capability) : undefined;
        if (changed !== undefined)
            return changedRoutineRefusalText(changed, deviceWord(deps.lentPlatform()));
        const thread = store.messagesFor(capability.threadId);
        const others = thread.filter((line) => line.role === "user" && !deps.ownerPerson(line.peerAsk ? undefined : line.sender?.id));
        return cloudLendingRefusalText(conversation ?? "memory-changed", { room: Boolean(store.groupByThread(capability.threadId)), fromBefore: others.length > 0 && others.every(unstamped),
            botOpened: others.length === 0 && cloudBotOpened(capability.threadId), outside: others.length === 0 && thread.some(cloudReportFromOthers), memoryChanged, onCard: liftable(capability, shut) !== null, device: deviceWord(deps.lentPlatform()) });
    }
    /** What a refused call answers: the notice, then that the bot should stop. Where the owner can lift it, the card goes up here. */
    function cloudLendingRefusalForBot(capability) {
        const notice = cloudLendingRefusalNotice(capability);
        if (!notice || deps.team)
            return notice;
        const lift = liftable(capability, gates(capability));
        if (lift)
            deps.lifts?.()?.raise({ botId: capability.botId, threadId: capability.threadId, ...lift });
        return `${notice} ${lift ? ON_THE_CARD : ONLY_THE_PERSON}`;
    }
    function cloudLendingRefusal(capability) {
        const { conversation, memoryChanged } = gates(capability);
        if (memoryChanged)
            return conversation ? "memory-changed-here" : "memory-changed";
        return conversation;
    }
    /** What the owner's phones take: every gate, with work handed on for the owner not counting as the owner's. */
    function cloudOwnTurnRefusal(capability) {
        return deps.memoryChangedBySomeoneElse(capability.botId) ? "memory-changed" : conversationGate(capability, cloudHomeOwnTurnRefusal);
    }
    /** The name of the routine this turn runs, when the run is refused only because the routine is no longer the owner's
     * (someone else changed it); a webhook's or another app's run, or one somebody else started by hand, is not this. */
    function changedRoutine(capability) {
        const turn = cloudLendingTurn(capability);
        const automation = turn.request?.automation;
        if (automation === undefined || automation === "webhook" || automation === "api")
            return undefined;
        const run = turn.routineRun();
        if (!run || run.ownerAuthored || run.triggerSource === "webhook" || run.triggerSource === "api" || (run.triggerSource === "manual" && !run.ownerStarted))
            return undefined;
        const routineId = deps.activeRoutineRun(capability.threadId)?.routineId;
        return deps.routines()?.listRoutines().find((routine) => routine.id === routineId)?.name;
    }
    /** A bot opened this conversation (a hand-off's work thread, one a bot started itself, a Chief's notices). */
    function cloudBotOpened(threadId) {
        const bot = store.botByThread(threadId);
        return Boolean(bot && store.taskByThread(bot.id, threadId)?.openedBy);
    }
    /** Opened by a turn that could itself use the lent computer, with nothing handed in since but work from turns like it. */
    function openedForOwner(threadId) {
        const bot = store.botByThread(threadId);
        return Boolean(bot && store.taskByThread(bot.id, threadId)?.openedBy?.forOwner);
    }
    /** Security invariant: whether what this turn hands on now may go on using the lent computer. Only the owner's own
     * one-on-one line, in a conversation every gate allows without a card, or work already handed on that way: never a
     * routine's or a webhook's run, a room, a turn a card let through, or a bot whose memory is locked. It may never reach
     * further than this turn itself can. */
    function handsOnLending(capability) {
        if (!deps.cloudHome || deps.team || store.groupByThread(capability.threadId))
            return false;
        const turn = cloudLendingTurn(capability);
        return (answersOwnersLine(turn) || handedOnForOwner(turn)) && cloudHomeLendingRefusal(turn) === null && !deps.memoryChangedBySomeoneElse(capability.botId);
    }
    /** Work handed into this conversation by a turn that could not hand on the lent computer: it no longer counts as the
     * owner's, whatever is handed in later. */
    function handedInUnproven(threadId) {
        const bot = store.botByThread(threadId);
        const task = bot && store.taskByThread(bot.id, threadId);
        if (!bot || !task?.openedBy?.forOwner)
            return;
        const { forOwner: _cleared, ...openedBy } = task.openedBy;
        store.setTaskOpenedBy(bot.id, threadId, openedBy);
    }
    function cloudThreadStarters(threadId) {
        const room = store.groupByThread(threadId);
        return [deps.threadStarter(threadId), ...(room && room.threadId !== threadId ? [deps.threadStarter(room.threadId)] : [])];
    }
    /** On a Cloud home a turn that may use the lent Mac reads only the owner's own conversations. */
    function cloudLendingView(capability) {
        return deps.cloudHome && conversationGate(capability) === null;
    }
    function cloudReportFromOthers(line) {
        if (line.webhookPost)
            return true;
        const routineId = line.automation?.routineId ?? (line.kind === "routine.run" ? line.routineRun?.routineId : undefined);
        if (!routineId)
            return false;
        // An outside event's run belongs to no routine, so its words are never the owner's.
        const routine = deps.routines()?.listRoutines().find((candidate) => candidate.id === routineId);
        return !routine || deps.routineAuthors?.authored(routine.id, routine) !== true;
    }
    return {
        cloudLendingTurn, cloudLendingRefusalNotice, cloudLendingRefusalForBot, cloudLendingRefusal, cloudThreadStarters, cloudBotOpened, cloudLendingView, cloudReportFromOthers, handsOnLending, handedInUnproven, cloudOwnTurnRefusal,
        /** A room member turn of this run started: its generation acts for the line the run answers. */
        roomTurnStarted(generation, run) { roomTurnOperations.set(generation, run); },
        /** The run ended: none of its turn generations act for anyone any more. */
        roomTurnEnded(run) { for (const [generation, owner] of roomTurnOperations)
            if (owner === run)
                roomTurnOperations.delete(generation); },
        /** The run a room member turn generation belongs to, while it lasts (server/host/acting-person.ts reads whom it acts for). */
        roomRun: (generation) => roomTurnOperations.get(generation),
    };
}
