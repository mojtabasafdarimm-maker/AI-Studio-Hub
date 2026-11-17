import { recordCloudSharing, settleCloudOwnership } from "./cloud-owner.js";
import { approvalShape, createdShape, ownersRoutinesMadeInChat, routinesKeptAtSharing } from "./cloud-routine-level.js";
import { CLOUD_OUTSIDE_KEY, cloudShared } from "./cloud-sharing.js";
export function settleCloudHome(deps) {
    const { authors, store } = deps;
    const routineById = (id) => deps.routines()?.listRoutines().find((routine) => routine.id === id);
    const shapeOf = (id) => { const routine = routineById(id); return routine ? approvalShape(routine) : undefined; };
    const thread = (threadId) => store.botByThread(threadId) || store.groupByThread(threadId) ? store.messagesFor(threadId) : [];
    const webhookRuns = new Set((deps.routines()?.listRuns() ?? []).flatMap((run) => run.triggerSource === "webhook" && run.threadId ? [run.threadId] : []));
    const outsideThread = (threadId, lines = thread(threadId)) => webhookRuns.has(threadId) || lines.some((line) => line.webhookPost || line.via === "api");
    /** Every conversation once: who wrote and answered, the owner's card approvals, and the routines a webhook-driven conversation made or changed. */
    const search = () => {
        const senders = new Set(), answerers = new Set(), outside = new Set();
        const approvals = [];
        for (const threadId of new Set([...store.bots.flatMap((bot) => store.tasks(bot.id).map((task) => task.threadId)), ...store.groups.map((group) => group.threadId)])) {
            const lines = store.messagesFor(threadId);
            const driven = outsideThread(threadId, lines);
            for (const line of lines) {
                const sender = deps.linePersonKey(line);
                if (sender)
                    senders.add(sender);
                const answerer = line.card?.answeredBy?.kind === "session" ? line.card.answeredBy.person : undefined;
                if (answerer)
                    answerers.add(answerer);
                const request = line.card?.answered === "allow" ? line.card.routineRequest : undefined;
                const created = request?.resultId ? createdShape(line, deps.asSchedule) : undefined;
                if (answerer && created)
                    approvals.push([request.resultId, answerer, created]);
                const changed = request?.operation.action === "create" ? request.resultId : request?.operation.action === "update" ? request.operation.routineId : undefined;
                if (driven && changed)
                    outside.add(changed);
            }
        }
        return { senders, answerers, approvals, outside };
    };
    let searched;
    const ownership = settleCloudOwnership({
        file: deps.file, machineId: deps.machineId, ownerKey: deps.ownerKey, nobodyKey: deps.nobodyKey, outsideKey: CLOUD_OUTSIDE_KEY,
        sessions: deps.sessions, personKey: deps.personKey, starters: deps.starters, writers: authors,
        routines: {
            ids: () => (deps.routines()?.listRoutines() ?? []).map((routine) => routine.id),
            writer: (id) => authors.writer(id),
            fingerprinted: (id) => { const routine = routineById(id); return Boolean(routine) && authors.authored(id, routine); },
            resultsOpener: (id) => { const results = routineById(id)?.resultsThreadId; return results ? deps.starters.get(results) : undefined; },
            shape: shapeOf,
            name: (id, person) => authors.wrote(id, person),
            pause: (ids) => { for (const id of ids)
                deps.routines()?.update(id, { enabled: false }); },
        },
        unpin: (threadIds) => { for (const threadId of threadIds)
            store.unpinTaskCwd(threadId); },
        lines: () => (searched ??= search()),
        ...(deps.restoredNow ? { restoredNow: deps.restoredNow } : {}),
        ...(deps.lastRestore ? { lastRestore: deps.lastRestore } : {}),
        log: deps.log,
    });
    deps.settled(ownership);
    // Once per machine, and after a restore, while the Cloud is not known to be shared.
    const found = ownership.sharedSince === undefined && (!ownership.soloBefore || ownership.restoring) ? (searched ??= search()) : undefined;
    for (const id of found?.outside ?? [])
        if (authors.writer(id) !== deps.ownerKey && authors.writer(id) !== CLOUD_OUTSIDE_KEY)
            authors.wrote(id, CLOUD_OUTSIDE_KEY);
    const level = {
        routines: deps.routines()?.listRoutines() ?? [], nobodyKey: deps.nobodyKey, writer: authors.writer, recorded: authors.recorded, thread,
        starters: deps.threadStarters, ownerPerson: deps.provenPerson, reportFromOthers: deps.reportFromOthers, cardAnswerer: deps.cardAnswerer,
        shape: shapeOf, cardShape: (line) => createdShape(line, deps.asSchedule),
    };
    for (const { id, proven } of ownersRoutinesMadeInChat(level)) {
        if (proven)
            deps.ownersRoutine(id);
        else
            authors.wrote(id, deps.ownerKey);
    }
    const record = { file: deps.file, machineId: deps.machineId, log: deps.log };
    const keep = () => {
        for (const id of routinesKeptAtSharing({ ...level, routines: deps.routines()?.listRoutines() ?? [], outsideThread: (threadId) => outsideThread(threadId) })) {
            authors.wrote(id, deps.ownerKey);
        }
    };
    let solo = !cloudShared({ ownership, ownersOrNone: deps.ownersOrNone, recorded: [...deps.starters.people(), ...authors.people()],
        ...(found ? { seen: [...found.senders, ...found.answerers] } : {}) });
    if (!solo && ownership.sharedSince === undefined) {
        // Someone but the owner first appeared since a start that found only the owner: what exists now was made by the owner alone.
        if (ownership.soloBefore && !ownership.restoring)
            keep();
        recordCloudSharing(record, { sharedSince: Date.now() });
        deps.log("cloud home: someone besides the owner has used this Cloud, so what they or a webhook start runs confined from now on");
    }
    else if (solo && found) {
        recordCloudSharing(record, { peopleChecked: true });
    }
    return {
        solo: () => solo,
        share: () => {
            if (!solo)
                return;
            keep();
            recordCloudSharing(record, { sharedSince: Date.now() });
            solo = false;
        },
    };
}
