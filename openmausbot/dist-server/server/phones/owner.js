/** A person no owner test accepts: a bot's ask outside the user's work, a relayed line, a worker's answer, or a session
 * answer with no recorded person. Never a session's person key, which is a hash. */
export const NOT_THE_OWNER = "not-the-owner";
/** One desktop owner exists only where one person uses this server: never where sign-in lets several people in (each
 * admin would reach every admin's phones), and never where a request from this machine is a service, not the owner. */
export function desktopPhonesOffered(server) {
    return !server.sharedMembership && server.loopbackTrust !== "service";
}
/** Routines written before this desktop kept authorship records have none, so the owner's own brief or reminder would
 * count as someone else's words in every conversation it reports into. On the first start with records, where one person
 * uses this server and no other person holds a session here, those routines can only be the owner's: record them once.
 * The record is kept even when there is nothing to adopt, so a routine added later is never adopted by a later start. */
export function adoptExistingRoutines(input) {
    if (input.recordsExisted || !input.offered || input.otherPeople)
        return 0;
    for (const routine of input.routines)
        input.record(routine);
    input.persist();
    return input.routines.length;
}
/** The routine a report or run card speaks for; an outside event's run names its trigger, which is no routine. */
const routineOf = (line) => line.automation?.routineId ?? (line.kind === "routine.run" ? line.routineRun?.routineId : undefined);
export function desktopLendingTurn(base, deps) {
    let admins;
    const ownerPerson = (person) => person === undefined || (admins ??= deps.adminPersons()).has(person);
    // A bot's ask names no person, so only the work's origin can vouch for it, and only for this turn's own request: an
    // earlier ask in the conversation may have carried another chain's work, which nothing recorded.
    const vouched = deps.originIsUser() ? base.request?.messageId : undefined;
    // A relayed line names no person either, and nobody here vouches for it.
    const thread = base.thread.map((line) => (line.role === "user" && (line.relayed === true || (line.peerAsk && line.id !== vouched)) ? { ...line, peerAsk: undefined, sender: { id: NOT_THE_OWNER } } : line));
    return {
        ...base,
        thread,
        ownerPerson,
        cardAnswerer: (card) => {
            const by = card.answeredBy;
            if (!by)
                return base.cardAnswerer(card);
            if (by.kind === "loopback")
                return undefined;
            return by.kind === "session" && by.person ? by.person : NOT_THE_OWNER;
        },
        // Off a Cloud the work a conversation was opened with is vouched for by its origin, as a bot's ask is, not by who opened it.
        botOpened: false,
        reportsFromOthers: base.thread.some((line) => {
            if (line.webhookPost === true)
                return true;
            const routine = routineOf(line);
            return routine !== undefined && !deps.ownerWrote(routine);
        }),
        // Written comes from the harness's record of who wrote the routine (server/index.ts). Started: a schedule or a restart
        // starts it on its writer's behalf; by hand, only the owner's own start counts; a webhook never.
        routineRun: () => {
            const run = base.routineRun();
            return run && { ...run, ownerStarted: run.triggerSource === "manual" ? run.ownerStarted : run.triggerSource !== "webhook" };
        },
    };
}
