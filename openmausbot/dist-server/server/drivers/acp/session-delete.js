// Model discovery opens ACP sessions only to read their model lists. An agent that keeps every session (OpenCode
// 2.2.0 and 2.2.6 keep one even after session/close or a killed process) lists them in the person's history, so
// discovery deletes its own sessions whenever the agent offers session/delete.
/** True when the answer to initialize advertises session/delete. */
export function deletesAcpSessions(initialized) {
    const agent = initialized?.agentCapabilities;
    return Boolean(agent?.sessionCapabilities?.delete);
}
/** Sends session/delete for each id and answers the ids the agent confirmed. */
export async function deleteAcpSessions(request, sessionIds) {
    const ids = [...new Set(sessionIds)];
    const answers = await Promise.allSettled(ids.map((sessionId) => request("session/delete", { sessionId })));
    return ids.filter((_, index) => answers[index]?.status === "fulfilled");
}
