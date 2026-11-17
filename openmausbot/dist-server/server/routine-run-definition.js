import { cloneAttachments } from "./routine-attachments.js";
export function resolveRoutineResultsThread(routine, resolve, allocations, now, sourceThreadId = routine.sourceThreadId) {
    if (routine.target !== "bot" || !resolve)
        return routine.resultsThreadId;
    const destination = resolve({ ...routine, sourceThreadId }, false);
    const own = destination?.main ? undefined : destination?.threadId;
    if (own !== routine.resultsThreadId) {
        if (own)
            allocations.push({ botId: routine.botId, threadId: own });
        if (own)
            routine.resultsThreadId = own;
        else
            delete routine.resultsThreadId;
        routine.updatedAt = Math.max(now, routine.updatedAt + 1);
    }
    return destination?.threadId;
}
export function routineRunDefinition(routine) {
    return {
        routineName: routine.name,
        prompt: routine.prompt,
        durationMinutes: routine.durationMinutes,
        ...(routine.timeoutMinutes === undefined ? {} : { timeoutMinutes: routine.timeoutMinutes }),
        attachments: cloneAttachments(routine.attachments),
        target: routine.target,
        groupId: routine.groupId,
        botId: routine.botId,
        runOn: routine.runOn ?? "maus",
        access: routine.access,
        deliver: routine.deliver,
        sameConversation: routine.sameConversation ? true : undefined,
    };
}
