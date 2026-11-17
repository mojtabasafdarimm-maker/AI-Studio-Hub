import { answeredByPerson } from "./cloud-lending.js";
/** Who spoke: whoever opened it, every person's line and every card a person answered is the owner's, and nothing came
 * in by webhook. What bots posted there (receipts, routine reports) does not count. With `desktopLines`, a line with no
 * sender (a conversation copied from the owner's desktop) is the owner's too. */
export function ownerSpokeOnly(thread, starters, ownerPerson, cardAnswerer, desktopLines = false) {
    const spoke = (line) => line.role !== "user" || (!line.peerAsk && (line.sender?.id ? ownerPerson(line.sender.id) : desktopLines));
    return starters.every((person) => person === undefined || ownerPerson(person)) && !thread.some((line) => line.webhookPost) &&
        thread.every((line) => spoke(line) && (!answeredByPerson(line.card) || ownerPerson(cardAnswerer(line.card))));
}
/** The conversation up to the card that made this routine, when only the owner spoke there and it still runs what that card showed. */
function madeInChat(routine, input, desktopLines) {
    if (!routine.sourceThreadId)
        return null;
    const thread = input.thread(routine.sourceThreadId);
    const made = thread.findIndex((line) => line.card?.routineRequest?.resultId === routine.id && line.card.routineRequest.operation.action === "create");
    if (made < 0 || thread[made].card?.answered !== "allow")
        return null;
    const shape = input.shape(routine.id), upTo = thread.slice(0, made + 1);
    return shape !== undefined && shape === input.cardShape(thread[made]) &&
        ownerSpokeOnly(upTo, input.starters(routine.sourceThreadId), input.ownerPerson, input.cardAnswerer, desktopLines) ? upTo : null;
}
/** Nobody's routines that a bot made in a conversation only the owner spoke in, and that still run exactly what that card showed;
 * `proven` when that conversation held no report of anyone else's routine before the card either. */
export function ownersRoutinesMadeInChat(input) {
    return input.routines.flatMap((routine) => {
        if (input.writer(routine.id) !== input.nobodyKey || input.recorded(routine.id))
            return [];
        const upTo = madeInChat(routine, input, false);
        return upTo ? [{ id: routine.id, proven: !upTo.some(input.reportFromOthers) }] : [];
    });
}
/** When a Cloud first becomes shared, the routines made while only its owner existed stay the owner's: those a bot made in a
 * conversation only the owner spoke in (copied desktop lines included) that no webhook drove. Any other is left to confinement. */
export function routinesKeptAtSharing(input) {
    return input.routines.filter((routine) => {
        const writer = input.writer(routine.id);
        return (writer === undefined || writer === input.nobodyKey) && routine.sourceThreadId !== undefined &&
            !input.outsideThread(routine.sourceThreadId) && madeInChat(routine, input, true) !== null;
    }).map((routine) => routine.id);
}
/** What a routine runs, for comparing against what a person or a card saw; never the moving schedule anchor. */
export function approvalShape(shape) {
    const schedule = shape.schedule && typeof shape.schedule === "object" ? { ...shape.schedule } : null;
    if (schedule)
        delete schedule.anchorAt;
    return JSON.stringify([shape.prompt ?? "", shape.botId ?? "", shape.runOn ?? "maus", schedule, shape.target ?? "bot", shape.groupId ?? null,
        (shape.attachments ?? []).map((attachment) => [attachment.id, attachment.path])]);
}
/** What a bot's create card showed, in approvalShape's form, its schedule read as the card's own `asSchedule` read it. */
export function createdShape(line, schedule) {
    const request = line.card?.routineRequest;
    if (request?.operation.action !== "create")
        return undefined;
    const definition = request.operation.routine;
    return approvalShape({ prompt: definition.instructions, botId: request.operation.forBot?.botId ?? request.botId, runOn: definition.runOn, schedule: schedule(definition.schedule, 0) });
}
